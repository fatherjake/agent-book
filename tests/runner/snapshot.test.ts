/**
 * git-diff snapshots and task-driven coding runs with a FAKE sandbox and the MOCK provider (no Docker,
 * no models). Nothing here is a real measurement.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../runner/config.js';
import { MockProvider } from '../../runner/providers/mock.js';
import { runCodingAgent, TASK_SERVICES_START, taskSandboxOptions } from '../../runner/run.js';
import { CONTAINER_PATCH_FILE, gitDiffCommand, patchAddedLines, patchFiles, snapshotGitDiff } from '../../runner/snapshot.js';
import { getTask, loadTaskFromDir, type Task } from '../../runner/tasks.js';
import { FakeSandbox } from './fake-sandbox.js';
import { brownfieldDef, makeTaskRepo } from './task-fixtures.js';

const SHA = 'a'.repeat(40);
const PATCH = `diff --git a/app/models/widget.rb b/app/models/widget.rb
index 1111111..2222222 100644
--- a/app/models/widget.rb
+++ b/app/models/widget.rb
@@ -1,2 +1,3 @@
 class Widget
+  has_many :pins
 end
diff --git a/db/migrate/1_create_pins.rb b/db/migrate/1_create_pins.rb
new file mode 100644
--- /dev/null
+++ b/db/migrate/1_create_pins.rb
@@ -0,0 +1 @@
+class CreatePins < ActiveRecord::Migration[5.2]; end
`;

/** Fake sandbox that behaves like the brownfield container for git commands. */
function gitSandbox(patch = PATCH): FakeSandbox {
  const sb = new FakeSandbox();
  sb.onExec = (cmd) => {
    if (cmd === 'git -C /workspace rev-parse HEAD') return { stdout: `${SHA}\n` };
    if (cmd.includes('git diff --cached --binary')) {
      sb.files.set(CONTAINER_PATCH_FILE, Buffer.from(patch, 'utf8'));
      return { stdout: '' };
    }
    return undefined;
  };
  return sb;
}

