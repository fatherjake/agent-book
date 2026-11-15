/**
 * runBenchmark: execute N coding runs of one config (up to `concurrency` at a time), evaluate each
 * app snapshot, and persist runs / evaluations / usage records / artifacts. One failing run never
 * stops the batch. Every run has its own containers, network, gateway and ports, so runs are
 * independent; results are returned in index order regardless of completion order.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentConfig, CodingRunResult, EvaluationResult, ModelProvider, RunLimits, TokenTotals, UsageRecord } from '../runner/types.js';
import { logger } from '../runner/logger.js';
import { REPO_ROOT, resultsDir } from '../runner/env.js';
import { isUsageLimitRun, mean, median, USAGE_LIMIT_REASON, variance, type Db, type RunPhase, type StoredSummary, type Suite, type UsageLimitSource } from '../storage/db.js';

const log = logger('experiment');

export interface ExperimentDeps {
  loadConfig(id: string): AgentConfig;
  runCodingAgent(opts: {
    config: AgentConfig;
    runId?: string;
    experimentId?: string;
    seed: number;
    provider?: ModelProvider;
    signal?: AbortSignal;
    limitsOverride?: Partial<RunLimits>;
  }): Promise<CodingRunResult>;
  evaluateRun(opts: {
    runId: string;
    appDir: string;
    suite: Suite;
    seed: number;
    provider?: ModelProvider;
    skipBrowserAgent?: boolean;
    outDir?: string;
  }): Promise<EvaluationResult>;
}

export interface RunBenchmarkOptions {
  configId: string;
  runs: number;
  suite?: Suite;
  phase?: RunPhase;
  experimentId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Override the config's provider for the coding agent (e.g. mock). */
  provider?: ModelProvider;
  /**
   * Fresh coding provider per run (takes precedence over `provider`). Needed for stateful scripted
   * providers such as the mock, whose script would otherwise be exhausted after the first run.
   */
  providerFactory?: () => ModelProvider;
  /** Provider for the evaluator's browser agent (default: evaluator decides). */
  evaluatorProvider?: ModelProvider;
  skipBrowserAgent?: boolean;
  /** Per-run coding token cap, passed to runCodingAgent as limitsOverride (min with config limit; config hash unchanged). */
  maxTokensPerRun?: number | null;
  db?: Db;
  /** Explicit seeds (default: deterministic from experiment/config, phase and index). */
  seeds?: number[];
  /** Called before each run; return false to stop the batch (pause/budget hooks). */
  beforeRun?: (index: number) => Promise<boolean | void> | boolean | void;
  onRunComplete?: (r: BenchmarkRunResult, index: number) => void;
  /**
   * Called when a run hit a Claude subscription usage limit (coding or evaluator). The run is
   * persisted (failure_reason 'usage_limit…', excluded from summaries) but NOT returned in the
   * results. Return true to retry the same run index (after waiting), false to stop the batch.
   * Without this hook, usage-limited runs are returned like any other failed run.
   */
  onUsageLimit?: (hit: UsageLimitHit) => Promise<boolean>;
  /**
   * Runs executed at the same time (default 1 = sequential). Budget/pause checks (`beforeRun`) happen
   * before each run starts, so a budget can be overshot by up to concurrency-1 in-flight runs.
   * Concurrent usage-limit hits share ONE `onUsageLimit` wait; no new run starts while it is pending.
   */
  concurrency?: number;
  /** Delay between starting the first runs of a concurrent batch (ms, default 3000): avoids a Docker start-up stampede. */
  staggerMs?: number;
  /** Sleep used for the stagger (injectable for fake clocks; default real timers, abortable). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  deps?: Partial<ExperimentDeps>;
}

export interface UsageLimitHit {
  source: UsageLimitSource;
  /** ISO reset time, or null when the gateway reported none. */
  resetAt: string | null;
  runId: string;
  index: number;
  experimentId?: string;
}

/** Did this run stop because the Claude subscription hit its usage limit? */
export function usageLimitOf(r: Pick<BenchmarkRunResult, 'coding' | 'evaluation'>): { source: UsageLimitSource; resetAt: string | null } | null {
  const c = r.coding as CodingRunResult & { usageLimitResetAt?: string };
  if (c.status === 'infra_error' && isUsageLimitRun(c.failureReason)) return { source: 'coding', resetAt: c.usageLimitResetAt || null };
  if (r.evaluation && r.evaluation.usageLimitResetAt !== undefined) return { source: 'evaluator', resetAt: r.evaluation.usageLimitResetAt || null };
  return null;
}

export interface BenchmarkRunResult {
  coding: CodingRunResult;
  evaluation: EvaluationResult | null;
  /** coding completed AND evaluation passed AND no evaluator failure. */
  passed: boolean;
  error?: string;
}

