/**
 * Unattended research loop (TASK §10).
 *
 *   recover → session → baseline bootstrap (if no verified best)
 *   while budgets allow:
 *     propose → apply (new immutable config dir) → quick run → verify (N runs)
 *     → promote iff the verification pass rate >= the dev task's minPassRate (todo: every run), no mock,
 *       and median < best median × (1 - margin)
 *     → holdout on promotion (single pass/fail bit, never shown in detail to the research agent)
 *
 * Multi-task (docs/TASKS.md): quick, verification and baseline runs use settings.devTask; the best, the
 * baseline bootstrap and promotion are per dev task (the best for todo and the best for
 * mastodon-bookmarks are independent). The holdout uses settings.holdoutTask: when it equals the dev task
 * it is the dev task's holdout suite (the old behaviour); otherwise the holdout task's runs (suite and phase
 * 'holdout'), which never enter the research workspace or the digest.
 *
 * Claude subscription usage limits: when a coding run, an evaluation or a research proposal stops
 * because the subscription hit its usage limit, that is NOT a config (or proposal) failure. The loop
 * waits until the reported reset (+ margin), interruptible by SIGINT and honouring the pause file,
 * records the wait in `usage_limit_waits`, then retries the same run / proposal. Waiting time is
 * excluded from the active duration (maxTotalDurationSec) and from the per-experiment timeout. A
 * reset further away than maxUsageLimitWaitSec (or limits that keep recurring) stops the loop with
 * 'usage_limit'.
 *
 * Everything external is injected (db, runBenchmark, researchAgent, clock, …) so the loop can be
 * tested without Docker or models and so parallel execution can be added later.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExperimentOutcome, ExperimentStatus, ModelProvider } from '../runner/types.js';
import { logger } from '../runner/logger.js';
import type { BestEntry, Db, ExperimentRow, StoredSummary, UsageLimitSource, UsageLimitWaitOutcome } from '../storage/db.js';
import { summarize, type BenchmarkRunResult, type RunBenchmarkOptions, type UsageLimitHit } from './experiment.js';
import { buildHistoryDigest, joinResearchText } from './history.js';
import { applyProposal as defaultApplyProposal, configDir, hashFiles, OptimizerError, readConfigFiles as defaultReadConfigFiles, type ApplyOptions, type AppliedConfig } from './optimizer.js';
import { ResearchProposalError, type ResearchAgent } from './research-agent.js';
import { budgetsOf, type ResearchSettings } from './settings.js';
import { meetsPassRate } from './experiment.js';

const log = logger('loop');

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((res) => {
      if (signal?.aborted) return res();
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal?.removeEventListener('abort', done);
        res();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

export type RunBenchmarkFn = (opts: RunBenchmarkOptions) => Promise<BenchmarkRunResult[]>;

export interface LoopDeps {
  db: Db;
  runBenchmark: RunBenchmarkFn;
  researchAgent: ResearchAgent;
  clock?: Clock;
  applyProposal?: (opts: ApplyOptions) => AppliedConfig;
  readConfigFiles?: (configId: string, configsRoot?: string) => Record<string, string>;
  cleanupContainers?: () => Promise<number>;
  /** Coding provider override (e.g. mock) passed to every run. */
  codingProvider?: ModelProvider;
  /** Fresh coding provider per run (preferred for stateful scripted providers like the mock). */
  codingProviderFactory?: () => ModelProvider;
  evaluatorProvider?: ModelProvider;
  /** Task lookup (default runner/tasks.ts getTask): minPassRate of the dev and holdout tasks. */
  getTask?: (id: string) => { id: string; minPassRate: number };
}

export interface LoopPaths {
  configsRoot: string;
  resultsDir: string;
  pauseFile: string;
  bestConfigDir: string;
}

export interface LoopOptions {
  settings: ResearchSettings;
  resume?: boolean;
  signal?: AbortSignal;
  paths?: Partial<LoopPaths>;
}

export type StopReason =
  | 'max_experiments'
  | 'max_cost'
  | 'max_total_tokens'
  | 'max_coding_tokens'
  | 'max_duration'
  | 'usage_limit'
  | 'interrupted'
  | 'research_agent_failing'
  | 'baseline_failed_to_run';

export interface LoopResult {
  sessionId: string;
  stopReason: StopReason;
  experimentsRun: number;
  best: BestEntry | null;
  /** API-equivalent cost (local price table); nothing is billed per token on a subscription. */
  spentUsd: number;
  /** Tokens of this session, all roles. */
  totalTokens: number;
  /** Time spent waiting for subscription usage-limit resets (excluded from the active duration). */
  usageLimitWaitMs: number;
}

/** Consecutive usage-limit hits without any progress in between before the loop gives up. */
export const MAX_CONSECUTIVE_USAGE_LIMIT_HITS = 6;