describe('git-diff snapshot helpers', () => {
  it('stages everything except generated/dependency dirs and diffs against the checkpoint', () => {
    const cmd = gitDiffCommand(SHA);
    expect(cmd).toContain('git add -A -- .');
    expect(cmd).toContain(`git diff --cached --binary --no-color --no-ext-diff ${SHA} -- .`);
    for (const ex of ['log', 'tmp', 'node_modules', 'vendor', 'public/packs*']) expect(cmd).toContain(`':(exclude)${ex}'`);
    expect(cmd).toContain(`> ${CONTAINER_PATCH_FILE}`);
    expect(() => gitDiffCommand('HEAD; rm -rf /')).toThrow(/invalid checkpoint/);
  });

  it('parses touched files and added lines', () => {
    expect(patchFiles(PATCH)).toEqual(['app/models/widget.rb', 'db/migrate/1_create_pins.rb']);
    expect(patchAddedLines(PATCH)).toEqual([
      { path: 'app/models/widget.rb', text: '  has_many :pins' },
      { path: 'db/migrate/1_create_pins.rb', text: 'class CreatePins < ActiveRecord::Migration[5.2]; end' },
    ]);
  });

  it('copies the patch out uncapped and fails loudly on git errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frugal-snap-'));
    try {
      const out = join(dir, 'runs', 'r1', 'workspace.patch');
      const s = await snapshotGitDiff(gitSandbox(), SHA, out);
      expect(readFileSync(out, 'utf8')).toBe(PATCH);
      expect(s).toEqual({ bytes: Buffer.byteLength(PATCH), files: ['app/models/widget.rb', 'db/migrate/1_create_pins.rb'] });
      const bad = new FakeSandbox();
      bad.onExec = () => ({ exitCode: 128, stderr: 'fatal: not a git repository' });
      await expect(snapshotGitDiff(bad, SHA, out)).rejects.toThrow(/not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('task-driven coding run (fake sandbox, mock provider)', () => {
  let repo: { root: string; tasksDir: string };
  let task: Task;
  let resultsDir: string;
  beforeEach(() => {
    repo = makeTaskRepo([
      brownfieldDef('mastodon-x', {
        limits: { maxRuntimeSec: 3600, maxModelCalls: 400 },
        sandbox: { cpus: 4, memory: '6g', pidsLimit: 2048, extraVolumes: ['/data'], extraTmpfs: ['/run/postgresql:rw,nosuid,size=1m,uid=1000'], shmSize: '512m' },
      }),
    ]);
    task = loadTaskFromDir(join(repo.tasksDir, 'mastodon-x'), repo.root);
    resultsDir = mkdtempSync(join(tmpdir(), 'frugal-res-'));
  });
  afterEach(() => {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(resultsDir, { recursive: true, force: true });
  });

  it('git-diff task: task sandbox options + services hook, checkpoint, workspace.patch, taskId everywhere', async () => {
    const sb = gitSandbox();
    let factoryArgs: Parameters<NonNullable<Parameters<typeof runCodingAgent>[0]['sandboxFactory']>>[0] | undefined;
    const r = await runCodingAgent({
      config: { ...loadConfig('baseline-api'), provider: 'mock' },
      seed: 1,
      provider: new MockProvider(),
      resultsDir,
      image: { image: 'fake-task:1', imageId: 'sha256:t', starterHash: 'th' },
      task,
      sandboxFactory: async (a) => {
        factoryArgs = a;
        return sb;
      },
    });
    expect(r.status).toBe('completed');
    expect(r.taskId).toBe('mastodon-x');
    // Task drives spec dir, sandbox resources, extra mounts and the services hook.
    expect(factoryArgs!.specDir).toBe(task.specPath);
    expect(factoryArgs!.sandbox).toEqual({
      cpus: 4,
      memory: '6g',
      pidsLimit: 2048,
      extraVolumes: ['/data'],
      shmSize: '512m',
      extraTmpfs: ['/run/postgresql:rw,nosuid,size=1m,uid=1000'],
      startHook: { command: TASK_SERVICES_START, timeoutSec: 300 },
    });
    // Limits: the task's ceilings replace the config's (api baseline: 150 calls / 1800 s style values).
    expect(r.effectiveLimits!.maxRuntimeSec).toBe(3600);
    expect(r.effectiveLimits!.maxModelCalls).toBe(400);
    // Snapshot: no tree copy, a patch against the checkpoint recorded at start.
    expect(sb.copiedOut).toEqual([]);
    expect(sb.commands[0]).toBe('git -C /workspace rev-parse HEAD');
    expect(sb.commands.some((c) => c.includes(`--binary --no-color --no-ext-diff ${SHA}`))).toBe(true);
    const runDir = join(resultsDir, 'runs', r.runId);
    expect(readFileSync(join(runDir, 'workspace.patch'), 'utf8')).toBe(PATCH);
    expect(r.artifacts.workspacePatch!.endsWith(`runs/${r.runId}/workspace.patch`)).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).taskId).toBe('mastodon-x');
    for (const line of readFileSync(join(runDir, 'usage.jsonl'), 'utf8').trim().split('\n')) expect(JSON.parse(line).taskId).toBe('mastodon-x');
    expect(sb.destroyed).toBe(true);
  });

  it('a failing checkpoint read is an infra error and the sandbox is still destroyed', async () => {
    const sb = new FakeSandbox();
    sb.onExec = (cmd) => (cmd.startsWith('git -C /workspace rev-parse') ? { exitCode: 128, stderr: 'fatal: not a git repository' } : undefined);
    const r = await runCodingAgent({
      config: { ...loadConfig('baseline-api'), provider: 'mock' },
      seed: 1,
      provider: new MockProvider(),
      resultsDir,
      image: { image: 'fake-task:1', imageId: 'sha256:t', starterHash: 'th' },
      task,
      sandboxFactory: async () => sb,
    });
    expect(r.status).toBe('infra_error');
    expect(r.failureReason).toMatch(/checkpoint commit/);
    expect(sb.destroyed).toBe(true);
    expect(existsSync(join(resultsDir, 'runs', r.runId, 'workspace.patch'))).toBe(false);
  });

  it('todo is unchanged: tree snapshot, default sandbox options, no services hook, taskId todo', async () => {
    const specDir = mkdtempSync(join(tmpdir(), 'spec-'));
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'requirements.md'), '# Reqs');
    const sb = new FakeSandbox();
    let opts: unknown;
    const r = await runCodingAgent({
      config: { ...loadConfig('baseline-api'), provider: 'mock' },
      seed: 1,
      provider: new MockProvider(),
      resultsDir,
      specDir,
      image: { image: 'fake:1', imageId: 'sha256:img', starterHash: 'abc' },
      sandboxFactory: async (a) => {
        opts = a.sandbox;
        return sb;
      },
    });
    expect(r.status).toBe('completed');
    expect(r.taskId).toBe('todo');
    expect(opts).toEqual({});
    expect(taskSandboxOptions(getTask('todo'))).toEqual({});
    expect(sb.copiedOut[0].from).toBe('/workspace');
    expect(r.artifacts.workspacePatch).toBeUndefined();
    expect(r.effectiveLimits).toEqual(loadConfig('baseline-api').limits);
    rmSync(specDir, { recursive: true, force: true });
  });
});