let defaultDeps: ExperimentDeps | null = null;
async function loadDefaultDeps(): Promise<ExperimentDeps> {
  if (defaultDeps) return defaultDeps;
  const [run, evaluator, config] = await Promise.all([
    import('../runner/run.js'),
    import('../evaluator/index.js'),
    import('../runner/config.js'),
  ]);
  defaultDeps = {
    loadConfig: (id) => config.loadConfig(id),
    runCodingAgent: (o) => run.runCodingAgent(o),
    evaluateRun: (o) => evaluator.evaluateRun(o),
  };
  return defaultDeps;
}

export function deterministicSeed(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) & 0x7fffffff;
}

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `run-${ts}-${randomBytes(3).toString('hex')}`;
}

const emptyTotals = (): TokenTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  modelCalls: 0,
  anyEstimated: false,
});

export function readUsageFile(path: string): UsageRecord[] {
  if (!path) return [];
  const p = abs(path);
  if (!existsSync(p)) return [];
  const out: UsageRecord[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === 'string' && typeof r.role === 'string') out.push(r);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

function totalsFromRecords(recs: UsageRecord[]): TokenTotals {
  const t = emptyTotals();
  for (const r of recs) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.reasoningTokens += r.reasoningTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheWriteTokens += r.cacheWriteTokens;
    t.totalTokens += r.totalTokens;
    t.costUsd += r.costUsd;
    t.modelCalls += 1;
    if (r.usageEstimated || r.costEstimated) t.anyEstimated = true;
  }
  return t;
}

/** sha256 + size of a file, or of a directory (sorted relpath+filehash list; node_modules skipped). */
export function hashPath(p: string): { sha256: string; bytes: number } | null {
  if (!existsSync(p)) return null;
  const st = statSync(p);
  if (st.isFile()) return { sha256: createHash('sha256').update(readFileSync(p)).digest('hex'), bytes: st.size };
  const h = createHash('sha256');
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const buf = readFileSync(full);
        bytes += buf.length;
        h.update(relative(p, full)).update('\0').update(createHash('sha256').update(buf).digest('hex')).update('\n');
      }
    }
  };
  walk(p);
  return { sha256: h.digest('hex'), bytes };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function hasApp(appDir: string): boolean {
  if (!appDir) return false;
  const d = abs(appDir);
  return existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length > 0;
}

/** Runner paths are relative to the repo root; resolve them independent of cwd. */
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const rel = (p: string) => relative(REPO_ROOT, abs(p)) || '.';

function registerArtifacts(db: Db, r: BenchmarkRunResult, experimentId: string | undefined, evalOutDir: string | null): void {
  const c = r.coding;
  const add = (kind: string, p: string | undefined) => {
    if (!p) return;
    try {
      const h = hashPath(abs(p));
      if (h) db.insertArtifact({ runId: c.runId, experimentId: experimentId ?? null, kind, path: rel(p), ...h });
    } catch (e) {
      log.warn('artifact hash failed', { path: p, error: String(e) });
    }
  };
  const runDir = c.artifacts.appSnapshotDir ? dirname(c.artifacts.appSnapshotDir) : null;
  add('trace', c.artifacts.traceFile);
  add('usage', c.artifacts.usageFile);
  add('config-snapshot', c.artifacts.configSnapshotDir);
  add('app-snapshot', c.artifacts.appSnapshotDir);
  if (runDir) add('run-json', join(runDir, 'run.json'));
  if (r.evaluation) {
    const reportFile = r.evaluation.reportFile;
    add('eval-report', reportFile);
    const outDir = evalOutDir ?? (reportFile ? dirname(reportFile) : null);
    for (const f of outDir ? listFiles(abs(outDir)) : []) {
      if (reportFile && f === abs(reportFile)) continue;
      const kind = /\.(png|jpe?g)$/i.test(f) ? 'screenshot' : /browser-trace/.test(f) ? 'browser-trace' : 'eval-file';
      add(kind, f);
    }
  }
}

