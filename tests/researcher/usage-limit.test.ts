/**
 * Subscription usage-limit handling + token budgets, with INJECTED MOCKS ONLY: fake runCodingAgent /
 * evaluateRun (fabricated results, no Docker, no models), a fake research agent and a fake clock.
 * Nothing here is a real measurement.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, CodingRunResult } from '../../runner/types.js';
import { runBenchmark, type ExperimentDeps, type RunBenchmarkOptions } from '../../researcher/experiment.js';
import { runResearchLoop, type LoopDeps } from '../../researcher/loop.js';
import { ResearchProposalError, type ResearchAgent } from '../../researcher/research-agent.js';
import { DEFAULT_RESEARCH_SETTINGS, type ResearchSettings } from '../../researcher/settings.js';
import { openDb, type Db } from '../../storage/db.js';
import { fakeCoding, fakeEval, makeConfigsRoot, makeFakeBench, makeFakeClock, makeTmp, rmTmp } from './helpers.js';

type Clock = ReturnType<typeof makeFakeClock>;

/** FAKE research agent (unique system-prompt per proposal); `throwFirst` errors are thrown first. */
function fakeAgent(throwFirst: Error[] = []): ResearchAgent & { calls: number } {
  const a = {
    calls: 0,
    async propose() {
      a.calls++;
      const e = throwFirst.shift();
      if (e) throw e;
      return { proposal: { hypothesis: `fake hypothesis ${a.calls}`, changeSummary: `fake change ${a.calls}`, files: { 'system-prompt.md': `FAKE PROMPT v${a.calls}\n` } }, usage: [], attempts: 1 };
    },
  };
  return a;
}

const settings = (o: Partial<ResearchSettings> = {}): ResearchSettings => ({
  ...DEFAULT_RESEARCH_SETTINGS,
  verificationRuns: 2,
  maxExperiments: 0,
  quickRunMaxTokenRatio: null,
  holdout: { onPromotion: false, runs: 1 },
  pausePollSec: 60,
  usageLimitMarginSec: 120,
  ...o,
});