function defaultPaths(p: Partial<LoopPaths> = {}): LoopPaths {
  const resultsDir = p.resultsDir ?? 'results';
  return {
    configsRoot: p.configsRoot ?? 'configs',
    resultsDir,
    pauseFile: p.pauseFile ?? join(resultsDir, 'research.pause'),
    bestConfigDir: p.bestConfigDir ?? join(resultsDir, 'best-config'),
  };
}

function newSessionId(now: number): string {
  const ts = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `sess-${ts}-${randomBytes(2).toString('hex')}`;
}

/** Published best-config dir of a dev task: results/best-config (todo) or results/best-config-<taskId>. */
export function bestConfigDirFor(bestConfigDir: string, taskId: string = 'todo'): string {
  return taskId === 'todo' ? bestConfigDir : `${bestConfigDir}-${taskId}`;
}

/** Copy the promoted config to results/best-config/ (previous copy is moved to best-config-history/). */
export function publishBestConfig(
  bestConfigDir: string,
  files: Record<string, string> | { fromDir: string },
  summary: Record<string, unknown>,
): void {
  const parent = join(bestConfigDir, '..');
  mkdirSync(parent, { recursive: true });
  const tmp = `${bestConfigDir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  if ('fromDir' in files) {
    const copy = (src: string, dst: string) => {
      mkdirSync(dst, { recursive: true });
      for (const e of readdirSync(src, { withFileTypes: true })) {
        if (e.isDirectory()) copy(join(src, e.name), join(dst, e.name));
        else if (e.isFile()) {
          copyFileSync(join(src, e.name), join(dst, e.name));
        }
      }
    };
    copy(files.fromDir, tmp);
  } else {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(tmp, rel, '..'), { recursive: true });
      writeFileSync(join(tmp, rel), content);
    }
  }
  writeFileSync(join(tmp, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (existsSync(bestConfigDir)) {
    const base = bestConfigDir.split(/[\\/]/).pop() ?? 'best-config';
    const hist = join(parent, base === 'best-config' ? 'best-config-history' : `${base}-history`);
    mkdirSync(hist, { recursive: true });
    renameSync(bestConfigDir, join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}`));
  }
  renameSync(tmp, bestConfigDir);
}

/**
 * Make results/best-config/ match db.getBestVerified(). Needed after a cheating flag changes which
 * config is best (the flagged one, or one derived from it, may currently be published).
 * Returns the newly published config id, or null when nothing changed.
 */
export function syncPublishedBest(db: Db, p: { bestConfigDir: string; configsRoot: string }, taskId: string = 'todo'): string | null {
  const best = db.getBestVerified(taskId);
  if (!best) return null;
  const bestConfigDir = bestConfigDirFor(p.bestConfigDir, taskId);
  let published: string | null = null;
  try {
    published = JSON.parse(readFileSync(join(bestConfigDir, 'summary.json'), 'utf8')).configId ?? null;
  } catch {
    published = null;
  }
  if (published === best.configId) return null;
  let dir: string;
  try {
    dir = configDir(best.configId, p.configsRoot);
  } catch {
    return null;
  }
  if (!existsSync(dir)) return null;
  const exp = db.getExperiment(best.experimentId);
  publishBestConfig(bestConfigDir, { fromDir: dir }, {
    configId: best.configId,
    taskId,
    experimentId: best.experimentId,
    promotedAt: best.promotedAt,
    republishedAt: new Date().toISOString(),
    republishedBecause: published ? `${published} is flagged as cheating (or derived from a flagged config)` : 'no published copy',
    hypothesis: exp?.hypothesis ?? null,
    changeSummary: exp?.changeSummary ?? null,
    summary: best.summary,
  });
  return best.configId;
}

function parseConfigJson(files: Record<string, string>): { provider?: string; model?: string } {
  try {
    return JSON.parse(files['config.json'] ?? '{}');
  } catch {
    return {};
  }
}