/** Run `runs` benchmark runs of one config, `concurrency` at a time. Never throws for per-run failures. */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<BenchmarkRunResult[]> {
  const injected = opts.deps;
  const deps: ExperimentDeps =
    injected?.loadConfig && injected.runCodingAgent && injected.evaluateRun
      ? (injected as ExperimentDeps)
      : { ...(await loadDefaultDeps()), ...injected };
  const suite: Suite = opts.suite ?? 'dev';
  const phase: RunPhase = opts.phase ?? (suite === 'holdout' ? 'holdout' : 'manual');
  const db = opts.db;

  const config = deps.loadConfig(opts.configId);
  // Budget cap passed as a runner override (can only tighten); the config itself and its hash are untouched.
  const limitsOverride: Partial<RunLimits> | undefined =
    opts.maxTokensPerRun && opts.maxTokensPerRun > 0 ? { maxTotalTokens: opts.maxTokensPerRun } : undefined;

  const total = opts.runs;
  const concurrency = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 1), total || 1));
  const staggerMs = opts.staggerMs ?? 3000;

  /** One coding run + evaluation + persistence for index i. Never throws. */
  const runOne = async (i: number): Promise<{ result: BenchmarkRunResult; limitHit: ReturnType<typeof usageLimitOf>; runId: string }> => {
    const seed = opts.seeds?.[i] ?? deterministicSeed(`${opts.experimentId ?? opts.configId}:${phase}:${suite}:${i}`);
    const runId = newRunId();
    const runProvider = opts.providerFactory ? opts.providerFactory() : opts.provider;
    const usedMock = runProvider?.isMock ?? config.provider === 'mock';
    db?.insertRunStart({
      runId,
      experimentId: opts.experimentId ?? null,
      configId: opts.configId,
      seed,
      phase,
      suite,
      provider: runProvider?.name ?? config.provider,
      model: config.model,
      usedMockProvider: usedMock,
    });
    log.info('run start', { runId, configId: opts.configId, phase, suite, seed, index: i + 1, of: opts.runs });

    let result: BenchmarkRunResult;
    let evalOutDir: string | null = null;
    try {
      const coding = await deps.runCodingAgent({
        config,
        runId,
        experimentId: opts.experimentId,
        seed,
        provider: runProvider,
        signal: opts.signal,
        limitsOverride,
      });
      let evaluation: EvaluationResult | null = null;
      let error: string | undefined;
      if (coding.status === 'completed' && hasApp(coding.artifacts.appSnapshotDir)) {
        evalOutDir = join(dirname(abs(coding.artifacts.appSnapshotDir)), 'eval', suite);
        try {
          evaluation = await deps.evaluateRun({
            runId: coding.runId,
            appDir: abs(coding.artifacts.appSnapshotDir),
            suite,
            seed,
            provider: opts.evaluatorProvider,
            skipBrowserAgent: opts.skipBrowserAgent,
            outDir: evalOutDir,
          });
        } catch (e) {
          error = `evaluator crashed: ${(e as Error).message ?? String(e)}`;
          log.error('evaluateRun threw', { runId, error });
        }
      } else if (coding.status === 'completed') {
        error = 'coding run produced no app snapshot';
      } else {
        error = `coding run ended with status ${coding.status}${coding.failureReason ? `: ${coding.failureReason}` : ''}`;
      }
      const passed = coding.status === 'completed' && !!evaluation && evaluation.passed && !evaluation.evaluatorFailure;
      result = { coding, evaluation, passed, error };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log.error('runCodingAgent threw', { runId, error: msg });
      const runDir = join(resultsDir(), 'runs', runId);
      const usageFile = join(runDir, 'usage.jsonl');
      const recs = readUsageFile(usageFile);
      const now = new Date().toISOString();
      result = {
        coding: {
          runId,
          experimentId: opts.experimentId,
          configId: opts.configId,
          seed,
          status: opts.signal?.aborted ? 'interrupted' : 'infra_error',
          failureReason: msg,
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          imageId: '',
          starterHash: '',
          configHash: '',
          usage: totalsFromRecords(recs.filter((r) => r.role === 'coding')),
          toolCalls: 0,
          artifacts: {
            appSnapshotDir: join(runDir, 'app'),
            traceFile: join(runDir, 'trace.jsonl'),
            usageFile,
            configSnapshotDir: join(runDir, 'config'),
          },
          usedMockProvider: usedMock,
        },
        evaluation: null,
        passed: false,
        error: msg,
      };
    }

    const limitHit = usageLimitOf(result);
    if (limitHit) {
      result.passed = false;
      // Mark the run row so pass rates / summaries skip it (the evaluator case has a completed coding run).
      if (limitHit.source === 'evaluator')
        result = {
          ...result,
          coding: { ...result.coding, status: 'infra_error', failureReason: `${USAGE_LIMIT_REASON}: evaluator subscription usage limit reached during evaluation` },
        };
    }

    if (db) {
      try {
        // Keep the DB row's start time if the runner didn't give a real one.
        db.finishRun(runId, result.coding, result.passed);
        if (result.evaluation) db.insertEvaluation({ ...result.evaluation, runId });
        const coded = readUsageFile(result.coding.artifacts.usageFile);
        db.insertUsageRecords(coded, { sessionId: opts.sessionId ?? null, experimentId: opts.experimentId ?? null, runId });
        if (evalOutDir) {
          for (const f of listFiles(evalOutDir).filter((f) => /usage\.jsonl$/.test(f)))
            db.insertUsageRecords(readUsageFile(f), { sessionId: opts.sessionId ?? null, experimentId: opts.experimentId ?? null, runId });
        }
        registerArtifacts(db, result, opts.experimentId, evalOutDir);
      } catch (e) {
        log.error('failed to persist run', { runId, error: String(e) });
      }
    }
    log.info('run done', {
      runId,
      index: i + 1,
      of: total,
      status: result.coding.status,
      passed: result.passed,
      totalTokens: result.coding.usage.totalTokens,
      mock: result.coding.usedMockProvider,
    });
    return { result, limitHit, runId };
  };

  const slots: (BenchmarkRunResult | undefined)[] = new Array(total);
  let next = 0;
  let stopped = false;
  /** A pending usage-limit wait shared by every worker (resolves to "retry?"). */
  let limitWait: Promise<boolean> | null = null;
  /** Bumped each time a usage-limit wait finishes with "retry". */
  let waitGeneration = 0;

  /** Pause/budget gate before a run starts; false = stop the whole batch. */
  const gate = async (i: number): Promise<boolean> => {
    while (limitWait) {
      if (!(await limitWait)) return false;
    }
    if (stopped || opts.signal?.aborted) return false;
    if (opts.beforeRun) {
      const go = await opts.beforeRun(i);
      if (go === false) {
        log.info('benchmark batch stopped by beforeRun hook', { index: i });
        return false;
      }
    }
    return !(stopped || opts.signal?.aborted);
  };

  const worker = async (w: number) => {
    if (w > 0 && staggerMs > 0) await (opts.sleep ?? sleepAbortable)(w * staggerMs, opts.signal);
    while (!stopped) {
      if (opts.signal?.aborted) {
        log.warn('benchmark batch aborted before run', { index: next, configId: opts.configId });
        stopped = true;
        break;
      }
      if (next >= total) break;
      const i = next++;
      for (;;) {
        if (!(await gate(i))) {
          stopped = true;
          return;
        }
        const startedGen = waitGeneration;
        const { result, limitHit, runId } = await runOne(i);
        if (limitHit && opts.onUsageLimit) {
          log.warn('run hit the subscription usage limit', { runId, source: limitHit.source, resetAt: limitHit.resetAt });
          if (!limitWait && startedGen !== waitGeneration) {
            // Stale hit: this run started before a wait that has since completed; retry without waiting again.
            if (opts.signal?.aborted) {
              stopped = true;
              return;
            }
            continue;
          }
          if (!limitWait) {
            const p: Promise<boolean> = opts
              .onUsageLimit({ ...limitHit, runId, index: i, experimentId: opts.experimentId })
              .catch(() => false)
              .then((retry) => {
                if (retry) waitGeneration++;
                return retry;
              })
              .finally(() => {
                if (limitWait === p) limitWait = null;
              });
            limitWait = p;
          }
          const retry = await limitWait;
          if (retry && !opts.signal?.aborted) continue; // retry the same index (fresh run id)
          stopped = true;
          return;
        }
        slots[i] = result;
        opts.onRunComplete?.(result, i);
        break;
      }
    }
  };

  if (concurrency > 1) log.info('benchmark batch', { configId: opts.configId, runs: total, concurrency });
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  return slots.filter((r): r is BenchmarkRunResult => r !== undefined);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Aggregate a batch. meetsQualityRequirements only if every run passed, none used the mock provider
 * and none was evaluated without the LLM browser agent (skipBrowserAgent → incomplete evaluation).
 */
