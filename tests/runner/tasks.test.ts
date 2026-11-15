/** Task registry (runner/tasks.ts): validation, lookup, banned terms, limits. Temp registries only. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPEC_DIR } from '../../runner/env.js';
import { brownfieldDef, makeTaskRepo } from './task-fixtures.js';
import { allBannedTerms, allReferenceDiffPaths, getTask, listTasks, loadTaskFromDir, taskLimits, TaskError, validateTaskDefinition } from '../../runner/tasks.js';

describe('task registry', () => {
  let repo: { root: string; tasksDir: string };
  beforeEach(() => {
    repo = makeTaskRepo([brownfieldDef('mastodon-a'), brownfieldDef('mastodon-b', { bannedTerms: ['custom_filter', 'CustomFilter'], browserAgent: 'required', minPassRate: 1 })]);
  });
  afterEach(() => rmSync(repo.root, { recursive: true, force: true }));

  it('the real registry has todo with the original paths and builtin code paths', () => {
    const t = getTask('todo');
    expect(t.kind).toBe('greenfield');
    expect(t.specPath).toBe(SPEC_DIR);
    expect(t.promptPath).toBeNull();
    expect(t.builderPath).toBeNull();
    expect(t.evaluatorPath).toBeNull();
    expect(t.workspace.snapshot).toBe('tree');
    expect(t.minPassRate).toBe(1);
    expect(t.browserAgent).toBe('required');
    expect(t.bannedTerms).toEqual([]);
    expect(t.limits).toBeUndefined();
  });

  it('loads and resolves a valid brownfield task', () => {
    const tasks = listTasks({ tasksDir: repo.tasksDir, repoRoot: repo.root, fresh: true });
    expect(tasks.map((t) => t.id)).toEqual(['mastodon-a', 'mastodon-b']);
    const a = getTask('mastodon-a', { tasksDir: repo.tasksDir, repoRoot: repo.root });
    expect(a.promptPath).toBe(join(repo.tasksDir, 'mastodon-a', 'prompt.md'));
    expect(a.specPath).toBe(join(repo.tasksDir, 'mastodon-a', 'spec'));
    expect(a.evaluatorPath).toBe(join(repo.root, 'evaluator/tasks/mastodon-a/index.ts'));
    expect(a.sandbox.extraVolumes).toEqual(['/data']);
  });

  it('unknown ids fail with the list of available tasks', () => {
    expect(() => getTask('nope', { tasksDir: repo.tasksDir, repoRoot: repo.root })).toThrow(/unknown task; available: mastodon-a, mastodon-b/);
    expect(() => getTask('../etc', { tasksDir: repo.tasksDir })).toThrow(TaskError);
  });

  it('bannedTerms: union over every non-todo task; referenceDiffs only when the file exists', () => {
    expect(allBannedTerms({ tasksDir: repo.tasksDir, repoRoot: repo.root }).sort()).toEqual(['CustomFilter', 'bookmark', 'custom_filter'].sort());
    expect(allReferenceDiffPaths({ tasksDir: repo.tasksDir, repoRoot: repo.root })).toEqual([]);
    mkdirSync(join(repo.root, 'evaluator/tasks/mastodon-a'), { recursive: true });
    writeFileSync(join(repo.root, 'evaluator/tasks/mastodon-a/reference.diff'), 'diff --git a/x b/x\n');
    expect(allReferenceDiffPaths({ tasksDir: repo.tasksDir, repoRoot: repo.root })).toEqual([join(repo.root, 'evaluator/tasks/mastodon-a/reference.diff')]);
  });

  it.each([
    ['id differs from dir', { id: 'mastodon-z' }, /must equal the directory name/],
    ['unknown field', { color: 'red' }, /unknown field 'color'/],
    ['bad kind', { kind: 'bluefield' }, /'kind'/],
    ['builtin outside todo', { promptFile: 'builtin:todo' }, /may not be builtin:todo/],
    ['builtin evaluator outside todo', { evaluator: 'builtin:todo' }, /must be under evaluator\//],
    ['evaluator outside evaluator/', { evaluator: 'runner/run.ts' }, /must be under evaluator\//],
    ['path escape', { image: { builder: '../outside.ts' } }, /without '\.\.'/],
    ['workspace path', { workspace: { path: '/app', snapshot: 'tree' } }, /workspace.path/],
    ['snapshot mode', { workspace: { path: '/workspace', snapshot: 'zip' } }, /snapshot/],
    ['reserved volume', { sandbox: { cpus: 2, memory: '2g', pidsLimit: 512, extraVolumes: ['/workspace'] } }, /reserved by the runner/],
    ['reserved tmpfs', { sandbox: { cpus: 2, memory: '2g', pidsLimit: 512, extraTmpfs: ['/opt/frugal/docs:rw'] } }, /reserved by the runner/],
    ['bad tmpfs opts', { sandbox: { cpus: 2, memory: '2g', pidsLimit: 512, extraTmpfs: ['/run/x:rw;rm -rf /'] } }, /invalid entry/],
    ['memory format', { sandbox: { cpus: 2, memory: '2GB', pidsLimit: 512 } }, /sandbox.memory/],
    ['minPassRate 0', { minPassRate: 0 }, /minPassRate/],
    ['minPassRate > 1', { minPassRate: 1.5 }, /minPassRate/],
    ['limits field', { limits: { maxCost: 3 } }, /unknown field 'limits.maxCost'/],
    ['limits value', { limits: { maxRuntimeSec: -1 } }, /positive integer/],
    ['bannedTerms type', { bannedTerms: [''] }, /bannedTerms/],
    ['referenceDiffs outside evaluator', { referenceDiffs: ['benchmark/tasks/x.diff'] }, /must be under evaluator\//],
    ['browserAgent', { browserAgent: 'sometimes' }, /browserAgent/],
    ['shmSize format', { sandbox: { cpus: 2, memory: '2g', pidsLimit: 512, shmSize: '1 GB' } }, /shmSize/],
  ])('rejects: %s', (_name, patch, re) => {
    expect(() => validateTaskDefinition(brownfieldDef('mastodon-a', patch as Record<string, unknown>), 'mastodon-a')).toThrow(re);
  });

  it('rejects a missing prompt file or a spec dir inside evaluator/', () => {
    const r = makeTaskRepo([brownfieldDef('mastodon-c', { promptFile: 'missing.md' })]);
    try {
      expect(() => loadTaskFromDir(join(r.tasksDir, 'mastodon-c'), r.root)).toThrow(/promptFile missing.md does not exist/);
      writeFileSync(join(r.tasksDir, 'mastodon-c', 'task.json'), JSON.stringify(brownfieldDef('mastodon-c', { specDir: '../../../evaluator' })));
      mkdirSync(join(r.root, 'evaluator'), { recursive: true });
      expect(() => loadTaskFromDir(join(r.tasksDir, 'mastodon-c'), r.root)).toThrow(/does not exist|evaluator/);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it('taskLimits: task fields replace the config limits, absent fields keep them', () => {
    const base = { maxTotalTokens: 3_000_000, maxModelCalls: 150, maxRuntimeSec: 2400 };
    expect(taskLimits(base, null)).toEqual(base);
    expect(taskLimits(base, { limits: { maxRuntimeSec: 3600, maxModelCalls: 400 } })).toEqual({ maxTotalTokens: 3_000_000, maxModelCalls: 400, maxRuntimeSec: 3600 });
  });
});