export async function runResearchLoop(deps: LoopDeps, opts: LoopOptions): Promise<LoopResult> {
  const { db } = deps;
  const settings = opts.settings;
  const clock = deps.clock ?? realClock;
  const paths = defaultPaths(opts.paths);
  const applyProposal = deps.applyProposal ?? defaultApplyProposal;
  const readConfigFiles = deps.readConfigFiles ?? defaultReadConfigFiles;
  const signal = opts.signal;
  const devTask = settings.devTask ?? 'todo';
  const holdoutTask = settings.holdoutTask ?? devTask;
  const lookupTask = deps.getTask ?? (await import('../runner/tasks.js')).getTask;
  const devMinPassRate = devTask === 'todo' && !deps.getTask ? 1 : lookupTask(devTask).minPassRate;
  const holdoutMinPassRate = holdoutTask === devTask ? devMinPassRate : lookupTask(holdoutTask).minPassRate;
  const bestConfigDir = bestConfigDirFor(paths.bestConfigDir, devTask);

  // ---- recovery -------------------------------------------------------------
  const rec = db.recoverInterrupted('research process ended before completion (recovered at startup)');
  if (rec.experiments || rec.runs || rec.sessions) log.warn('recovered interrupted state', rec);
  if (deps.cleanupContainers) {
    try {
      const n = await deps.cleanupContainers();
      if (n) log.info('removed abandoned containers', { count: n });
    } catch (e) {
      log.warn('container cleanup failed', { error: String(e) });
    }
  }

  // ---- session --------------------------------------------------------------
  const budgets = budgetsOf(settings);
  const probeProvider = deps.codingProvider ?? deps.codingProviderFactory?.();
  const isMockSession = Boolean(probeProvider?.isMock);
  const codingProviderName = probeProvider?.name;
  let sessionId: string;
  let activeBaseMs = 0;
  const prev = opts.resume ? db.latestSession() : null;
  if (prev) {
    sessionId = prev.id;
    activeBaseMs = prev.activeMs;
    db.updateSession(sessionId, { status: 'running', budgets, pid: process.pid, stopReason: null, endedAt: null, heartbeat: true });
    log.info('resuming research session', { sessionId, activeMs: activeBaseMs, spentUsd: db.sessionSpend(sessionId).total });
  } else {
    if (opts.resume) log.warn('--resume requested but no previous session exists; starting a new one');
    sessionId = newSessionId(clock.now());
    db.createSession({ id: sessionId, budgets, settings: settings as unknown as Record<string, unknown>, isMock: isMockSession });
    log.info('started research session', { sessionId, budgets });
  }

  let segmentStart = clock.now();
  let pausedMs = 0;
  const activeMs = () => activeBaseMs + (clock.now() - segmentStart) - pausedMs;
  const spent = () => db.sessionSpend(sessionId).total;
  const candidateCount = () => db.listExperiments({ sessionId }).filter((e) => e.kind === 'candidate').length;
  const heartbeat = () => db.updateSession(sessionId, { activeMs: activeMs(), spentUsd: spent(), experimentsRun: candidateCount(), heartbeat: true });

  const tokens = () => db.sessionTokens(sessionId);
  const budgetStop = (forNewExperiment: boolean): StopReason | null => {
    if (forNewExperiment && candidateCount() >= budgets.maxExperiments) return 'max_experiments';
    if (budgets.maxResearchCostUsd !== null && budgets.maxResearchCostUsd !== undefined && spent() >= budgets.maxResearchCostUsd) return 'max_cost';
    if (budgets.maxTotalTokens || budgets.maxCodingTokens) {
      const t = tokens();
      if (budgets.maxTotalTokens && t.total >= budgets.maxTotalTokens) return 'max_total_tokens';
      if (budgets.maxCodingTokens && t.coding >= budgets.maxCodingTokens) return 'max_coding_tokens';
    }
    if (activeMs() >= budgets.maxTotalDurationSec * 1000) return 'max_duration';
    return null;
  };

  let pauseLogged = false;
  const waitWhilePaused = async () => {
    while (existsSync(paths.pauseFile) && !signal?.aborted) {
      if (!pauseLogged) {
        log.info('paused (pause file present); remove it to resume', { pauseFile: paths.pauseFile });
        pauseLogged = true;
      }
      const t0 = clock.now();
      await clock.sleep(settings.pausePollSec * 1000, signal);
      pausedMs += clock.now() - t0;
    }
    if (pauseLogged) {
      log.info('resumed (pause file removed)');
      pauseLogged = false;
    }
  };

  // ---- subscription usage limits ---------------------------------------------
  let usageLimitWaitMs = 0;
  let consecutiveLimitHits = 0;
  /** Per-experiment timer of the experiment in flight (suspended while waiting for a reset). */
  let currentExperimentTimer: { suspend(): void; resume(): void } | null = null;

  /**
   * Wait for a usage-limit reset. Returns true when the caller should retry, false when it should
   * stop (interrupted, or the reset is too far away / limits keep recurring → usageLimitStop).
   */
  let usageLimitStop = false;
  const waitForUsageLimit = async (hit: { source: UsageLimitSource; resetAt: string | null; experimentId?: string | null; runId?: string | null }): Promise<boolean> => {
    const detectedAt = clock.now();
    consecutiveLimitHits++;
    const resetMs = hit.resetAt ? Date.parse(hit.resetAt) : NaN;
    const planned = Number.isFinite(resetMs)
      ? Math.max(0, resetMs - detectedAt) + settings.usageLimitMarginSec * 1000
      : settings.usageLimitUnknownResetWaitSec * 1000;
    const record = (outcome: UsageLimitWaitOutcome, waitedMs: number, note: string | null) => {
      try {
        db.insertUsageLimitWait({
          sessionId,
          experimentId: hit.experimentId ?? null,
          runId: hit.runId ?? null,
          source: hit.source,
          detectedAt: new Date(detectedAt).toISOString(),
          resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
          plannedMs: planned,
          waitedMs,
          outcome,
          note,
        });
      } catch (e) {
        log.error('could not record usage-limit wait', { error: String(e) });
      }
    };
    let giveUp: string | null = null;
    if (planned > settings.maxUsageLimitWaitSec * 1000)
      giveUp = `reset in ${Math.round(planned / 1000)}s exceeds maxUsageLimitWaitSec=${settings.maxUsageLimitWaitSec}`;
    else if (consecutiveLimitHits > MAX_CONSECUTIVE_USAGE_LIMIT_HITS)
      giveUp = `${consecutiveLimitHits} consecutive usage-limit hits without progress`;
    if (giveUp) {
      log.error('subscription usage limit: giving up', { source: hit.source, resetAt: hit.resetAt, reason: giveUp });
      record('gave_up', 0, giveUp);
      usageLimitStop = true;
      return false;
    }
    log.warn('subscription usage limit reached: waiting for the reset, then retrying (not counted as a failure)', {
      source: hit.source,
      resetAt: hit.resetAt ?? 'unknown',
      waitSec: Math.round(planned / 1000),
      experimentId: hit.experimentId,
      runId: hit.runId,
    });
    currentExperimentTimer?.suspend();
    const t0 = clock.now();
    const deadline = t0 + planned;
    const pollMs = Math.max(1000, settings.pausePollSec * 1000);
    while (!signal?.aborted && clock.now() < deadline) await clock.sleep(Math.min(pollMs, deadline - clock.now()), signal);
    const waited = clock.now() - t0;
    usageLimitWaitMs += waited;
    pausedMs += waited; // excluded from the active duration
    heartbeat();
    if (signal?.aborted) {
      record('interrupted', waited, 'interrupted by shutdown while waiting');
      return false;
    }
    record('resumed', waited, null);
    log.info('usage-limit wait over; retrying', { source: hit.source, waitedSec: Math.round(waited / 1000) });
    await waitWhilePaused();
    currentExperimentTimer?.resume();
    return !signal?.aborted;
  };

  let midRunStop: StopReason | null = null;
  /** Candidate config currently being benchmarked (checked against human cheating flags before every run). */
  let currentCandidate: string | null = null;
  const flaggedCandidate = () => (currentCandidate ? db.cheatingStatus(currentCandidate) : null);
  const beforeRun = async () => {
    await waitWhilePaused();
    heartbeat();
    if (signal?.aborted) return false;
    const cheat = flaggedCandidate();
    if (cheat) {
      log.warn('candidate flagged as cheating; stopping its batch', { configId: currentCandidate, reason: cheat.reason });
      return false;
    }
    const stop = budgetStop(false);
    if (stop) {
      midRunStop = stop;
      log.warn('budget exhausted before next run; stopping batch', { reason: stop });
      return false;
    }
    return true;
  };

  /** Combined abort signal for one experiment: global shutdown, per-experiment timeout, total duration. */
  const experimentSignal = () => {
    const ctrl = new AbortController();
    const remainingTotal = budgets.maxTotalDurationSec * 1000 - activeMs();
    let remaining = Math.max(1, Math.min(budgets.maxRuntimePerExperimentSec * 1000, remainingTotal));
    let timer: NodeJS.Timeout | null = null;
    let armedAt = 0;
    const arm = () => {
      armedAt = Date.now();
      timer = setTimeout(() => ctrl.abort(new Error('experiment time budget exceeded')), remaining);
      timer.unref?.();
    };
    arm();
    const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    const handle = {
      // Usage-limit waits must not eat the experiment's time budget.
      suspend() {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        remaining = Math.max(1, remaining - (Date.now() - armedAt));
      },
      resume() {
        if (!timer && !ctrl.signal.aborted) arm();
      },
    };
    currentExperimentTimer = handle;
    return {
      signal: sig,
      timedOut: () => ctrl.signal.aborted,
      dispose: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (currentExperimentTimer === handle) currentExperimentTimer = null;
      },
    };
  };

  const bench = (
    o: Omit<RunBenchmarkOptions, 'db' | 'sessionId' | 'provider' | 'providerFactory' | 'evaluatorProvider' | 'skipBrowserAgent' | 'maxTokensPerRun' | 'beforeRun'>,
  ) =>
    deps.runBenchmark({
      taskId: devTask,
      ...o,
      db,
      sessionId,
      provider: deps.codingProvider,
      providerFactory: deps.codingProviderFactory,
      evaluatorProvider: deps.evaluatorProvider,
      skipBrowserAgent: settings.skipBrowserAgent,
      maxTokensPerRun: budgets.maxTokensPerCodingRun,
      concurrency: settings.runConcurrency ?? 1,
      sleep: (ms, sig) => clock.sleep(ms, sig),
      beforeRun,
      onRunComplete: () => {
        consecutiveLimitHits = 0;
      },
      onUsageLimit: async (hit: UsageLimitHit) => {
        const retry = await waitForUsageLimit(hit);
        if (!retry && usageLimitStop) midRunStop = 'usage_limit';
        return retry;
      },
    });

  /** Finish an experiment whose batch was cut short. */
  const finishAborted = (exp: ExperimentRow, timedOut: boolean, phase: string) => {
    if (signal?.aborted) db.updateExperiment(exp.id, { status: 'interrupted', error: `interrupted by shutdown during ${phase}` });
    else if (midRunStop === 'usage_limit')
      db.updateExperiment(exp.id, { status: 'interrupted', error: `stopped during ${phase}: subscription usage limit (reset too far away or recurring)` });
    else if (midRunStop) db.updateExperiment(exp.id, { status: 'interrupted', error: `budget exhausted during ${phase} (${midRunStop})` });
    else if (timedOut)
      db.updateExperiment(exp.id, { status: 'failed', outcome: 'error', error: `experiment exceeded its time budget during ${phase}` });
    else db.updateExperiment(exp.id, { status: 'failed', outcome: 'error', error: `batch ended early during ${phase}` });
  };

  const finish = (stopReason: StopReason): LoopResult => {
    const status = stopReason === 'interrupted' ? 'interrupted' : 'stopped';
    db.updateSession(sessionId, {
      status,
      stopReason,
      endedAt: new Date(clock.now()).toISOString(),
      activeMs: activeMs(),
      spentUsd: spent(),
      experimentsRun: candidateCount(),
      heartbeat: true,
    });
    const result = {
      sessionId,
      stopReason,
      experimentsRun: candidateCount(),
      best: db.getBestVerified(devTask),
      spentUsd: spent(),
      totalTokens: tokens().total,
      usageLimitWaitMs,
    };
    log.info('research loop stopped', { ...result, best: result.best?.configId ?? null });
    return result;
  };

  const promote = (exp: ExperimentRow, configId: string, summary: StoredSummary) => {
    const entry = db.recordPromotion({ experimentId: exp.id, configId, summary, taskId: devTask });
    try {
      publishBestConfig(bestConfigDir, { fromDir: configDir(configId, paths.configsRoot) }, {
        configId,
        taskId: devTask,
        experimentId: exp.id,
        promotedAt: entry.promotedAt,
        previousConfigId: entry.previousConfigId,
        previousMedianTokens: entry.previousMedianTokens,
        hypothesis: exp.hypothesis,
        changeSummary: exp.changeSummary,
        summary,
      });
    } catch (e) {
      log.error('failed to publish best-config copy', { error: String(e) });
    }
    log.info('PROMOTED new best config', { configId, medianTokens: summary.medianTokens, previous: entry.previousConfigId });
    return entry;
  };

  const runHoldout = async (exp: ExperimentRow, configId: string, sig: AbortSignal) => {
    if (!settings.holdout.onPromotion) return;
    // Same task: its holdout suite (old behaviour). Other task: that task's runs, also suite/phase 'holdout'.
    const res = await bench({ configId, runs: settings.holdout.runs, suite: 'holdout', phase: 'holdout', experimentId: exp.id, signal: sig, taskId: holdoutTask });
    if (res.length < settings.holdout.runs) return; // cut short; leave bit unset
    const passed = holdoutTask === devTask && holdoutMinPassRate >= 1 ? res.every((r) => r.passed) : meetsPassRate(res.filter((r) => r.passed).length, res.length, holdoutMinPassRate);
    db.updateExperiment(exp.id, { holdoutPassed: passed });
    if (!passed) log.warn('holdout FAILED for promoted config (kept as best; flagged)', { configId });
  };

  // ---- baseline bootstrap (per dev task) ---------------------------------------
  if (!db.getBestVerified(devTask)) {
    const done = db.listExperiments({ statuses: ['completed'], taskId: devTask }).find((e) => e.kind === 'baseline' && (!e.isMock || isMockSession));
    if (done) {
      log.warn('baseline already ran but did not qualify; continuing without a verified best', { experimentId: done.id });
    } else {
      const stop = budgetStop(false);
      if (stop) return finish(stop);
      let files: Record<string, string> = {};
      try {
        files = readConfigFiles('baseline', paths.configsRoot);
      } catch (e) {
        log.error('cannot read baseline config', { error: String(e) });
        return finish('baseline_failed_to_run');
      }
      db.ensureConfig({ configId: 'baseline', hash: hashFiles(files), parentId: null, path: join(paths.configsRoot, 'baseline'), hypothesis: null });
      const cj = parseConfigJson(files);
      let exp = db.insertExperiment({
        sessionId,
        kind: 'baseline',
        parentConfigId: null,
        candidateConfigId: 'baseline',
        hypothesis: 'Baseline verification',
        changeSummary: 'unchanged baseline configuration',
        provider: codingProviderName ?? settings.codingProvider ?? cj.provider ?? 'unknown',
        model: cj.model ?? 'unknown',
        isMock: isMockSession || cj.provider === 'mock',
        status: 'verifying',
        taskId: devTask,
      });
      log.info('running baseline verification', { runs: budgets.verificationRuns, experimentId: exp.id, task: devTask });
      const es = experimentSignal();
      let results: BenchmarkRunResult[] = [];
      try {
        results = await bench({ configId: 'baseline', runs: budgets.verificationRuns, phase: 'verify', experimentId: exp.id, signal: es.signal });
      } catch (e) {
        db.updateExperiment(exp.id, { status: 'failed', outcome: 'error', error: String(e) });
        es.dispose();
        return finish('baseline_failed_to_run');
      }
      es.dispose();
      if (results.length < budgets.verificationRuns) {
        finishAborted(exp, es.timedOut(), 'baseline verification');
        return finish(signal?.aborted ? 'interrupted' : (midRunStop ?? 'baseline_failed_to_run'));
      }
      const summary = { ...summarize(results, 'baseline', { minPassRate: devMinPassRate, taskId: devTask }), phase: 'verify' as const };
      exp = db.updateExperiment(exp.id, { summary, isMock: exp.isMock || !!summary.usedMockProvider, outcome: 'baseline' });
      if (summary.meetsQualityRequirements) {
        promote(exp, 'baseline', summary);
        const hs = experimentSignal();
        await runHoldout(exp, 'baseline', hs.signal);
        hs.dispose();
      } else {
        log.warn('baseline did NOT meet quality requirements; no verified best yet', {
          passes: summary.passes,
          runs: summary.runs,
          mock: summary.usedMockProvider,
          browserAgentSkipped: summary.browserAgentSkipped,
        });
      }
      db.updateExperiment(exp.id, { status: 'completed' });
      heartbeat();
      if (signal?.aborted) return finish('interrupted');
      if (midRunStop === 'usage_limit') return finish('usage_limit');
    }
  }

  // ---- main loop ------------------------------------------------------------
  let consecutiveProposalFailures = 0;
  while (true) {
    await waitWhilePaused();
    if (signal?.aborted) return finish('interrupted');
    const stop = budgetStop(true);
    if (stop) return finish(stop);
    midRunStop = null;

    try {
      const republished = syncPublishedBest(db, paths, devTask);
      if (republished) log.warn('best config changed by a cheating flag; republished', { configId: republished });
    } catch (e) {
      log.error('failed to sync published best config', { error: String(e) });
    }
    const best = db.getBestVerified(devTask);
    const parentConfigId = best?.configId ?? 'baseline';
    const bestMedian = best?.medianTokens ?? Number.POSITIVE_INFINITY;
    let parentFiles: Record<string, string>;
    try {
      parentFiles = readConfigFiles(parentConfigId, paths.configsRoot);
    } catch (e) {
      log.error('cannot read parent config', { parentConfigId, error: String(e) });
      return finish('baseline_failed_to_run');
    }
    const parentCfg = parseConfigJson(parentFiles);
    const experimentIndex = db.listExperiments({ taskId: devTask }).filter((e) => e.kind === 'candidate').length + 1;

    let exp = db.insertExperiment({
      sessionId,
      kind: 'candidate',
      parentConfigId,
      candidateConfigId: null,
      hypothesis: '(proposing)',
      provider: codingProviderName ?? settings.codingProvider ?? parentCfg.provider ?? 'unknown',
      model: parentCfg.model ?? 'unknown',
      isMock: isMockSession || parentCfg.provider === 'mock',
      status: 'pending',
      taskId: devTask,
    });

    // 1. propose
    const whitelist = { allowModelChange: settings.allowModelChange, allowedModels: settings.allowedModels };
    let proposal;
    let research: { evidence: string; expectedSavings: string } | undefined;
    try {
      for (;;) {
        try {
          const res = await deps.researchAgent.propose(
            {
              // Agentic mode builds its sandbox workspace from these (simple modes ignore them).
              context: {
                db,
                resultsDir: paths.resultsDir,
                configsRoot: paths.configsRoot,
                verificationRuns: budgets.verificationRuns,
                taskId: devTask,
                ...(holdoutTask !== devTask ? { hiddenTaskIds: [holdoutTask] } : {}),
              },
              bestConfigId: parentConfigId,
              bestConfigFiles: parentFiles,
              history: buildHistoryDigest(db, { maxExperiments: settings.historyMaxExperiments, taskId: devTask }),
              experimentIndex,
              singleVariableExperiments: settings.singleVariableExperiments,
              whitelist,
              experimentId: exp.id,
            },
            signal,
          );
          db.insertUsageRecords(res.usage, { sessionId, experimentId: exp.id });
          proposal = res.proposal;
          research = res.research;
          if (res.workspace) log.info('research workspace', { runs: res.workspace.runs.length, experiments: res.workspace.experiments.length, bytes: res.workspace.bytes });
          consecutiveProposalFailures = 0;
          consecutiveLimitHits = 0;
          break;
        } catch (e) {
          // Subscription usage limit: not a proposal failure. Wait for the reset and ask again.
          if (!(e instanceof ResearchProposalError) || e.usageLimitResetAt === undefined || signal?.aborted) throw e;
          db.insertUsageRecords(e.usage, { sessionId, experimentId: exp.id });
          const retry = await waitForUsageLimit({ source: 'research', resetAt: e.usageLimitResetAt || null, experimentId: exp.id });
          if (retry) continue;
          if (signal?.aborted) throw e;
          db.updateExperiment(exp.id, {
            hypothesis: '(no proposal: usage limit)',
            status: 'interrupted',
            error: 'research agent stopped by the subscription usage limit (reset too far away or recurring)',
          });
          return finish('usage_limit');
        }
      }
    } catch (e) {
      if (e instanceof ResearchProposalError && e.usageLimitResetAt === undefined) db.insertUsageRecords(e.usage, { sessionId, experimentId: exp.id });
      const msg = (e as Error)?.message ?? String(e);
      if (signal?.aborted) {
        db.updateExperiment(exp.id, { status: 'interrupted', error: 'interrupted while proposing' });
        return finish('interrupted');
      }
      consecutiveProposalFailures++;
      db.updateExperiment(exp.id, { hypothesis: '(no valid proposal)', status: 'failed', outcome: 'error', error: msg });
      log.error('research agent failed to propose', { error: msg, consecutive: consecutiveProposalFailures });
      heartbeat();
      if (consecutiveProposalFailures >= settings.maxConsecutiveProposalFailures) return finish('research_agent_failing');
      continue;
    }

    // 2. apply → new immutable candidate config
    // evidence / expectedSavings: meta.json (via ApplyOptions.research) and the experiments table (hypothesis text).
    const hypothesisText = joinResearchText(proposal.hypothesis, research?.evidence, research?.expectedSavings);
    let applied: AppliedConfig;
    try {
      applied = applyProposal({
        parentConfigId,
        proposal,
        whitelist,
        configsRoot: paths.configsRoot,
        db,
        experimentId: exp.id,
        ...(research ? { research } : {}),
      } as ApplyOptions);
    } catch (e) {
      const msg = e instanceof OptimizerError ? e.message : `optimizer error: ${String(e)}`;
      db.updateExperiment(exp.id, {
        hypothesis: hypothesisText,
        changeSummary: proposal.changeSummary,
        status: 'rejected',
        outcome: 'error',
        error: msg,
      });
      log.warn('proposal rejected by optimizer', { error: msg });
      heartbeat();
      continue;
    }
    const candCfg = parseConfigJson(applied.files);
    exp = db.updateExperiment(exp.id, {
      hypothesis: hypothesisText,
      changeSummary: proposal.changeSummary,
      changes: applied.diff,
      candidateConfigId: applied.configId,
      model: candCfg.model ?? exp.model,
      isMock: exp.isMock || candCfg.provider === 'mock',
      status: 'running',
    });
    log.info('experiment start', { experimentId: exp.id, configId: applied.configId, hypothesis: proposal.hypothesis });

    const es = experimentSignal();
    currentCandidate = applied.configId;
    /** A human flagged this candidate (or its parent) as cheating while it ran: reject it, never verify/promote. */
    const rejectIfFlagged = (phase: string): boolean => {
      const cheat = db.cheatingStatus(applied.configId);
      if (!cheat) return false;
      db.updateExperiment(exp.id, {
        status: 'rejected',
        outcome: 'flagged_cheating',
        notes: `flagged as cheating during ${phase}${cheat.inherited ? ` (inherited from ${cheat.flaggedConfigId})` : ''}: ${cheat.reason}`,
      });
      log.warn('candidate rejected: flagged as cheating', { experimentId: exp.id, configId: applied.configId, phase });
      return true;
    };
    try {
      // 3. quick run
      const quick = await bench({ configId: applied.configId, runs: settings.quickRuns, phase: 'quick', experimentId: exp.id, signal: es.signal });
      if (rejectIfFlagged('the quick run')) continue;
      if (quick.length < settings.quickRuns) {
        finishAborted(exp, es.timedOut(), 'quick run');
        if (signal?.aborted) return finish('interrupted');
        if (midRunStop === 'usage_limit') return finish('usage_limit');
        continue;
      }
      const qs = summarize(quick, applied.configId);
      const quickPassed = qs.passes === qs.runs;
      exp = db.updateExperiment(exp.id, { quickPassed, isMock: exp.isMock || !!qs.usedMockProvider });
      if (!quickPassed) {
        db.updateExperiment(exp.id, { status: 'rejected', outcome: 'failed_quick_run', summary: { ...qs, phase: 'quick' } });
        log.info('quick run failed; candidate rejected', { experimentId: exp.id });
        continue;
      }
      if (settings.quickRunMaxTokenRatio && Number.isFinite(bestMedian) && qs.medianTokens > bestMedian * settings.quickRunMaxTokenRatio) {
        db.updateExperiment(exp.id, {
          status: 'completed',
          outcome: 'not_better',
          summary: { ...qs, phase: 'quick' },
          notes: `verification skipped: quick run used ${Math.round(qs.medianTokens)} tokens > ${settings.quickRunMaxTokenRatio === 1 ? '' : `${settings.quickRunMaxTokenRatio}× `}best median ${Math.round(bestMedian)}`,
        });
        continue;
      }

      // 4. verification
      exp = db.updateExperiment(exp.id, { status: 'verifying' });
      const ver = await bench({ configId: applied.configId, runs: budgets.verificationRuns, phase: 'verify', experimentId: exp.id, signal: es.signal });
      if (rejectIfFlagged('verification')) continue;
      if (ver.length < budgets.verificationRuns) {
        finishAborted(exp, es.timedOut(), 'verification');
        if (signal?.aborted) return finish('interrupted');
        if (midRunStop === 'usage_limit') return finish('usage_limit');
        continue;
      }
      const vs: StoredSummary = { ...summarize(ver, applied.configId, { minPassRate: devMinPassRate, taskId: devTask }), phase: 'verify' };
      exp = db.updateExperiment(exp.id, { summary: vs, isMock: exp.isMock || !!vs.usedMockProvider });

      // 5. decision
      const threshold = bestMedian * (1 - settings.noiseMarginPct / 100);
      let outcome: ExperimentOutcome;
      let status: ExperimentStatus = 'completed';
      let notes: string | null = null;
      if (!meetsPassRate(vs.passes, vs.runs, devMinPassRate)) {
        outcome = 'failed_verification';
        status = 'rejected';
        notes = `${vs.passes}/${vs.runs} verification runs passed${devMinPassRate < 1 ? ` (minPassRate ${devMinPassRate})` : ''}${vs.evaluatorFailures ? ` (${vs.evaluatorFailures} evaluator failures)` : ''}`;
      } else if (vs.usedMockProvider || exp.isMock || vs.browserAgentSkipped || !vs.meetsQualityRequirements) {
        outcome = 'not_better';
        const why: string[] = [];
        if (vs.usedMockProvider || exp.isMock) why.push('[MOCK] mock-provider results can never be promoted');
        if (vs.browserAgentSkipped) why.push('[NO-BROWSER-AGENT] evaluated without the browser agent; never eligible for promotion');
        notes = why.length ? why.join('; ') : 'does not meet quality requirements';
      } else if (db.cheatingStatus(applied.configId)) {
        outcome = 'flagged_cheating';
        status = 'rejected';
        notes = `flagged as cheating: ${db.cheatingStatus(applied.configId)!.reason}`;
      } else if (vs.medianTokens < threshold) {
        outcome = 'promoted';
      } else {
        outcome = 'not_better';
        notes = `median ${Math.round(vs.medianTokens)} ≥ required ${Math.round(threshold)} (best ${Math.round(bestMedian)}, margin ${settings.noiseMarginPct}%)`;
      }
      if (outcome === 'promoted') {
        db.updateExperiment(exp.id, { outcome: 'promoted' });
        promote(exp, applied.configId, vs);
        await runHoldout(exp, applied.configId, es.signal);
      }
      db.updateExperiment(exp.id, { status, outcome, notes });
      log.info('experiment done', { experimentId: exp.id, outcome, medianTokens: vs.medianTokens, passes: vs.passes });
    } catch (e) {
      const cur = db.getExperiment(exp.id);
      if (cur && ['pending', 'running', 'verifying'].includes(cur.status)) {
        if (signal?.aborted) db.updateExperiment(exp.id, { status: 'interrupted', error: 'interrupted by shutdown' });
        else db.updateExperiment(exp.id, { status: 'failed', outcome: 'error', error: (e as Error)?.message ?? String(e) });
      }
      log.error('experiment crashed', { experimentId: exp.id, error: String(e) });
      if (signal?.aborted) return finish('interrupted');
    } finally {
      es.dispose();
      currentCandidate = null;
      heartbeat();
    }
    if (midRunStop) return finish(midRunStop);
  }
}