export function summarize(results: BenchmarkRunResult[], configId?: string): StoredSummary {
  const tokens = results.map((r) => r.coding.usage.totalTokens);
  const passes = results.filter((r) => r.passed).length;
  const visuals = results.map((r) => r.evaluation?.visualScore).filter((v): v is number => typeof v === 'number');
  const usedMock = results.some((r) => r.coding.usedMockProvider);
  const browserAgentSkipped = results.some((r) => r.evaluation?.browserAgentSkipped === true);
  return {
    configId: configId ?? results[0]?.coding.configId ?? '',
    runs: results.length,
    passes,
    passRate: results.length ? passes / results.length : 0,
    medianTokens: median(tokens) ?? 0,
    meanTokens: mean(tokens) ?? 0,
    tokenVariance: variance(tokens) ?? 0,
    medianVisualScore: median(visuals) ?? 0,
    totalCostUsd: results.reduce((a, r) => a + r.coding.usage.costUsd + (r.evaluation?.evaluatorUsage?.costUsd ?? 0), 0),
    medianDurationMs: median(results.map((r) => r.coding.durationMs)) ?? 0,
    meetsQualityRequirements: results.length > 0 && passes === results.length && !usedMock && !browserAgentSkipped,
    usedMockProvider: usedMock,
    browserAgentSkipped,
    evaluatorFailures: results.filter((r) => r.evaluation?.evaluatorFailure).length,
  };
}
