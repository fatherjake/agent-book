/**
 * Research loop tests with INJECTED MOCKS: a fake runBenchmark (fabricated results, no Docker,
 * no models) and a fake research agent. Nothing here is a real measurement.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runResearchLoop, type LoopDeps } from '../../researcher/loop.js';
import { ResearchProposalError, type ResearchAgent } from '../../researcher/research-agent.js';
import { DEFAULT_RESEARCH_SETTINGS, type ResearchSettings } from '../../researcher/settings.js';
import type { Proposal } from '../../researcher/whitelist.js';
import { openDb, type Db } from '../../storage/db.js';
import { makeConfigsRoot, makeFakeBench, makeFakeClock, makeTmp, rmTmp, type Plan } from './helpers.js';

/** FAKE research agent: each proposal rewrites system-prompt.md with a unique marker. */
function fakeAgent(proposals?: (n: number) => Proposal | Error): ResearchAgent & { calls: number; inputs: unknown[] } {
  const a = {
    calls: 0,
    inputs: [] as unknown[],
    async propose(input: Parameters<ResearchAgent['propose']>[0]) {
      a.calls++;
      a.inputs.push(input);
      const p = proposals?.(a.calls) ?? { hypothesis: `fake hypothesis ${a.calls}`, changeSummary: `fake change ${a.calls}`, files: { 'system-prompt.md': `FAKE PROMPT v${a.calls}\n` } };
      if (p instanceof Error) throw p;
      return { proposal: p, usage: [], attempts: 1 };
    },
  };
  return a;
}

const settings = (o: Partial<ResearchSettings> = {}): ResearchSettings => ({
  ...DEFAULT_RESEARCH_SETTINGS,
  verificationRuns: 3,
  maxExperiments: 2,
  maxResearchCostUsd: 1000,
  quickRunMaxTokenRatio: null,
  holdout: { onPromotion: true, runs: 1 },
  ...o,
});