describe('subscription usage limits (fake runner/evaluator, fake clock)', () => {
  let dir: string;
  let configs: string;
  let results: string;
  let appDir: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    configs = makeConfigsRoot(dir);
    results = join(dir, 'results');
    appDir = join(dir, 'fake-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), '{}');
    db = openDb(join(results, 'benchmark.db'));
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  /**
   * FAKE runner deps. `limitOn(callNo)` returns 'coding' | 'evaluator' to make that call hit the
   * usage limit with the given reset time.
   */
  function fakeDeps(clock: Clock, limitOn: (n: number) => { source: 'coding' | 'evaluator'; resetInMs: number | null } | null, onCoding?: (n: number) => void) {
    let n = 0;
    const calls: number[] = [];
    const deps: ExperimentDeps = {
      loadConfig: (id) => ({ id, provider: 'anthropic', model: 'claude-sonnet-5-5' }) as AgentConfig,
      async runCodingAgent(o) {
        const no = ++n;
        calls.push(clock.t);
        onCoding?.(no);
        const hit = limitOn(no);
        const c = fakeCoding({ runId: o.runId, configId: o.config.id, tokens: 1000, experimentId: o.experimentId });
        c.artifacts.appSnapshotDir = appDir;
        if (hit?.source === 'coding') {
          return {
            ...c,
            status: 'infra_error',
            failureReason: 'usage_limit',
            ...(hit.resetInMs !== null ? { usageLimitResetAt: new Date(clock.t + hit.resetInMs).toISOString() } : {}),
          } as CodingRunResult;
        }
        return c;
      },
      async evaluateRun(o) {
        const hit = limitOn(n);
        const ev = fakeEval({ runId: o.runId, passed: !hit, browserAgentSkipped: false });
        if (hit?.source === 'evaluator') {
          return { ...ev, evaluatorFailure: true, usageLimitResetAt: hit.resetInMs !== null ? new Date(clock.t + hit.resetInMs).toISOString() : '' };
        }
        return ev;
      },
    };
    return { deps, calls };
  }

  const loop = (clock: Clock, deps: ExperimentDeps, agent: ResearchAgent, s: ResearchSettings, signal?: AbortSignal) =>
    runResearchLoop(
      { db, runBenchmark: (o: RunBenchmarkOptions) => runBenchmark({ ...o, deps }), researchAgent: agent, clock } as LoopDeps,
      { settings: s, paths: { configsRoot: configs, resultsDir: results }, signal },
    );

  it('runBenchmark: a usage-limited run is persisted but not returned; the same index is retried', async () => {
    const clock = makeFakeClock();
    const { deps } = fakeDeps(clock, (n) => (n === 1 ? { source: 'coding', resetInMs: 1000 } : n === 2 ? { source: 'evaluator', resetInMs: 1000 } : null));
    const hits: unknown[] = [];
    const exp = db.insertExperiment({ kind: 'manual', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'h', provider: 'anthropic', model: 'm', status: 'verifying' });
    const res = await runBenchmark({ configId: 'baseline', runs: 1, phase: 'verify', db, experimentId: exp.id, deps, onUsageLimit: async (h) => (hits.push(h.source), true) });
    expect(hits).toEqual(['coding', 'evaluator']);
    expect(res).toHaveLength(1);
    expect(res[0].passed).toBe(true);
    const rows = db.listRuns({ experimentId: exp.id });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.failureReason?.startsWith('usage_limit'))).toHaveLength(2);
    // Usage-limited runs never count toward pass rates.
    const item = db.listExperiments().find((e) => e.id === exp.id) as unknown as { id: string };
    expect(item).toBeTruthy();
    const detail = db.getExperimentDetail(exp.id);
    if (detail) {
      expect(detail.experiment.verifyPasses).toBe(1);
      expect(detail.experiment.passRate).toBe(1);
    }
  });

  it('loop: waits until reset + margin, retries the same run, does not count a failure, excludes the wait from active time', async () => {
    const clock = makeFakeClock();
    const HOUR = 3600_000;
    const { deps, calls } = fakeDeps(clock, (n) => (n === 2 ? { source: 'coding', resetInMs: HOUR } : null));
    const res = await loop(clock, deps, fakeAgent(), settings());
    expect(res.stopReason).toBe('max_experiments');
    expect(res.best?.configId).toBe('baseline'); // 2/2 verification runs passed despite the limit hit
    expect(calls).toHaveLength(3);
    expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(HOUR + 120_000);
    const waits = db.listUsageLimitWaits({ sessionId: res.sessionId });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ source: 'coding', outcome: 'resumed', plannedMs: HOUR + 120_000 });
    expect(waits[0].waitedMs).toBe(HOUR + 120_000);
    expect(res.usageLimitWaitMs).toBe(HOUR + 120_000);
    const session = db.getSession(res.sessionId)!;
    expect(session.activeMs).toBeLessThan(HOUR); // the wait is not active research time
    const baseline = db.listExperiments().find((e) => e.kind === 'baseline')!;
    expect(baseline.status).toBe('completed');
    expect(baseline.outcome).toBe('baseline');
  });

  it('loop: evaluator usage limit with unknown reset uses the fallback wait and retries', async () => {
    const clock = makeFakeClock();
    const { deps, calls } = fakeDeps(clock, (n) => (n === 1 ? { source: 'evaluator', resetInMs: null } : null));
    const res = await loop(clock, deps, fakeAgent(), settings({ usageLimitUnknownResetWaitSec: 900 }));
    expect(res.best?.configId).toBe('baseline');
    expect(calls).toHaveLength(3);
    const waits = db.listUsageLimitWaits();
    expect(waits[0]).toMatchObject({ source: 'evaluator', resetAt: null, plannedMs: 900_000, outcome: 'resumed' });
  });

  it('loop: a reset further away than maxUsageLimitWaitSec stops the loop with usage_limit (no failure recorded)', async () => {
    const clock = makeFakeClock();
    const { deps, calls } = fakeDeps(clock, (n) => (n === 1 ? { source: 'coding', resetInMs: 10 * 3600_000 } : null));
    const res = await loop(clock, deps, fakeAgent(), settings({ maxUsageLimitWaitSec: 3600 }));
    expect(res.stopReason).toBe('usage_limit');
    expect(calls).toHaveLength(1);
    const baseline = db.listExperiments().find((e) => e.kind === 'baseline')!;
    expect(baseline.status).toBe('interrupted');
    expect(baseline.outcome).toBeNull();
    expect(db.listUsageLimitWaits()[0].outcome).toBe('gave_up');
  });

  it('loop: SIGINT during the wait interrupts it promptly', async () => {
    const ctrl = new AbortController();
    let sleeps = 0;
    const clock = makeFakeClock(() => {
      if (++sleeps === 2) ctrl.abort();
    });
    const { deps, calls } = fakeDeps(clock, (n) => (n === 1 ? { source: 'coding', resetInMs: 3600_000 } : null));
    const res = await loop(clock, deps, fakeAgent(), settings({ pausePollSec: 60 }), ctrl.signal);
    expect(res.stopReason).toBe('interrupted');
    expect(calls).toHaveLength(1);
    expect(sleeps).toBe(2); // stopped polling right after the abort (the wait was ~62 polls long)
    const w = db.listUsageLimitWaits()[0];
    expect(w.outcome).toBe('interrupted');
    expect(w.waitedMs).toBe(120_000);
  });

  it('loop: the pause file holds the retry after the reset until it is removed', async () => {
    const pauseFile = join(results, 'research.pause');
    let resetAt = 0;
    const clock = makeFakeClock(() => {
      if (resetAt && clock.t > resetAt + 30 * 60_000 && existsSync(pauseFile)) rmSync(pauseFile);
    });
    const { deps, calls } = fakeDeps(
      clock,
      (n) => (n === 1 ? { source: 'coding', resetInMs: 600_000 } : null),
      (n) => {
        if (n === 1) {
          resetAt = clock.t + 600_000;
          mkdirSync(results, { recursive: true });
          writeFileSync(pauseFile, '');
        }
      },
    );
    const res = await loop(clock, deps, fakeAgent(), settings());
    expect(res.best?.configId).toBe('baseline');
    expect(calls[1]).toBeGreaterThan(resetAt + 30 * 60_000);
  });

  it('loop: a research proposal hitting the usage limit is retried and not counted as a proposal failure', async () => {
    const clock = makeFakeClock();
    const { deps } = fakeDeps(clock, () => null);
    const limitErr = () => new ResearchProposalError('usage limit', [], [], new Date(clock.t + 600_000).toISOString());
    const agent = fakeAgent([limitErr(), limitErr(), limitErr()]);
    const res = await loop(clock, deps, agent, settings({ maxExperiments: 1, maxConsecutiveProposalFailures: 1 }));
    expect(res.stopReason).toBe('max_experiments');
    expect(agent.calls).toBe(4);
    const cand = db.listExperiments().filter((e) => e.kind === 'candidate');
    expect(cand).toHaveLength(1);
    expect(cand[0].status).not.toBe('failed');
    expect(cand[0].candidateConfigId).toBe('experiments/001');
    const waits = db.listUsageLimitWaits();
    expect(waits.map((w) => [w.source, w.outcome])).toEqual([
      ['research', 'resumed'],
      ['research', 'resumed'],
      ['research', 'resumed'],
    ]);
  });
});

