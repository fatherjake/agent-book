// runBenchmark tests with INJECTED FAKE runner/evaluator (no Docker, no models).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, UsageRecord } from '../../runner/types.js';
import { runBenchmark, summarize, type ExperimentDeps } from '../../researcher/experiment.js';
import { openDb, type Db } from '../../storage/db.js';
import { BASELINE_CONFIG, fakeCoding, fakeEval, makeTmp, rmTmp } from './helpers.js';

const cfg = { ...BASELINE_CONFIG, systemPrompt: 'x', skills: [], tools: [] } as unknown as AgentConfig;

describe('runBenchmark (fake deps)', () => {
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

  function deps(behaviour: (i: number) => 'pass' | 'fail' | 'noapp' | 'throw' | 'limit'): ExperimentDeps & { seenLimits: number[]; evals: number } {
    let i = 0;
    const d = {
      seenLimits: [] as number[],
      evals: 0,
      loadConfig: () => cfg,
      async runCodingAgent(o: Parameters<ExperimentDeps['runCodingAgent']>[0]) {
        const b = behaviour(i++);
        d.seenLimits.push(o.limitsOverride?.maxTotalTokens ?? -1);
        expect(o.config.limits.maxTotalTokens).toBe(cfg.limits.maxTotalTokens); // config never mutated
        if (b === 'throw') throw new Error('docker exploded');
        const runDir = join(dir, 'runs', o.runId!);
        const c = fakeCoding({ runId: o.runId, tokens: 1000 + i, status: b === 'limit' ? 'limit_exceeded' : 'completed', costUsd: 0.1 });
        c.artifacts = { appSnapshotDir: join(runDir, 'app'), traceFile: join(runDir, 'trace.jsonl'), usageFile: join(runDir, 'usage.jsonl'), configSnapshotDir: join(runDir, 'config') };
        mkdirSync(join(runDir, 'config'), { recursive: true });
        writeFileSync(join(runDir, 'trace.jsonl'), '{}\n');
        const rec: UsageRecord = { id: `u-${o.runId}`, role: 'coding', runId: o.runId, provider: 'mock', model: 'm', timestamp: new Date().toISOString(), inputTokens: 1000, outputTokens: 0, reasoningTokens: 0, reasoningIncludedInOutput: true, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000, costUsd: 0.1, costEstimated: true, usageEstimated: false, purpose: 'agent-turn', raw: null };
        writeFileSync(join(runDir, 'usage.jsonl'), JSON.stringify(rec) + '\n');
        if (b !== 'noapp') {
          mkdirSync(join(runDir, 'app'), { recursive: true });
          writeFileSync(join(runDir, 'app', 'package.json'), '{}');
        }
        (c as { _b?: string })._b = b;
        return c;
      },
      async evaluateRun(o: Parameters<ExperimentDeps['evaluateRun']>[0]) {
        d.evals++;
        mkdirSync(join(o.outDir!, 'screenshots'), { recursive: true });
        writeFileSync(join(o.outDir!, 'report.json'), '{}');
        writeFileSync(join(o.outDir!, 'screenshots', 'desktop.png'), 'png');
        const e = fakeEval({ runId: o.runId, passed: behaviour(i - 1) === 'pass' });
        e.reportFile = join(o.outDir!, 'report.json');
        return e;
      },
    };
    return d;
  }

  it('persists runs, evaluations, usage records and artifacts; continues after failures', async () => {
    const seq = ['pass', 'throw', 'noapp', 'fail', 'limit'] as const;
    const d = deps((i) => seq[i]);
    const res = await runBenchmark({ configId: 'baseline', runs: 5, phase: 'verify', experimentId: undefined, db, deps: d, maxTokensPerRun: 500_000 });
    expect(res).toHaveLength(5);
    expect(res.map((r) => r.passed)).toEqual([true, false, false, false, false]);
    expect(res[1].coding.status).toBe('infra_error');
    expect(res[1].error).toContain('docker exploded');
    expect(res[2].error).toContain('no app');
    expect(res[4].error).toContain('limit_exceeded');
    expect(d.evals).toBe(2); // only completed runs with an app are evaluated
    expect(d.seenLimits.every((l) => l === 500_000)).toBe(true);
    const runs = db.listRuns();
    expect(runs).toHaveLength(5);
    expect(runs.map((r) => r.status)).toEqual(['completed', 'infra_error', 'completed', 'completed', 'limit_exceeded']);
    expect(db.listUsageRecords({ role: 'coding' })).toHaveLength(4);
    const arts = db.listArtifacts({ runId: res[0].coding.runId });
    expect(arts.map((a) => a.kind).sort()).toEqual(['app-snapshot', 'config-snapshot', 'eval-report', 'screenshot', 'trace', 'usage']);
    expect(arts.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    // seeds are deterministic and recorded
    expect(new Set(runs.map((r) => r.seed)).size).toBe(5);
  });

  it('stops when beforeRun returns false or the signal aborts', async () => {
    const d = deps(() => 'pass');
    const res = await runBenchmark({ configId: 'baseline', runs: 5, db, deps: d, beforeRun: (i) => i < 2 });
    expect(res).toHaveLength(2);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await runBenchmark({ configId: 'baseline', runs: 3, db, deps: d, signal: ctrl.signal })).toHaveLength(0);
  });

  it('summarize: median/mean/variance, all-pass requirement, mock never qualifies', () => {
    const mk = (tokens: number, passed: boolean, mock = false) => ({ coding: fakeCoding({ tokens, mock }), evaluation: fakeEval({ runId: 'x', passed, visual: 96 }), passed });
    const s = summarize([mk(100, true), mk(300, true), mk(200, true)], 'c');
    expect(s).toMatchObject({ runs: 3, passes: 3, medianTokens: 200, meanTokens: 200, meetsQualityRequirements: true, medianVisualScore: 96 });
    expect(s.tokenVariance).toBeCloseTo(6666.67, 1);
    expect(summarize([mk(100, true), mk(50, false)]).meetsQualityRequirements).toBe(false);
    const m = summarize([mk(100, true, true)]);
    expect(m.meetsQualityRequirements).toBe(false);
    expect(m.usedMockProvider).toBe(true);
    expect(summarize([]).meetsQualityRequirements).toBe(false);
  });
});