describe('research loop (fake runBenchmark + fake research agent)', () => {
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

  const run = (plan: Plan, agent: ResearchAgent, s: ResearchSettings, extra: Partial<LoopDeps> = {}, signal?: AbortSignal) => {
    const bench = makeFakeBench(db, plan);
    const p = runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: agent, clock: makeFakeClock(), ...extra },
      { settings: s, paths: { configsRoot: configs, resultsDir: results }, signal },
    );
    return { bench, p };
  };

  it('bootstraps the baseline, promotes only when all verification runs pass with a lower median', async () => {
    // baseline 1000 tok; exp-0002 (experiments/001) 800 tok all pass → promoted;
    // exp-0003 (experiments/002) cheaper but one verification failure → rejected.
    const plan: Plan = (cfg, phase, i) => {
      if (cfg === 'baseline') return { passed: true, tokens: 1000 };
      if (cfg === 'experiments/001') return { passed: true, tokens: 800 };
      return { passed: !(phase === 'verify' && i === 1), tokens: 500 };
    };
    const { bench, p } = run(plan, fakeAgent(), settings());
    const res = await p;
    expect(res.stopReason).toBe('max_experiments');
    expect(res.best!.configId).toBe('experiments/001');
    const exps = db.listExperiments();
    expect(exps.map((e) => [e.kind, e.outcome, e.status])).toEqual([
      ['baseline', 'baseline', 'completed'],
      ['candidate', 'promoted', 'completed'],
      ['candidate', 'failed_verification', 'rejected'],
    ]);
    expect(db.getBestHistory().map((b) => b.configId)).toEqual(['baseline', 'experiments/001']);
    // holdout ran on each promotion and only a bit was stored
    expect(bench.calls.filter((c) => c.phase === 'holdout').map((c) => c.configId)).toEqual(['baseline', 'experiments/001']);
    expect(exps[1].holdoutPassed).toBe(true);
    // best-config copy with summary.json
    const summary = JSON.parse(readFileSync(join(results, 'best-config', 'summary.json'), 'utf8'));
    expect(summary.configId).toBe('experiments/001');
    expect(summary.summary.medianTokens).toBe(800);
    expect(readFileSync(join(results, 'best-config', 'system-prompt.md'), 'utf8')).toBe('FAKE PROMPT v1\n');
    expect(existsSync(join(results, 'best-config-history'))).toBe(true);
    // second proposal was based on the promoted config
    expect(db.listExperiments()[2].parentConfigId).toBe('experiments/001');
    // run token budget passed as override
    expect(bench.calls.every((c) => c.maxTokensPerRun === DEFAULT_RESEARCH_SETTINGS.maxTokensPerCodingRun)).toBe(true);
  });

  it('a failed low-token quick run never replaces the best', async () => {
    const plan: Plan = (cfg) => (cfg === 'baseline' ? { passed: true, tokens: 1000 } : { passed: false, tokens: 10 });
    const { bench, p } = run(plan, fakeAgent(), settings({ maxExperiments: 1 }));
    const res = await p;
    expect(res.best!.configId).toBe('baseline');
    const cand = db.listExperiments()[1];
    expect(cand.outcome).toBe('failed_quick_run');
    expect(cand.quickPassed).toBe(false);
    expect(bench.calls.filter((c) => c.configId !== 'baseline').map((c) => c.phase)).toEqual(['quick']); // no verification
  });

  it('does not promote a passing candidate that is not cheaper (or within the noise margin)', async () => {
    const plan: Plan = (cfg) => (cfg === 'baseline' ? { passed: true, tokens: 1000 } : cfg === 'experiments/001' ? { passed: true, tokens: 1200 } : { passed: true, tokens: 950 });
    const res = await run(plan, fakeAgent(), settings({ noiseMarginPct: 10 })).p;
    expect(res.best!.configId).toBe('baseline');
    expect(db.listExperiments().slice(1).map((e) => e.outcome)).toEqual(['not_better', 'not_better']);
  });

  it('skips verification when the quick run is far above the best median', async () => {
    const plan: Plan = (cfg) => (cfg === 'baseline' ? { passed: true, tokens: 1000 } : { passed: true, tokens: 2000 });
    const { bench, p } = run(plan, fakeAgent(), settings({ maxExperiments: 1, quickRunMaxTokenRatio: 1.5 }));
    await p;
    expect(db.listExperiments()[1].outcome).toBe('not_better');
    expect(bench.calls.filter((c) => c.phase === 'verify' && c.configId !== 'baseline')).toHaveLength(0);
  });

  it('[MOCK] mock-provider results can never be promoted', async () => {
    const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 10, mock: true });
    const mockProvider = { name: 'mock', isMock: true, complete: async () => { throw new Error('unused'); } };
    const res = await run(plan, fakeAgent(), settings({ maxExperiments: 1 }), { codingProvider: mockProvider }).p;
    expect(res.best).toBeNull();
    expect(db.getBestHistory()).toHaveLength(0);
    const exps = db.listExperiments();
    expect(exps.every((e) => e.isMock)).toBe(true);
    expect(exps[1].outcome).toBe('not_better');
    expect(exps[1].notes).toContain('[MOCK]');
    expect(existsSync(join(results, 'best-config'))).toBe(false);
  });

  it('stops when the cost budget is exhausted (also mid-batch)', async () => {
    const plan: Plan = () => ({ passed: true, tokens: 1000, costUsd: 1 });
    const { bench, p } = run(plan, fakeAgent(), settings({ maxExperiments: 10, maxResearchCostUsd: 2.5 }));
    const res = await p;
    expect(res.stopReason).toBe('max_cost');
    // baseline needs 3 runs but budget allows only 3 starts ($0,$1,$2 < 2.5) — at most 3 coding runs total
    expect(bench.calls.flatMap((c) => c).length).toBeGreaterThan(0);
    expect(db.listRuns().length).toBeLessThanOrEqual(3);
    expect(db.getSession(res.sessionId)!.status).toBe('stopped');
    expect(db.getSession(res.sessionId)!.stopReason).toBe('max_cost');
  });

  it('stops at maxExperiments and maxTotalDuration', async () => {
    const plan: Plan = (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 1100 });
    const r1 = await run(plan, fakeAgent(), settings({ maxExperiments: 0 })).p;
    expect(r1.stopReason).toBe('max_experiments');
    expect(db.listExperiments().filter((e) => e.kind === 'candidate')).toHaveLength(0);
    // duration: clock jumps 1h per run
    const clock = makeFakeClock();
    const bench = makeFakeBench(db, plan, { onRun: () => (clock.t += 3600_000) });
    const r2 = await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: fakeAgent(), clock },
      { settings: settings({ maxExperiments: 100, maxTotalDurationSec: 5 * 3600 }), paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(r2.stopReason).toBe('max_duration');
  });

  it('waits while the pause file exists', async () => {
    const pauseFile = join(results, 'research.pause');
    writeFileSync(pauseFile, '');
    const clock = makeFakeClock(() => {
      if (clock.sleeps >= 3) rmSync(pauseFile, { force: true });
    });
    const agent = fakeAgent();
    const bench = makeFakeBench(db, (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 900 }));
    const res = await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: agent, clock },
      { settings: settings({ maxExperiments: 1, pausePollSec: 10 }), paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(clock.sleeps).toBeGreaterThanOrEqual(3);
    expect(res.experimentsRun).toBe(1);
    // paused time is not counted as active research time
    expect(db.getSession(res.sessionId)!.activeMs).toBeLessThan(30_000);
  });

  it('recovers interrupted experiments from a dead session and cleans up containers', async () => {
    db.createSession({ id: 'dead', budgets: { maxExperiments: 5, maxResearchCostUsd: 10, maxTokensPerCodingRun: null, maxRuntimePerExperimentSec: 60, maxTotalDurationSec: 600, verificationRuns: 3 } });
    const e = db.insertExperiment({ sessionId: 'dead', kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: 'experiments/001', hypothesis: 'h', provider: 'p', model: 'm', status: 'verifying' });
    db.insertRunStart({ runId: 'orphan', experimentId: e.id, configId: 'experiments/001', seed: 1, phase: 'verify', suite: 'dev' });
    let cleaned = 0;
    const res = await run(() => ({ passed: true, tokens: 1000 }), fakeAgent(), settings({ maxExperiments: 0 }), {
      cleanupContainers: async () => ++cleaned,
    }).p;
    expect(cleaned).toBe(1);
    expect(db.getExperiment(e.id)!.status).toBe('interrupted');
    expect(db.getRun('orphan')!.status).toBe('interrupted');
    expect(db.getSession('dead')!.status).toBe('interrupted');
    expect(res.sessionId).not.toBe('dead');
  });

  it('resumes the previous session and its spend with --resume', async () => {
    const plan: Plan = () => ({ passed: true, tokens: 1000, costUsd: 1 });
    const first = await run(plan, fakeAgent(), settings({ maxExperiments: 0, maxResearchCostUsd: 100 })).p; // baseline: $3
    const second = await runResearchLoop(
      { db, runBenchmark: makeFakeBench(db, plan).fn, researchAgent: fakeAgent(), clock: makeFakeClock() },
      { settings: settings({ maxExperiments: 5, maxResearchCostUsd: 3.5 }), resume: true, paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stopReason).toBe('max_cost');
    expect(db.listSessions()).toHaveLength(1);
  });

  it('graceful shutdown marks the current experiment interrupted', async () => {
    const ctrl = new AbortController();
    const plan: Plan = () => ({ passed: true, tokens: 1000 });
    const bench = makeFakeBench(db, plan, {
      onRun: (o, i) => {
        if (o.configId === 'experiments/001' && o.phase === 'verify' && i === 1) ctrl.abort();
      },
    });
    const res = await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: fakeAgent(), clock: makeFakeClock() },
      { settings: settings({ maxExperiments: 5 }), signal: ctrl.signal, paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(res.stopReason).toBe('interrupted');
    const cand = db.listExperiments()[1];
    expect(cand.status).toBe('interrupted');
    expect(cand.outcome).toBeNull();
    expect(db.getSession(res.sessionId)!.status).toBe('interrupted');
  });

  it('records research-agent failures and optimizer rejections, then stops after repeated failures', async () => {
    const proposals = (n: number): Proposal | Error =>
      n === 1
        ? { hypothesis: 'forbidden change', changeSummary: 'touch limits', files: { 'config.json': { limits: { maxTotalTokens: 1 } } } }
        : new ResearchProposalError('invalid JSON twice', []);
    const res = await run(() => ({ passed: true, tokens: 1000 }), fakeAgent(proposals), settings({ maxExperiments: 10, maxConsecutiveProposalFailures: 3 })).p;
    expect(res.stopReason).toBe('research_agent_failing');
    const cands = db.listExperiments().filter((e) => e.kind === 'candidate');
    expect(cands[0]).toMatchObject({ status: 'rejected', outcome: 'error' });
    expect(cands[0].error).toMatch(/limits/);
    expect(cands.slice(1).map((e) => e.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('keeps going without a verified best when the baseline fails, and does not rerun it', async () => {
    const plan: Plan = (cfg, phase, i) => (cfg === 'baseline' ? { passed: i !== 0, tokens: 1000 } : { passed: true, tokens: 5000 });
    const res = await run(plan, fakeAgent(), settings({ maxExperiments: 1 })).p;
    // candidate passes all → becomes best even with more tokens (no verified baseline to beat)
    expect(res.best!.configId).toBe('experiments/001');
    expect(db.getOverview().baseline!.meetsQuality).toBe(false);
    const again = makeFakeBench(db, plan);
    await runResearchLoop(
      { db, runBenchmark: again.fn, researchAgent: fakeAgent(), clock: makeFakeClock() },
      { settings: settings({ maxExperiments: 0 }), paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(again.calls.filter((c) => c.configId === 'baseline')).toHaveLength(0);
  });

  it('does not rerun a completed (non-qualifying) baseline on restart', async () => {
    const plan: Plan = (cfg, _phase, i) => (cfg === 'baseline' ? { passed: i !== 0, tokens: 1000 } : { passed: false, tokens: 10 });
    const r1 = await run(plan, fakeAgent(), settings({ maxExperiments: 1 })).p;
    expect(r1.best).toBeNull();
    const again = makeFakeBench(db, plan);
    const r2 = await runResearchLoop(
      { db, runBenchmark: again.fn, researchAgent: fakeAgent(), clock: makeFakeClock() },
      { settings: settings({ maxExperiments: 1 }), paths: { configsRoot: configs, resultsDir: results } },
    );
    expect(again.calls.filter((c) => c.configId === 'baseline')).toHaveLength(0);
    expect(r2.best).toBeNull();
    expect(db.listExperiments().filter((e) => e.kind === 'baseline')).toHaveLength(1);
  });
});
