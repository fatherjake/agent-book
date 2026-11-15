// runBenchmark concurrency: parallel workers, index-ordered results, shared usage-limit wait,
// beforeRun stop and abort. Injected fakes only (no Docker, no models).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../runner/types.js';
import { runBenchmark, type ExperimentDeps, type UsageLimitHit } from '../../researcher/experiment.js';
import { openDb, USAGE_LIMIT_REASON, type Db } from '../../storage/db.js';
import { BASELINE_CONFIG, fakeCoding, fakeEval, makeTmp, rmTmp } from './helpers.js';

const cfg = { ...BASELINE_CONFIG, systemPrompt: 'x', skills: [], tools: [] } as unknown as AgentConfig;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runBenchmark concurrency', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  /** durations[i] = ms the i-th started coding run takes; limitOnCall = call numbers that hit the usage limit. */
  function deps(opts: { durations?: (n: number) => number; limitOnCall?: Set<number> } = {}) {
    let calls = 0;
    const st = { active: 0, maxActive: 0, starts: [] as number[] };
    const d: ExperimentDeps & { st: typeof st } = {
      st,
      loadConfig: () => cfg,
      async runCodingAgent(o) {
        const n = calls++;
        st.active++;
        st.maxActive = Math.max(st.maxActive, st.active);
        st.starts.push(n);
        await tick(opts.durations ? opts.durations(n) : 20);
        st.active--;
        const runDir = join(dir, 'runs', o.runId!);
        mkdirSync(join(runDir, 'app'), { recursive: true });
        writeFileSync(join(runDir, 'app', 'package.json'), '{}');
        const limited = opts.limitOnCall?.has(n);
        const c = fakeCoding({ runId: o.runId, tokens: 1000 + n, status: limited ? 'infra_error' : 'completed' });
        if (limited) c.failureReason = `${USAGE_LIMIT_REASON}: test`;
        c.seed = o.seed;
        c.artifacts = { appSnapshotDir: join(runDir, 'app'), traceFile: join(runDir, 't.jsonl'), usageFile: join(runDir, 'u.jsonl'), configSnapshotDir: join(runDir, 'config') };
        return c;
      },
      async evaluateRun(o) {
        return fakeEval({ runId: o.runId, passed: true });
      },
    };
    return d;
  }

  it('runs up to `concurrency` at once and returns results in index order', async () => {
    // Run 0 is slowest, so completion order differs from index order.
    const d = deps({ durations: (n) => (n === 0 ? 120 : 20) });
    const t0 = Date.now();
    const res = await runBenchmark({ configId: 'baseline', runs: 5, phase: 'verify', db, deps: d, concurrency: 3, staggerMs: 0, seeds: [10, 11, 12, 13, 14] });
    expect(res).toHaveLength(5);
    expect(d.st.maxActive).toBe(3);
    expect(res.map((r) => r.coding.seed)).toEqual([10, 11, 12, 13, 14]);
    expect(Date.now() - t0).toBeLessThan(5 * 20 + 120); // faster than sequential
    expect(db.listRuns()).toHaveLength(5);
    expect(new Set(res.map((r) => r.coding.runId)).size).toBe(5);
  });

  it('concurrency 1 stays sequential; concurrency is capped at the run count', async () => {
    const d1 = deps();
    await runBenchmark({ configId: 'baseline', runs: 3, db, deps: d1 });
    expect(d1.st.maxActive).toBe(1);
    const d2 = deps();
    await runBenchmark({ configId: 'baseline', runs: 2, db, deps: d2, concurrency: 8, staggerMs: 0 });
    expect(d2.st.maxActive).toBe(2);
  });

  it('concurrent usage-limit hits share ONE wait, then retry the same indices', async () => {
    // Calls 0 and 1 both hit the limit at about the same time.
    const d = deps({ limitOnCall: new Set([0, 1]) });
    const hits: UsageLimitHit[] = [];
    const res = await runBenchmark({
      configId: 'baseline',
      runs: 3,
      db,
      deps: d,
      concurrency: 3,
      staggerMs: 0,
      seeds: [1, 2, 3],
      onUsageLimit: async (h) => {
        hits.push(h);
        await tick(30);
        return true;
      },
    });
    expect(hits).toHaveLength(1);
    expect(res).toHaveLength(3);
    expect(res.every((r) => r.passed)).toBe(true);
    expect(res.map((r) => r.coding.seed)).toEqual([1, 2, 3]);
    expect(db.listRuns()).toHaveLength(5); // 2 usage-limited rows kept + 3 good
  });

  it('a stale hit (run started before a completed wait) retries without a second wait', async () => {
    // Call 0 hits fast; call 1 is slow and also hits, but only reports after the wait for call 0 finished.
    const d = deps({ limitOnCall: new Set([0, 1]), durations: (n) => (n === 0 ? 5 : n === 1 ? 80 : 10) });
    const hits: UsageLimitHit[] = [];
    const res = await runBenchmark({
      configId: 'baseline',
      runs: 2,
      db,
      deps: d,
      concurrency: 2,
      staggerMs: 0,
      onUsageLimit: async (h) => {
        hits.push(h);
        await tick(20);
        return true;
      },
    });
    expect(hits).toHaveLength(1);
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.passed)).toBe(true);
  });

  it('a declined usage-limit wait stops the whole batch', async () => {
    const d = deps({ limitOnCall: new Set([0]), durations: (n) => (n === 0 ? 5 : 60) });
    const res = await runBenchmark({ configId: 'baseline', runs: 6, db, deps: d, concurrency: 2, staggerMs: 0, onUsageLimit: async () => false });
    expect(res.length).toBeLessThan(6);
    expect(d.st.starts.length).toBeLessThan(6);
  });

  it('beforeRun=false stops new runs; in-flight runs still finish and are returned', async () => {
    const d = deps({ durations: () => 30 });
    let n = 0;
    const res = await runBenchmark({ configId: 'baseline', runs: 6, db, deps: d, concurrency: 2, staggerMs: 0, beforeRun: () => n++ < 3 });
    expect(res).toHaveLength(3);
    expect(db.listRuns().every((r) => r.status === 'completed')).toBe(true);
  });

  it('abort stops starting new runs (including during the stagger delay)', async () => {
    const d = deps({ durations: () => 40 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const res = await runBenchmark({ configId: 'baseline', runs: 5, db, deps: d, concurrency: 3, staggerMs: 1000, signal: ctrl.signal });
    expect(d.st.starts.length).toBe(1);
    expect(res.length).toBeLessThanOrEqual(1);
  });
});
