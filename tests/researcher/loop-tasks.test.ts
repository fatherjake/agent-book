/**
 * Research loop on a non-todo dev task with INJECTED MOCKS (fake runBenchmark, fake research agent,
 * fake task lookup): per-task baseline and best, holdout on a different task, minPassRate promotion.
 * Nothing here is a real measurement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetsPassRate, summarize } from '../../researcher/experiment.js';
import { buildHistoryDigest } from '../../researcher/history.js';
import { runResearchLoop } from '../../researcher/loop.js';
import type { ResearchAgent } from '../../researcher/research-agent.js';
import { DEFAULT_RESEARCH_SETTINGS, loadResearchSettings, type ResearchSettings } from '../../researcher/settings.js';
import { openDb, type Db } from '../../storage/db.js';
import { fakeCoding, fakeEval, makeConfigsRoot, makeFakeBench, makeFakeClock, makeTmp, rmTmp, type Plan } from './helpers.js';

function fakeAgent(): ResearchAgent & { inputs: Parameters<ResearchAgent['propose']>[0][] } {
  const a = {
    inputs: [] as Parameters<ResearchAgent['propose']>[0][],
    async propose(input: Parameters<ResearchAgent['propose']>[0]) {
      a.inputs.push(input);
      const n = a.inputs.length;
      return { proposal: { hypothesis: `fake hypothesis ${n}`, changeSummary: `fake change ${n}`, files: { 'system-prompt.md': `FAKE PROMPT v${n}\n` } }, usage: [], attempts: 1 };
    },
  };
  return a;
}

const TASKS: Record<string, { id: string; minPassRate: number }> = {
  todo: { id: 'todo', minPassRate: 1 },
  'tiny-depth': { id: 'tiny-depth', minPassRate: 0.6 },
  'tiny-pnl': { id: 'tiny-pnl', minPassRate: 1 },
};
const getTask = (id: string) => {
  if (!TASKS[id]) throw new Error(`unknown task ${id}`);
  return TASKS[id];
};

const settings = (o: Partial<ResearchSettings> = {}): ResearchSettings => ({
  ...DEFAULT_RESEARCH_SETTINGS,
  verificationRuns: 5,
  maxExperiments: 2,
  maxResearchCostUsd: 1000,
  quickRunMaxTokenRatio: null,
  holdout: { onPromotion: true, runs: 1 },
  devTask: 'tiny-depth',
  holdoutTask: 'tiny-pnl',
  ...o,
});

describe('research loop with a brownfield dev task', () => {
  let dir: string;
  let configs: string;
  let results: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    configs = makeConfigsRoot(dir);
    results = join(dir, 'results');
    db = openDb(join(results, 'benchmark.db'));
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('bootstraps a baseline for the dev task even when todo already has a best; holdout runs on the holdout task', async () => {
    // An existing todo best must not count for the dev task.
    db.ensureConfig({ configId: 'baseline', hash: 'h', parentId: null, path: 'baseline', hypothesis: null });
    const t = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'todo baseline', provider: 'p', model: 'm', status: 'verifying' });
    const todoSummary = { ...summarize([{ coding: fakeCoding({ tokens: 40000 }), evaluation: fakeEval({ runId: 'x', passed: true }), passed: true }], 'baseline') };
    db.updateExperiment(t.id, { summary: todoSummary, status: 'completed', outcome: 'baseline' });
    db.recordPromotion({ experimentId: t.id, configId: 'baseline', summary: todoSummary });

    // baseline: 5/5 pass at 100k. experiments/001: 3/5 pass (>= 0.6) at 80k → promoted. experiments/002: 2/5 → failed.
    const plan: Plan = (cfg, phase, i) => {
      if (cfg === 'baseline') return { passed: true, tokens: 100_000 };
      if (cfg === 'experiments/001') return { passed: phase !== 'verify' || i < 3, tokens: 80_000 };
      return { passed: phase !== 'verify' || i < 2, tokens: 50_000 };
    };
    const bench = makeFakeBench(db, plan);
    const agent = fakeAgent();
    const res = await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: agent, clock: makeFakeClock(), getTask },
      { settings: settings(), paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(res.stopReason).toBe('max_experiments');
    expect(res.best!.configId).toBe('experiments/001');
    expect(res.best!.taskId).toBe('tiny-depth');
    // todo's best is untouched.
    expect(db.getBestVerified('todo')!.medianTokens).toBe(40000);

    const exps = db.listExperiments({ taskId: 'tiny-depth' });
    expect(exps.map((e) => [e.kind, e.outcome, e.status])).toEqual([
      ['baseline', 'baseline', 'completed'],
      ['candidate', 'promoted', 'completed'],
      ['candidate', 'failed_verification', 'rejected'],
    ]);
    expect(exps[1].summary!.meetsQualityRequirements).toBe(true);
    expect(exps[1].summary!.minPassRate).toBe(0.6);
    expect(exps[2].notes).toMatch(/2\/5 verification runs passed \(minPassRate 0\.6\)/);

    // Quick / verify / baseline runs on the dev task; holdout on the holdout task (suite + phase holdout).
    const nonHoldout = bench.calls.filter((c) => c.phase !== 'holdout');
    expect(new Set(nonHoldout.map((c) => c.taskId))).toEqual(new Set(['tiny-depth']));
    const holdouts = bench.calls.filter((c) => c.phase === 'holdout');
    expect(holdouts.map((c) => [c.configId, c.taskId, c.suite])).toEqual([
      ['baseline', 'tiny-pnl', 'holdout'],
      ['experiments/001', 'tiny-pnl', 'holdout'],
    ]);
    expect(exps[1].holdoutPassed).toBe(true);
    expect(db.listRuns({ taskId: 'tiny-pnl' }).every((r) => r.phase === 'holdout' && r.suite === 'holdout')).toBe(true);

    // The research agent gets the dev task and the hidden holdout task, and a digest without the holdout task.
    const input = agent.inputs[0];
    expect(input.context).toMatchObject({ taskId: 'tiny-depth', hiddenTaskIds: ['tiny-pnl'] });
    expect(input.bestConfigId).toBe('baseline');
    expect(input.history).not.toContain('tiny-pnl');
    expect(input.history).not.toContain('todo baseline');
    expect(input.history).toMatch(/BEST VERIFIED: baseline .* median 100,000/);
    expect(buildHistoryDigest(db, { taskId: 'todo' })).toMatch(/median 40,000/);

    // Published best of the dev task goes to its own directory.
    const summaryFile = join(results, 'best-config-tiny-depth', 'summary.json');
    expect(existsSync(summaryFile)).toBe(true);
    expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject({ configId: 'experiments/001', taskId: 'tiny-depth' });
    expect(existsSync(join(results, 'best-config', 'summary.json'))).toBe(false);
  });

  it('holdout on the same task keeps the old behaviour (dev task, holdout suite)', async () => {
    const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 900 });
    const bench = makeFakeBench(db, plan);
    await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: fakeAgent(), clock: makeFakeClock(), getTask },
      { settings: settings({ holdoutTask: 'tiny-depth', maxExperiments: 1 }), paths: { configsRoot: configs, resultsDir: results } },
    );
    const holdouts = bench.calls.filter((c) => c.phase === 'holdout');
    expect(holdouts.length).toBeGreaterThan(0);
    expect(holdouts.every((c) => c.taskId === 'tiny-depth' && c.suite === 'holdout')).toBe(true);
  });

  it('todo (default settings) still requires every verification run to pass', async () => {
    const plan: Plan = (cfg, phase, i) => (cfg === 'baseline' ? { passed: true, tokens: 1000 } : { passed: !(phase === 'verify' && i === 0), tokens: 500 });
    const bench = makeFakeBench(db, plan);
    const res = await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: fakeAgent(), clock: makeFakeClock() },
      { settings: { ...settings({ devTask: 'todo', holdoutTask: 'todo', maxExperiments: 1 }), verificationRuns: 5 }, paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(res.best!.configId).toBe('baseline');
    expect(db.listExperiments().map((e) => e.outcome)).toEqual(['baseline', 'failed_verification']);
    expect(bench.calls.every((c) => c.taskId === 'todo')).toBe(true);
    expect(existsSync(join(results, 'best-config', 'summary.json'))).toBe(true);
  });
});

describe('minPassRate and task settings', () => {
  it('meetsPassRate: 1.0 means every run; fractional thresholds round up', () => {
    expect(meetsPassRate(5, 5)).toBe(true);
    expect(meetsPassRate(4, 5)).toBe(false);
    expect(meetsPassRate(3, 5, 0.6)).toBe(true);
    expect(meetsPassRate(2, 5, 0.6)).toBe(false);
    expect(meetsPassRate(4, 5, 0.8)).toBe(true);
    expect(meetsPassRate(0, 0, 0.5)).toBe(false);
    const r = (passed: boolean) => ({ coding: fakeCoding({ tokens: 10 }), evaluation: fakeEval({ runId: 'r', passed }), passed });
    expect(summarize([r(true), r(true), r(false)], 'c').meetsQualityRequirements).toBe(false);
    expect(summarize([r(true), r(true), r(false)], 'c', { minPassRate: 0.6 }).meetsQualityRequirements).toBe(true);
  });

  it('settings: devTask/holdoutTask default to todo; holdoutTask defaults to the dev task; unknown tasks are rejected', () => {
    const missing = join(makeTmp(), 'none.json');
    const d = loadResearchSettings(missing);
    expect([d.devTask, d.holdoutTask]).toEqual(['todo', 'todo']);
    expect(() => loadResearchSettings(missing, { devTask: 'no-such-task' })).toThrow(/devTask: Invalid task \(no-such-task\): unknown task/);
    expect(() => loadResearchSettings(missing, { devTask: 'Bad Id' })).toThrow(/devTask must be a task id/);
  });
});
