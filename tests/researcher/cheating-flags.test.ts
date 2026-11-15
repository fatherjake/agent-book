/**
 * Cheating flags (human verdicts) and the "verify only if the quick run beat the best" gate.
 * Fake runBenchmark + fake research agent: nothing here is a real measurement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHistoryDigest } from '../../researcher/history.js';
import { runResearchLoop, type LoopDeps } from '../../researcher/loop.js';
import type { ResearchAgent } from '../../researcher/research-agent.js';
import { DEFAULT_RESEARCH_SETTINGS, type ResearchSettings } from '../../researcher/settings.js';
import { openDb, type Db } from '../../storage/db.js';
import { makeConfigsRoot, makeFakeBench, makeFakeClock, makeTmp, rmTmp, type Plan } from './helpers.js';
import type { RunBenchmarkOptions } from '../../researcher/experiment.js';

function fakeAgent(): ResearchAgent & { calls: number } {
  const a = {
    calls: 0,
    async propose() {
      a.calls++;
      return { proposal: { hypothesis: `fake hypothesis ${a.calls}`, changeSummary: `fake change ${a.calls}`, files: { 'system-prompt.md': `PROMPT v${a.calls}\n` } }, usage: [], attempts: 1 };
    },
  };
  return a;
}

const settings = (o: Partial<ResearchSettings> = {}): ResearchSettings => ({
  ...DEFAULT_RESEARCH_SETTINGS,
  verificationRuns: 3,
  maxExperiments: 2,
  maxResearchCostUsd: 1000,
  holdout: { onPromotion: false, runs: 1 },
  ...o,
});

describe('cheating flags + quick-run gate', () => {
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

  const run = (plan: Plan, s: ResearchSettings, onRun?: (o: RunBenchmarkOptions, i: number) => void, extra: Partial<LoopDeps> = {}) => {
    const bench = makeFakeBench(db, plan, { onRun });
    const p = runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: fakeAgent(), clock: makeFakeClock(), ...extra },
      { settings: s, paths: { configsRoot: configs, resultsDir: results } },
    );
    return { bench, p };
  };

  /** baseline 1000; experiments/001 800 (promoted); experiments/002 (child of 001) 600 (promoted). */
  const chain: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : cfg === 'experiments/001' ? 800 : 600 });

  it('default quickRunMaxTokenRatio is 1.0: verify only when the quick run beat the best median', async () => {
    expect(DEFAULT_RESEARCH_SETTINGS.quickRunMaxTokenRatio).toBe(1);
    const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : cfg === 'experiments/001' ? 1001 : 999 });
    const { bench, p } = run(plan, settings());
    await p;
    const [, a, b] = db.listExperiments();
    expect(a.outcome).toBe('not_better');
    expect(a.notes).toContain('verification skipped');
    expect(bench.calls.filter((c) => c.configId === 'experiments/001').map((c) => c.phase)).toEqual(['quick']);
    expect(b.outcome).toBe('promoted');
    expect(bench.calls.filter((c) => c.configId === 'experiments/002').map((c) => c.phase)).toEqual(['quick', 'verify']);
  });

  it('flag targets resolve from run, experiment or config id; baselines and empty reasons are refused; flags are append-only', async () => {
    await run(chain, settings({ maxExperiments: 1 })).p;
    const exp = db.listExperiments()[1];
    const runId = db.listRuns({ experimentId: exp.id })[0].runId;
    expect(db.resolveFlagTarget(runId)).toMatchObject({ configId: 'experiments/001', experimentId: exp.id, runId });
    expect(db.resolveFlagTarget(exp.id)).toMatchObject({ configId: 'experiments/001', experimentId: exp.id, runId: null });
    expect(db.resolveFlagTarget('experiments/001')).toMatchObject({ configId: 'experiments/001', experimentId: exp.id });
    expect(() => db.resolveFlagTarget('baseline')).toThrow(/baseline/);
    expect(() => db.resolveFlagTarget('nope')).toThrow(/no run, experiment or config/);
    expect(() => db.insertFlag({ target: exp.id, kind: 'cheating', reason: '  ' })).toThrow(/reason/);
    const f = db.insertFlag({ target: runId, kind: 'cheating', reason: 'ships a prebuilt server' });
    expect(f).toMatchObject({ configId: 'experiments/001', kind: 'cheating', source: 'human' });
    expect(() => db.raw.prepare('DELETE FROM flags').run()).toThrow(/append-only/);
    expect(() => db.raw.prepare("UPDATE flags SET reason = 'x'").run()).toThrow(/immutable/);
  });

  it('flagging the best demotes it and every config derived from it; clearing restores; promotion is refused', async () => {
    await run(chain, settings()).p;
    expect(db.getBestVerified()!.configId).toBe('experiments/002');
    const e1 = db.listExperiments()[1];

    db.insertFlag({ target: e1.id, kind: 'cheating', reason: 'copies the reference app' });
    expect(db.getBestVerified()!.configId).toBe('baseline');
    const s2 = db.cheatingStatus('experiments/002')!;
    expect(s2).toMatchObject({ inherited: true, flaggedConfigId: 'experiments/001' });
    expect(db.getBestHistory().map((b) => b.flaggedCheating)).toEqual([false, true, true]);
    const items = db.listExperimentsWithAggregates();
    expect(items[1].cheating?.inherited).toBe(false);
    expect(items[2].cheating?.inherited).toBe(true);
    expect(() => db.recordPromotion({ experimentId: e1.id, configId: 'experiments/001', summary: e1.summary! })).toThrow(/cheating/);

    // The child is reviewed separately and found clean: its own 'cleared' entry overrides inheritance.
    db.insertFlag({ target: 'experiments/002', kind: 'cleared', reason: 'trick removed in this child' });
    expect(db.cheatingStatus('experiments/002')).toBeNull();
    expect(db.getBestVerified()!.configId).toBe('experiments/002');

    const digest = buildHistoryDigest(db);
    expect(digest).toContain('FLAGGED AS CHEATING');
    expect(digest).toContain('copies the reference app');
  });

  it('a flag raised during verification stops the batch before the next run and rejects the candidate', async () => {
    const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 500 });
    let flagged = false;
    const { bench, p } = run(plan, settings({ maxExperiments: 2 }), (o, i) => {
      if (!flagged && o.configId === 'experiments/001' && o.phase === 'verify' && i === 0) {
        flagged = true;
        db.insertFlag({ target: 'experiments/001', kind: 'cheating', reason: 'hook rewrites the evaluator url' });
      }
    });
    const res = await p;
    const exps = db.listExperiments();
    expect(exps[1]).toMatchObject({ status: 'rejected', outcome: 'flagged_cheating' });
    expect(exps[1].notes).toContain('hook rewrites the evaluator url');
    // Only the run that was already starting executed; no further verification runs.
    expect(db.listRuns({ experimentId: exps[1].id, phase: 'verify' })).toHaveLength(1);
    // The next candidate builds on the clean best (baseline), not on the flagged config.
    expect(exps[2].parentConfigId).toBe('baseline');
    expect(res.best!.configId).toBe('experiments/002');
    expect(bench.calls.some((c) => c.configId === 'experiments/001' && c.phase === 'holdout')).toBe(false);
  });

  it('flagging the published best mid-session republishes results/best-config from the clean best', async () => {
    let flagged = false;
    const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : cfg === 'experiments/001' ? 800 : 900 });
    await run(plan, settings({ maxExperiments: 3, quickRunMaxTokenRatio: null }), (o) => {
      // While the 2nd candidate runs, a human flags the promoted experiments/001.
      if (!flagged && o.configId === 'experiments/002') {
        flagged = true;
        db.insertFlag({ target: 'experiments/001', kind: 'cheating', reason: 'skill contains the whole app' });
      }
    }).p;
    const exps = db.listExperiments();
    // 2nd candidate was derived from experiments/001 → inherited flag → rejected.
    expect(exps[2]).toMatchObject({ parentConfigId: 'experiments/001', outcome: 'flagged_cheating' });
    // 3rd candidate starts from the clean best and gets promoted over the baseline.
    expect(exps[3].parentConfigId).toBe('baseline');
    const summary = JSON.parse(readFileSync(join(results, 'best-config', 'summary.json'), 'utf8'));
    expect(summary.configId).toBe('experiments/003');
  });
});