describe('token budgets (fake runBenchmark)', () => {
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

  const run = (s: ResearchSettings) => {
    const bench = makeFakeBench(db, () => ({ passed: true, tokens: 1000 }));
    return runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: fakeAgent(), clock: makeFakeClock() },
      { settings: s, paths: { configsRoot: configs, resultsDir: results } },
    );
  };

  it('maxTotalTokens (all roles) stops the loop', async () => {
    // baseline: 2 runs × (1000 coding + 100 evaluator) = 2200 tokens
    const res = await run(settings({ maxExperiments: 10, maxTotalTokens: 2200 }));
    expect(res.stopReason).toBe('max_total_tokens');
    expect(res.totalTokens).toBe(2200);
    expect(db.listExperiments().filter((e) => e.kind === 'candidate')).toHaveLength(0);
  });

  it('maxCodingTokens stops the loop and counts coding tokens only', async () => {
    const res = await run(settings({ maxExperiments: 10, maxCodingTokens: 3000, maxTotalTokens: 1_000_000 }));
    expect(res.stopReason).toBe('max_coding_tokens');
    expect(db.sessionTokens(res.sessionId).coding).toBe(3000);
  });

  it('a null API-equivalent cost budget never stops the loop', async () => {
    const res = await run(settings({ maxExperiments: 1, maxResearchCostUsd: null }));
    expect(res.stopReason).toBe('max_experiments');
  });
});
