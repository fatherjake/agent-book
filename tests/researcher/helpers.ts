/**
 * TEST FIXTURES — FAKE / MOCK DATA ONLY.
 * Everything here fabricates CodingRunResult / EvaluationResult objects for infrastructure tests.
 * None of it is a real benchmark measurement.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodingRunResult, EvaluationResult, TokenTotals } from '../../runner/types.js';
import type { Db, RunPhase } from '../../storage/db.js';
import type { BenchmarkRunResult, RunBenchmarkOptions } from '../../researcher/experiment.js';
import type { Clock } from '../../researcher/loop.js';

let counter = 0;

export function fakeTotals(tokens: number, costUsd = 0): TokenTotals {
  return {
    inputTokens: Math.round(tokens * 0.7),
    outputTokens: tokens - Math.round(tokens * 0.7),
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: tokens,
    costUsd,
    modelCalls: 3,
    anyEstimated: false,
  };
}

export function fakeCoding(o: { runId?: string; configId?: string; tokens?: number; status?: CodingRunResult['status']; mock?: boolean; costUsd?: number; experimentId?: string }): CodingRunResult {
  const runId = o.runId ?? `fake-run-${++counter}`;
  return {
    runId,
    experimentId: o.experimentId,
    configId: o.configId ?? 'baseline',
    seed: 1,
    status: o.status ?? 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1000,
    imageId: 'sha256:fake',
    starterHash: 'fakehash',
    configHash: 'fakecfghash',
    usage: fakeTotals(o.tokens ?? 1000, o.costUsd ?? 0),
    toolCalls: 5,
    artifacts: {
      appSnapshotDir: `/nonexistent/${runId}/app`,
      traceFile: `/nonexistent/${runId}/trace.jsonl`,
      usageFile: `/nonexistent/${runId}/usage.jsonl`,
      configSnapshotDir: `/nonexistent/${runId}/config`,
    },
    usedMockProvider: o.mock ?? false,
  };
}

export function fakeEval(o: { runId: string; passed: boolean; suite?: 'dev' | 'holdout'; visual?: number; checks?: EvaluationResult['checks']; evaluatorFailure?: boolean; costUsd?: number; browserAgentSkipped?: boolean }): EvaluationResult {
  return {
    runId: o.runId,
    suite: o.suite ?? 'dev',
    seed: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    appStarted: true,
    checks: o.checks ?? [
      { id: 'api.create.valid', category: 'backend', mandatory: true, outcome: o.passed ? 'pass' : 'fail', message: o.passed ? undefined : 'expected 201, got 500', attempts: 1 },
    ],
    visualScore: o.visual ?? 97,
    visualThreshold: 95,
    passed: o.passed,
    evaluatorFailure: o.evaluatorFailure ?? false,
    evaluatorUsage: fakeTotals(100, o.costUsd ?? 0),
    reportFile: `/nonexistent/${o.runId}/eval/report.json`,
    ...(o.browserAgentSkipped !== undefined ? { browserAgentSkipped: o.browserAgentSkipped } : {}),
  };
}

export interface PlannedRun {
  passed: boolean;
  tokens: number;
  costUsd?: number;
  mock?: boolean;
  checks?: EvaluationResult['checks'];
  /** Evaluation skipped the browser agent (default: the batch's skipBrowserAgent option). */
  noBrowser?: boolean;
}

export type Plan = (configId: string, phase: RunPhase, index: number) => PlannedRun;

export interface FakeBench {
  fn: (o: RunBenchmarkOptions) => Promise<BenchmarkRunResult[]>;
  calls: RunBenchmarkOptions[];
}

/** FAKE runBenchmark: fabricates results from a plan and persists them to the DB like the real one. */
export function makeFakeBench(db: Db, plan: Plan, hooks: { onRun?: (o: RunBenchmarkOptions, i: number) => void } = {}): FakeBench {
  const calls: RunBenchmarkOptions[] = [];
  const fn = async (o: RunBenchmarkOptions) => {
    calls.push(o);
    const out: BenchmarkRunResult[] = [];
    const phase = o.phase ?? 'manual';
    for (let i = 0; i < o.runs; i++) {
      if (o.signal?.aborted) break;
      if (o.beforeRun && (await o.beforeRun(i)) === false) break;
      hooks.onRun?.(o, i);
      if (o.signal?.aborted) break;
      const p = plan(o.configId, phase, i);
      const runId = `fake-${o.configId.replace('/', '-')}-${phase}-${i}-${++counter}`;
      const coding = fakeCoding({ runId, configId: o.configId, tokens: p.tokens, mock: p.mock ?? o.provider?.isMock, costUsd: p.costUsd, experimentId: o.experimentId });
      const evaluation = fakeEval({ runId, passed: p.passed, suite: o.suite ?? 'dev', checks: p.checks, browserAgentSkipped: p.noBrowser ?? o.skipBrowserAgent });
      const passed = p.passed;
      if (o.db) {
        o.db.insertRunStart({ runId, experimentId: o.experimentId, configId: o.configId, seed: 1, phase, suite: o.suite ?? 'dev', usedMockProvider: coding.usedMockProvider });
        o.db.finishRun(runId, coding, passed);
        o.db.insertEvaluation(evaluation);
      }
      out.push({ coding, evaluation, passed });
    }
    return out;
  };
  return { fn, calls };
}

export function makeFakeClock(onSleep?: (ms: number) => void): Clock & { t: number; sleeps: number } {
  const c = {
    t: 1_700_000_000_000,
    sleeps: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps++;
      c.t += ms;
      onSleep?.(ms);
    },
  };
  return c;
}

export function makeTmp(prefix = 'frugal-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** rm -rf that first restores write permissions (candidate configs are read-only). */
export function rmTmp(dir: string): void {
  if (!existsSync(dir)) return;
  const fix = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const e of readdirSync(p)) fix(join(p, e));
    } else chmodSync(p, 0o644);
  };
  fix(dir);
  rmSync(dir, { recursive: true, force: true });
}

export const BASELINE_CONFIG = {
  id: 'baseline',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  maxOutputTokensPerCall: 8000,
  promptCaching: true,
  designDelivery: 'inline-image',
  inlineSpecFiles: ['requirements.md'],
  context: { strategy: 'none' },
  limits: { maxTotalTokens: 2000000, maxModelCalls: 200, maxRuntimeSec: 1800 },
};

export const BASELINE_TOOLS = [
  { name: 'read_file', enabled: true },
  { name: 'write_file', enabled: true },
  { name: 'run_command', enabled: true, timeoutSec: 120 },
];

export function makeConfigsRoot(root: string): string {
  const configs = join(root, 'configs');
  mkdirSync(join(configs, 'baseline', 'skills'), { recursive: true });
  mkdirSync(join(configs, 'experiments'), { recursive: true });
  writeFileSync(join(configs, 'baseline', 'config.json'), JSON.stringify(BASELINE_CONFIG, null, 2) + '\n');
  writeFileSync(join(configs, 'baseline', 'system-prompt.md'), 'You are a coding agent.\nBuild the todo app.\nBe efficient.\n');
  writeFileSync(join(configs, 'baseline', 'tools.json'), JSON.stringify(BASELINE_TOOLS, null, 2) + '\n');
  writeFileSync(join(configs, 'baseline', 'skills', 'api.md'), '# API skill\nUse express.\n');
  return configs;
}
