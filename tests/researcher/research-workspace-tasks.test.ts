/**
 * Research workspace on a brownfield dev task (FAKE runs / MOCK data only): only the dev task's
 * experiments, runs and spec; nothing of the holdout task (its name, prompt, spec, runs, checks or
 * transcripts) ever reaches the workspace or the digest.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHistoryDigest } from '../../researcher/history.js';
import { readConfigFiles } from '../../researcher/optimizer.js';
import { buildResearchWorkspace, hiddenTaskMarkers, type ProfileFns } from '../../researcher/research-workspace.js';
import { researchSandboxOptions } from '../../researcher/research-agent-claude-code.js';
import { openDb, type Db } from '../../storage/db.js';
import { fakeCoding, fakeEval, makeConfigsRoot, makeTmp, rmTmp } from './helpers.js';

process.env.FRUGAL_QUIET = '1';

const fakeProfile: ProfileFns = { buildSessionProfile: () => ({ mock: true }), renderProfileMarkdown: () => '# MOCK profile\n' };

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

const HOLDOUT_TITLE = 'Keyword and phrase muting (hidden holdout)';
const HOLDOUT_PROMPT = 'HOLDOUT PROMPT: implement muting of statuses that match user phrases';

describe('research workspace for a brownfield dev task (MOCK data)', () => {
  let dir: string;
  let configs: string;
  let results: string;
  let tasksRoot: string;
  let db: Db;

  const tasks: Record<string, { id: string; title: string; kind: string; specPath: string; dir: string }> = {};
  const getTask = (id: string) => {
    if (!tasks[id]) throw new Error(`unknown task ${id}`);
    return tasks[id];
  };

  const mkRun = (expId: string, runId: string, taskId: string, phase: 'quick' | 'verify' | 'holdout', streamText: string) => {
    const suite = phase === 'holdout' ? 'holdout' : 'dev';
    db.insertRunStart({ runId, experimentId: expId, configId: 'baseline', seed: 1, phase, suite, taskId });
    db.finishRun(runId, { ...fakeCoding({ runId, configId: 'baseline', tokens: 90_000, experimentId: expId }), taskId }, true);
    db.insertEvaluation(
      fakeEval({ runId, passed: true, suite, checks: [{ id: `${taskId}.secret-check`, category: 'backend', mandatory: true, outcome: 'fail', message: `secret detail of ${taskId}`, attempts: 1 }] }),
    );
    const d = join(results, 'runs', runId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'claude-stream.jsonl'), JSON.stringify({ type: 'assistant', text: streamText }) + '\n');
    writeFileSync(join(d, 'usage.jsonl'), '{"role":"coding","totalTokens":90000}\n');
    writeFileSync(join(d, 'trace.jsonl'), '{"type":"model_call","turn":1}\n');
    writeFileSync(join(d, 'run.json'), JSON.stringify({ runId, taskId }));
    writeFileSync(join(d, 'workspace.patch'), 'diff --git a/app/x.rb b/app/x.rb\n+GENERATED APP CODE\n');
  };

  beforeEach(() => {
    dir = makeTmp('frugal-ws-tasks-');
    configs = makeConfigsRoot(dir);
    results = join(dir, 'results');
    tasksRoot = join(dir, 'benchmark', 'tasks');
    for (const [id, title, prompt] of [
      ['mastodon-bookmarks', 'Re-implement saving statuses for later', 'Implement the save-for-later feature described in /spec/feature.md.'],
      ['mastodon-filters', HOLDOUT_TITLE, HOLDOUT_PROMPT],
    ]) {
      const tdir = join(tasksRoot, id);
      mkdirSync(join(tdir, 'spec'), { recursive: true });
      writeFileSync(join(tdir, 'prompt.md'), prompt + '\n');
      writeFileSync(join(tdir, 'spec', 'feature.md'), `# Feature spec of ${id === 'mastodon-filters' ? 'the hidden task' : 'the dev task'}\n`);
      tasks[id] = { id, title, kind: 'brownfield', specPath: join(tdir, 'spec'), dir: tdir };
    }
    db = openDb(join(results, 'benchmark.db'));
    // Dev task: baseline with a verify run. Holdout task: runs under the SAME experiment (phase holdout)
    // and a whole experiment of its own (e.g. from another session that used it as the dev task).
    const dev = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'Baseline verification', provider: 'p', model: 'm', status: 'verifying', taskId: 'mastodon-bookmarks' });
    mkRun(dev.id, 'run-dev-1', 'mastodon-bookmarks', 'verify', 'dev transcript: grep app/models');
    mkRun(dev.id, 'run-hold-1', 'mastodon-filters', 'holdout', `holdout transcript mentioning mastodon-filters and ${HOLDOUT_PROMPT}`);
    db.updateExperiment(dev.id, { status: 'completed', outcome: 'baseline', holdoutPassed: false });
    const other = db.insertExperiment({ kind: 'manual', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'Manual benchmark: npm run benchmark --task mastodon-filters', provider: 'p', model: 'm', status: 'verifying', taskId: 'mastodon-filters' });
    mkRun(other.id, 'run-hold-2', 'mastodon-filters', 'verify', `another holdout transcript ${HOLDOUT_TITLE}`);
    db.updateExperiment(other.id, { status: 'completed' });
    // A todo experiment is from another dev task: not shown either.
    const todo = db.insertExperiment({ kind: 'manual', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'todo manual run', provider: 'p', model: 'm', status: 'verifying' });
    mkRun(todo.id, 'run-todo-1', 'todo', 'verify', 'todo transcript');
    db.updateExperiment(todo.id, { status: 'completed' });
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('contains only dev-task material; the holdout task is invisible (one pass/fail bit only)', async () => {
    const history = buildHistoryDigest(db, { taskId: 'mastodon-bookmarks' });
    const ws = await buildResearchWorkspace({
      db,
      resultsDir: results,
      configsRoot: configs,
      bestConfigId: 'baseline',
      bestConfigFiles: readConfigFiles('baseline', configs),
      history,
      whitelist: { allowModelChange: false, backend: 'claude-code' },
      experimentIndex: 1,
      singleVariableExperiments: 8,
      profile: fakeProfile,
      repoRoot: dir,
      taskId: 'mastodon-bookmarks',
      hiddenTaskIds: ['mastodon-filters'],
      getTask,
    });
    try {
      const files = walk(ws.dir);
      expect(ws.runs).toEqual(['run-dev-1']);
      expect(ws.experiments).toEqual(['exp-0001']);
      expect(files.filter((f) => f.startsWith('runs/')).every((f) => f.startsWith('runs/run-dev-1/'))).toBe(true);
      expect(files).not.toContain('runs/run-dev-1/workspace.patch'); // generated app code is never copied
      expect(files).toContain('spec/feature.md');
      expect(files).toContain('spec/prompt.md');
      expect(readFileSync(join(ws.dir, 'spec', 'feature.md'), 'utf8')).toContain('the dev task');
      // No file mentions the holdout task in any form.
      for (const f of files) {
        const text = readFileSync(join(ws.dir, f), 'utf8');
        for (const needle of ['mastodon-filters', HOLDOUT_TITLE, HOLDOUT_PROMPT, 'the hidden task', 'todo transcript', 'todo manual run']) expect(text, `${f} contains ${needle}`).not.toContain(needle);
      }
      // The holdout result is one bit in outcome.json.
      const outcome = JSON.parse(readFileSync(join(ws.dir, 'experiments', 'exp-0001', 'outcome.json'), 'utf8'));
      expect(outcome.holdoutPassed).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain('secret');
      // README describes the brownfield task and the read-only codebase mount.
      const readme = readFileSync(join(ws.dir, 'README.md'), 'utf8');
      expect(readme).toContain('implements a feature in a large EXISTING codebase');
      expect(readme).toContain('/research/codebase/');
      expect(readme).not.toContain('builds a full-stack todo app');
      // Digest: dev task only.
      expect(history).not.toContain('mastodon-filters');
      expect(history).toContain('holdout: failed');
      expect(history).not.toContain('todo manual run');
    } finally {
      ws.cleanup();
    }
  });

  it('a file carrying hidden-task markers is removed by the final scan', async () => {
    writeFileSync(join(results, 'runs', 'run-dev-1', 'trace.jsonl'), `{"note":"saw benchmark/tasks/mastodon-filters/prompt.md"}\n`);
    const ws = await buildResearchWorkspace({
      db,
      resultsDir: results,
      configsRoot: configs,
      bestConfigId: 'baseline',
      bestConfigFiles: readConfigFiles('baseline', configs),
      history: 'digest',
      whitelist: { allowModelChange: false, backend: 'claude-code' },
      experimentIndex: 1,
      singleVariableExperiments: 8,
      profile: fakeProfile,
      repoRoot: dir,
      taskId: 'mastodon-bookmarks',
      hiddenTaskIds: ['mastodon-filters'],
      getTask,
    });
    try {
      expect(walk(ws.dir)).not.toContain('runs/run-dev-1/trace.jsonl');
      expect(ws.notes.join(' ')).toMatch(/trace\.jsonl: removed/);
    } finally {
      ws.cleanup();
    }
    expect(hiddenTaskMarkers([{ id: 'mastodon-filters', title: HOLDOUT_TITLE }])).toEqual(['mastodon-filters', 'benchmark/tasks/mastodon-filters', 'evaluator/tasks/mastodon-filters', HOLDOUT_TITLE]);
  });

  it('brownfield research container: read-only /research/codebase tmpfs, no host mounts', () => {
    const o = researchSandboxOptions({ image: 'img', label: 'l', network: 'n', codebase: true });
    const cb = o.extraTmpfs!.find((t) => t.startsWith('/research/codebase:'))!;
    expect(cb).toMatch(/noexec/);
    expect(cb).not.toMatch(/uid=1000/); // root-owned: node can read, not write
    expect((o as { volumes?: unknown }).volumes).toBeUndefined();
    expect(researchSandboxOptions({ image: 'img', label: 'l', network: 'n' }).extraTmpfs!.some((t) => t.startsWith('/research/codebase'))).toBe(false);
  });
});
