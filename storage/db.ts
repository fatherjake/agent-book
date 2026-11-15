/**
 * SQLite results store (better-sqlite3, WAL mode, migrations via PRAGMA user_version).
 *
 * Append-only in spirit:
 *  - DELETE is blocked on every table by triggers.
 *  - evaluations, usage_records, artifacts and best_history rows can never be updated.
 *  - runs can only be updated while status = 'running'; experiments only while
 *    status is pending/running/verifying; configs only to set promoted_at once.
 *  - research_sessions rows are the mutable bookkeeping of a session (budgets/spent/status).
 *
 * Token/cost accounting per role:
 *  - coding    = runs.* token columns (copied from CodingRunResult.usage, coding role only)
 *  - evaluator = evaluations.evaluator_* columns (EvaluationResult.evaluatorUsage)
 *  - research  = usage_records WHERE role = 'research'
 *  usage_records also holds every raw coding/evaluator UsageRecord that could be read from
 *  disk, for audit; role totals are never derived by adding both sources together.
 */
import Database from 'better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentRole,
  CodingRunResult,
  EvaluationResult,
  ExperimentOutcome,
  ExperimentStatus,
  RunStatus,
  UsageRecord,
  VerificationSummary,
} from '../runner/types.js';

export const DEFAULT_DB_PATH = join('results', 'benchmark.db');

export type RunPhase = 'quick' | 'verify' | 'holdout' | 'manual';
export type Suite = 'dev' | 'holdout';
export type RunRowStatus = 'running' | RunStatus;
/** 'manual' = a batch started by `npm run benchmark` (not part of the research loop). */
export type ExperimentKind = 'baseline' | 'candidate' | 'manual';
export type SessionStatus = 'running' | 'interrupted' | 'stopped';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE configs (
    config_id   TEXT PRIMARY KEY,
    hash        TEXT NOT NULL,
    parent_id   TEXT,
    path        TEXT NOT NULL,
    hypothesis  TEXT,
    created_at  TEXT NOT NULL,
    promoted_at TEXT
  );

  CREATE TABLE research_sessions (
    id              TEXT PRIMARY KEY,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    status          TEXT NOT NULL,
    budgets_json    TEXT NOT NULL,
    settings_json   TEXT,
    experiments_run INTEGER NOT NULL DEFAULT 0,
    spent_usd       REAL NOT NULL DEFAULT 0,
    active_ms       INTEGER NOT NULL DEFAULT 0,
    stop_reason     TEXT,
    pid             INTEGER,
    heartbeat_at    TEXT,
    is_mock         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE experiments (
    seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
    id                  TEXT NOT NULL UNIQUE,
    session_id          TEXT,
    kind                TEXT NOT NULL,
    parent_config_id    TEXT,
    candidate_config_id TEXT,
    hypothesis          TEXT NOT NULL,
    change_summary      TEXT,
    changes             TEXT NOT NULL DEFAULT '',
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    finished_at         TEXT,
    status              TEXT NOT NULL,
    outcome             TEXT,
    is_mock             INTEGER NOT NULL DEFAULT 0,
    quick_passed        INTEGER,
    summary_json        TEXT,
    holdout_passed      INTEGER,
    error               TEXT,
    notes               TEXT
  );
  CREATE INDEX idx_experiments_session ON experiments(session_id);

  CREATE TABLE runs (
    run_id             TEXT PRIMARY KEY,
    experiment_id      TEXT,
    config_id          TEXT NOT NULL,
    config_hash        TEXT,
    seed               INTEGER NOT NULL,
    phase              TEXT NOT NULL,
    suite              TEXT NOT NULL,
    provider           TEXT,
    model              TEXT,
    image_id           TEXT,
    starter_hash       TEXT,
    started_at         TEXT NOT NULL,
    finished_at        TEXT,
    status             TEXT NOT NULL,
    failure_reason     TEXT,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens       INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL DEFAULT 0,
    cost_estimated     INTEGER NOT NULL DEFAULT 0,
    usage_estimated    INTEGER NOT NULL DEFAULT 0,
    model_calls        INTEGER NOT NULL DEFAULT 0,
    tool_calls         INTEGER NOT NULL DEFAULT 0,
    duration_ms        INTEGER NOT NULL DEFAULT 0,
    used_mock_provider INTEGER NOT NULL DEFAULT 0,
    passed             INTEGER
  );
  CREATE INDEX idx_runs_experiment ON runs(experiment_id);
  CREATE INDEX idx_runs_config ON runs(config_id);

  CREATE TABLE evaluations (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                    TEXT NOT NULL,
    suite                     TEXT NOT NULL,
    seed                      INTEGER,
    started_at                TEXT,
    finished_at               TEXT,
    app_started               INTEGER NOT NULL DEFAULT 0,
    passed                    INTEGER NOT NULL,
    evaluator_failure         INTEGER NOT NULL DEFAULT 0,
    visual_score              REAL,
    visual_threshold          REAL,
    checks_json               TEXT NOT NULL,
    failure_summary           TEXT,
    evaluator_input_tokens    INTEGER NOT NULL DEFAULT 0,
    evaluator_output_tokens   INTEGER NOT NULL DEFAULT 0,
    evaluator_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    evaluator_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    evaluator_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    evaluator_total_tokens    INTEGER NOT NULL DEFAULT 0,
    evaluator_cost_usd        REAL NOT NULL DEFAULT 0,
    evaluator_model_calls     INTEGER NOT NULL DEFAULT 0,
    evaluator_usage_estimated INTEGER NOT NULL DEFAULT 0,
    report_path               TEXT,
    UNIQUE(run_id, suite)
  );

  CREATE TABLE usage_records (
    id                 TEXT PRIMARY KEY,
    role               TEXT NOT NULL,
    run_id             TEXT,
    experiment_id      TEXT,
    session_id         TEXT,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    timestamp          TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
    reasoning_included_in_output INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens       INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL DEFAULT 0,
    cost_estimated     INTEGER NOT NULL DEFAULT 0,
    usage_estimated    INTEGER NOT NULL DEFAULT 0,
    purpose            TEXT,
    raw_json           TEXT
  );
  CREATE INDEX idx_usage_role ON usage_records(role);
  CREATE INDEX idx_usage_run ON usage_records(run_id);
  CREATE INDEX idx_usage_session ON usage_records(session_id);

  CREATE TABLE artifacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT,
    experiment_id TEXT,
    kind          TEXT NOT NULL,
    path          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    bytes         INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_artifacts_run ON artifacts(run_id);

  CREATE TABLE best_history (
    seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id          TEXT NOT NULL,
    config_id              TEXT NOT NULL,
    median_tokens          REAL NOT NULL,
    pass_rate              REAL NOT NULL,
    summary_json           TEXT NOT NULL,
    promoted_at            TEXT NOT NULL,
    previous_config_id     TEXT,
    previous_median_tokens REAL
  );

  -- append-only guards ------------------------------------------------------
  CREATE TRIGGER no_delete_configs BEFORE DELETE ON configs BEGIN SELECT RAISE(ABORT, 'append-only: configs'); END;
  CREATE TRIGGER no_delete_sessions BEFORE DELETE ON research_sessions BEGIN SELECT RAISE(ABORT, 'append-only: research_sessions'); END;
  CREATE TRIGGER no_delete_experiments BEFORE DELETE ON experiments BEGIN SELECT RAISE(ABORT, 'append-only: experiments'); END;
  CREATE TRIGGER no_delete_runs BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'append-only: runs'); END;
  CREATE TRIGGER no_delete_evaluations BEFORE DELETE ON evaluations BEGIN SELECT RAISE(ABORT, 'append-only: evaluations'); END;
  CREATE TRIGGER no_delete_usage BEFORE DELETE ON usage_records BEGIN SELECT RAISE(ABORT, 'append-only: usage_records'); END;
  CREATE TRIGGER no_delete_artifacts BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'append-only: artifacts'); END;
  CREATE TRIGGER no_delete_best BEFORE DELETE ON best_history BEGIN SELECT RAISE(ABORT, 'append-only: best_history'); END;

  CREATE TRIGGER no_update_evaluations BEFORE UPDATE ON evaluations BEGIN SELECT RAISE(ABORT, 'immutable: evaluations'); END;
  CREATE TRIGGER no_update_usage BEFORE UPDATE ON usage_records BEGIN SELECT RAISE(ABORT, 'immutable: usage_records'); END;
  CREATE TRIGGER no_update_artifacts BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'immutable: artifacts'); END;
  CREATE TRIGGER no_update_best BEFORE UPDATE ON best_history BEGIN SELECT RAISE(ABORT, 'immutable: best_history'); END;

  CREATE TRIGGER runs_update_only_running BEFORE UPDATE ON runs
    WHEN OLD.status <> 'running' OR NEW.run_id <> OLD.run_id
    BEGIN SELECT RAISE(ABORT, 'immutable: finished run'); END;

  CREATE TRIGGER experiments_update_only_active BEFORE UPDATE ON experiments
    WHEN OLD.status NOT IN ('pending', 'running', 'verifying') OR NEW.id <> OLD.id
    BEGIN SELECT RAISE(ABORT, 'immutable: finished experiment'); END;

  CREATE TRIGGER configs_update_only_promote BEFORE UPDATE ON configs
    WHEN OLD.promoted_at IS NOT NULL OR NEW.hash <> OLD.hash OR NEW.config_id <> OLD.config_id
      OR NEW.path <> OLD.path OR IFNULL(NEW.parent_id, '') <> IFNULL(OLD.parent_id, '')
    BEGIN SELECT RAISE(ABORT, 'immutable: config'); END;
  `,
  /* v2: evaluations that skipped the LLM browser agent are incomplete and never count toward promotion. */ `
  ALTER TABLE evaluations ADD COLUMN browser_agent_skipped INTEGER NOT NULL DEFAULT 0;
  `,
  /* v3: subscription usage-limit waits of the research loop (append-only audit log). */ `
  CREATE TABLE usage_limit_waits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT,
    experiment_id  TEXT,
    run_id         TEXT,
    source         TEXT NOT NULL,
    detected_at    TEXT NOT NULL,
    reset_at       TEXT,
    planned_ms     INTEGER NOT NULL,
    waited_ms      INTEGER NOT NULL,
    outcome        TEXT NOT NULL,
    note           TEXT
  );
  CREATE INDEX idx_usage_limit_waits_session ON usage_limit_waits(session_id);
  CREATE TRIGGER no_delete_usage_limit_waits BEFORE DELETE ON usage_limit_waits BEGIN SELECT RAISE(ABORT, 'append-only: usage_limit_waits'); END;
  CREATE TRIGGER no_update_usage_limit_waits BEFORE UPDATE ON usage_limit_waits BEGIN SELECT RAISE(ABORT, 'immutable: usage_limit_waits'); END;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * failure_reason prefix of runs that hit a Claude subscription usage limit (coding or evaluator).
 * The research loop retries such runs; they are excluded from pass rates and token summaries.
 */
export const USAGE_LIMIT_REASON = 'usage_limit';
export const isUsageLimitRun = (failureReason: string | null | undefined): boolean => !!failureReason && failureReason.startsWith(USAGE_LIMIT_REASON);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ConfigRow {
  configId: string;
  hash: string;
  parentId: string | null;
  path: string;
  hypothesis: string | null;
  createdAt: string;
  promotedAt: string | null;
}

export interface ResearchBudgets {
  maxExperiments: number;
  /**
   * API-equivalent cost cap (USD, from the local price table). On a Claude subscription nothing is
   * billed per token, so this is only a proxy; null = disabled (default for claude-code providers).
   */
  maxResearchCostUsd: number | null;
  /** Cap on all tokens of the session (coding + evaluator + research); null/undefined = none. */
  maxTotalTokens?: number | null;
  /** Cap on coding-agent tokens of the session; null/undefined = none. */
  maxCodingTokens?: number | null;
  maxTokensPerCodingRun: number | null;
  maxRuntimePerExperimentSec: number;
  maxTotalDurationSec: number;
  verificationRuns: number;
}

export interface SessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  budgets: ResearchBudgets;
  settings: Record<string, unknown> | null;
  experimentsRun: number;
  spentUsd: number;
  activeMs: number;
  stopReason: string | null;
  pid: number | null;
  heartbeatAt: string | null;
  isMock: boolean;
}

export interface ExperimentRow {
  seq: number;
  id: string;
  sessionId: string | null;
  kind: ExperimentKind;
  parentConfigId: string | null;
  candidateConfigId: string | null;
  hypothesis: string;
  changeSummary: string | null;
  changes: string;
  provider: string;
  model: string;
  createdAt: string;
  finishedAt: string | null;
  status: ExperimentStatus;
  outcome: ExperimentOutcome;
  isMock: boolean;
  quickPassed: boolean | null;
  summary: StoredSummary | null;
  holdoutPassed: boolean | null;
  error: string | null;
  notes: string | null;
}

/** VerificationSummary plus the extra fields the researcher computes. */
export interface StoredSummary extends VerificationSummary {
  usedMockProvider?: boolean;
  /** At least one run was evaluated without the LLM browser agent → never eligible for promotion. */
  browserAgentSkipped?: boolean;
  evaluatorFailures?: number;
  phase?: RunPhase;
}

export interface NewExperiment {
  id?: string;
  sessionId?: string | null;
  kind: ExperimentKind;
  parentConfigId: string | null;
  candidateConfigId: string | null;
  hypothesis: string;
  changeSummary?: string | null;
  changes?: string;
  provider: string;
  model: string;
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  isMock?: boolean;
  error?: string | null;
  notes?: string | null;
  createdAt?: string;
}

export interface ExperimentPatch {
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  quickPassed?: boolean | null;
  summary?: StoredSummary | null;
  holdoutPassed?: boolean | null;
  error?: string | null;
  notes?: string | null;
  isMock?: boolean;
  finishedAt?: string | null;
  candidateConfigId?: string | null;
  changes?: string;
  changeSummary?: string | null;
  hypothesis?: string;
  provider?: string;
  model?: string;
}

export interface RunRow {
  runId: string;
  experimentId: string | null;
  configId: string;
  configHash: string | null;
  seed: number;
  phase: RunPhase;
  suite: Suite;
  provider: string | null;
  model: string | null;
  imageId: string | null;
  starterHash: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: RunRowStatus;
  failureReason: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costEstimated: boolean;
  usageEstimated: boolean;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  usedMockProvider: boolean;
  /** Quality pass: coding completed AND evaluation passed (no evaluator failure). null while running. */
  passed: boolean | null;
}

export interface EvaluationRow {
  id: number;
  runId: string;
  suite: Suite;
  seed: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  appStarted: boolean;
  passed: boolean;
  evaluatorFailure: boolean;
  visualScore: number | null;
  visualThreshold: number | null;
  checks: EvaluationResult['checks'];
  failureSummary: string | null;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorReasoningTokens: number;
  evaluatorCacheReadTokens: number;
  evaluatorCacheWriteTokens: number;
  evaluatorTotalTokens: number;
  evaluatorCostUsd: number;
  evaluatorModelCalls: number;
  evaluatorUsageEstimated: boolean;
  reportPath: string | null;
  /** Evaluated with skipBrowserAgent: incomplete, never eligible for promotion. */
  browserAgentSkipped: boolean;
}

export interface ArtifactRow {
  id: number;
  runId: string | null;
  experimentId: string | null;
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export interface BestEntry {
  seq: number;
  experimentId: string;
  configId: string;
  medianTokens: number;
  passRate: number;
  summary: StoredSummary;
  promotedAt: string;
  previousConfigId: string | null;
  previousMedianTokens: number | null;
}

/** Source of a subscription usage-limit hit that made the research loop wait. */
export type UsageLimitSource = 'coding' | 'evaluator' | 'research';
export type UsageLimitWaitOutcome = 'resumed' | 'interrupted' | 'gave_up';

export interface UsageLimitWaitRow {
  id: number;
  sessionId: string | null;
  experimentId: string | null;
  runId: string | null;
  source: UsageLimitSource;
  detectedAt: string;
  /** Reset time reported by the gateway (null = unknown). */
  resetAt: string | null;
  plannedMs: number;
  waitedMs: number;
  outcome: UsageLimitWaitOutcome;
  note: string | null;
}

export interface RoleTotals {
  coding: number;
  evaluator: number;
  research: number;
  total: number;
}

export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  modelCalls: number;
  anyEstimated: boolean;
}

export interface RoleBreakdown {
  coding: TokenBreakdown;
  evaluator: TokenBreakdown;
  research: TokenBreakdown;
}

export interface ExperimentListItem extends ExperimentRow {
  runsTotal: number;
  quickRuns: number;
  verifyRuns: number;
  verifyPasses: number;
  passRate: number | null;
  /** Median coding totalTokens of verification runs (or the quick run if never verified). */
  medianTokens: number | null;
  meanTokens: number | null;
  medianVisualScore: number | null;
  medianDurationMs: number | null;
  meanToolCalls: number | null;
  /** coding + evaluator + research cost attributed to this experiment. */
  totalCostUsd: number;
  researchCostUsd: number;
  /** (bestMedian - medianTokens) / bestMedian * 100 vs the CURRENT best; positive = fewer tokens. */
  improvementVsBestPct: number | null;
  anyMock: boolean;
  /** Some evaluation of this experiment skipped the LLM browser agent ([NO-BROWSER-AGENT]). */
  anyBrowserAgentSkipped: boolean;
}

export interface RunWithEvaluation extends RunRow {
  evaluations: EvaluationRow[];
}

export interface ExperimentDetail {
  experiment: ExperimentListItem;
  runs: RunWithEvaluation[];
  usageByRole: RoleBreakdown;
  artifacts: ArtifactRow[];
  config: ConfigRow | null;
  parentConfig: ConfigRow | null;
}

export interface Overview {
  best: BestEntry | null;
  baseline: { experimentId: string; configId: string; medianTokens: number | null; meetsQuality: boolean; isMock: boolean } | null;
  /** (baselineMedian - bestMedian) / baselineMedian * 100 */
  improvementPct: number | null;
  experimentsTotal: number;
  experimentsFinished: number;
  experimentsByOutcome: Record<string, number>;
  runsTotal: number;
  runsPassed: number;
  costByRole: RoleTotals;
  tokensByRole: RoleTotals;
  anyMock: boolean;
  /** Some evaluation skipped the LLM browser agent ([NO-BROWSER-AGENT]). */
  anyBrowserAgentSkipped: boolean;
  activeSession: SessionRow | null;
}

export interface CostPoint {
  timestamp: string;
  role: AgentRole;
  costUsd: number;
  cumulativeUsd: number;
  cumulativeByRole: RoleTotals;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);
const nb = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
const nowIso = () => new Date().toISOString();

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, c) => a - c);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, c) => a + c, 0) / xs.length;
}

/** Population variance. */
export function variance(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null) return null;
  return xs.reduce((a, c) => a + (c - m) ** 2, 0) / xs.length;
}

const emptyBreakdown = (): TokenBreakdown => ({
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

type Raw = Record<string, any>;

function mapConfig(r: Raw): ConfigRow {
  return {
    configId: r.config_id,
    hash: r.hash,
    parentId: r.parent_id ?? null,
    path: r.path,
    hypothesis: r.hypothesis ?? null,
    createdAt: r.created_at,
    promotedAt: r.promoted_at ?? null,
  };
}

function mapSession(r: Raw): SessionRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    status: r.status,
    budgets: parseJson(r.budgets_json, {} as ResearchBudgets),
    settings: parseJson(r.settings_json, null),
    experimentsRun: r.experiments_run,
    spentUsd: r.spent_usd,
    activeMs: r.active_ms,
    stopReason: r.stop_reason ?? null,
    pid: r.pid ?? null,
    heartbeatAt: r.heartbeat_at ?? null,
    isMock: Boolean(r.is_mock),
  };
}

function mapExperiment(r: Raw): ExperimentRow {
  return {
    seq: r.seq,
    id: r.id,
    sessionId: r.session_id ?? null,
    kind: r.kind,
    parentConfigId: r.parent_config_id ?? null,
    candidateConfigId: r.candidate_config_id ?? null,
    hypothesis: r.hypothesis,
    changeSummary: r.change_summary ?? null,
    changes: r.changes ?? '',
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? null,
    status: r.status,
    outcome: r.outcome ?? null,
    isMock: Boolean(r.is_mock),
    quickPassed: nb(r.quick_passed),
    summary: parseJson(r.summary_json, null),
    holdoutPassed: nb(r.holdout_passed),
    error: r.error ?? null,
    notes: r.notes ?? null,
  };
}

function mapRun(r: Raw): RunRow {
  return {
    runId: r.run_id,
    experimentId: r.experiment_id ?? null,
    configId: r.config_id,
    configHash: r.config_hash ?? null,
    seed: r.seed,
    phase: r.phase,
    suite: r.suite,
    provider: r.provider ?? null,
    model: r.model ?? null,
    imageId: r.image_id ?? null,
    starterHash: r.starter_hash ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    status: r.status,
    failureReason: r.failure_reason ?? null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    costUsd: r.cost_usd,
    costEstimated: Boolean(r.cost_estimated),
    usageEstimated: Boolean(r.usage_estimated),
    modelCalls: r.model_calls,
    toolCalls: r.tool_calls,
    durationMs: r.duration_ms,
    usedMockProvider: Boolean(r.used_mock_provider),
    passed: nb(r.passed),
  };
}

function mapEvaluation(r: Raw): EvaluationRow {
  return {
    id: r.id,
    runId: r.run_id,
    suite: r.suite,
    seed: r.seed ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    appStarted: Boolean(r.app_started),
    passed: Boolean(r.passed),
    evaluatorFailure: Boolean(r.evaluator_failure),
    visualScore: r.visual_score ?? null,
    visualThreshold: r.visual_threshold ?? null,
    checks: parseJson(r.checks_json, []),
    failureSummary: r.failure_summary ?? null,
    evaluatorInputTokens: r.evaluator_input_tokens,
    evaluatorOutputTokens: r.evaluator_output_tokens,
    evaluatorReasoningTokens: r.evaluator_reasoning_tokens,
    evaluatorCacheReadTokens: r.evaluator_cache_read_tokens,
    evaluatorCacheWriteTokens: r.evaluator_cache_write_tokens,
    evaluatorTotalTokens: r.evaluator_total_tokens,
    evaluatorCostUsd: r.evaluator_cost_usd,
    evaluatorModelCalls: r.evaluator_model_calls,
    evaluatorUsageEstimated: Boolean(r.evaluator_usage_estimated),
    reportPath: r.report_path ?? null,
    browserAgentSkipped: Boolean(r.browser_agent_skipped),
  };
}

function mapArtifact(r: Raw): ArtifactRow {
  return {
    id: r.id,
    runId: r.run_id ?? null,
    experimentId: r.experiment_id ?? null,
    kind: r.kind,
    path: r.path,
    sha256: r.sha256,
    bytes: r.bytes,
    createdAt: r.created_at,
  };
}

function mapBest(r: Raw): BestEntry {
  return {
    seq: r.seq,
    experimentId: r.experiment_id,
    configId: r.config_id,
    medianTokens: r.median_tokens,
    passRate: r.pass_rate,
    summary: parseJson(r.summary_json, {} as StoredSummary),
    promotedAt: r.promoted_at,
    previousConfigId: r.previous_config_id ?? null,
    previousMedianTokens: r.previous_median_tokens ?? null,
  };
}

// ---------------------------------------------------------------------------
// Db
// ---------------------------------------------------------------------------

export interface OpenDbOptions {
  /** Where experiment state changes are appended. Default: <dir of db>/experiments.jsonl; null disables. */
  experimentsJsonl?: string | null;
  /** Open read-only (file must exist; no migrations, no WAL switch, PRAGMA query_only=ON). */
  readOnly?: boolean;
}

export class Db {
  readonly raw: Database.Database;
  readonly path: string;
  private readonly jsonl: string | null;

  constructor(path: string = DEFAULT_DB_PATH, opts: OpenDbOptions = {}) {
    this.path = path;
    const inMemory = path === ':memory:';
    if (opts.readOnly) {
      this.raw = new Database(path, { readonly: true, fileMustExist: true });
      this.raw.pragma('query_only = ON');
      this.raw.pragma('busy_timeout = 5000');
      this.jsonl = null;
      const v = this.raw.pragma('user_version', { simple: true }) as number;
      if (v > MIGRATIONS.length) throw new Error(`DB schema version ${v} is newer than this code (${MIGRATIONS.length})`);
      return;
    }
    if (!inMemory) mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    if (!inMemory) this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('busy_timeout = 5000');
    this.jsonl =
      opts.experimentsJsonl === undefined ? (inMemory ? null : join(dirname(path), 'experiments.jsonl')) : opts.experimentsJsonl;
    this.migrate();
  }

  private migrate(): void {
    const current = this.raw.pragma('user_version', { simple: true }) as number;
    if (current > MIGRATIONS.length) {
      throw new Error(`DB schema version ${current} is newer than this code (${MIGRATIONS.length})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.transaction(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  schemaVersion(): number {
    return this.raw.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    this.raw.close();
  }

  private appendExperimentEvent(event: string, exp: ExperimentRow): void {
    if (!this.jsonl) return;
    try {
      mkdirSync(dirname(this.jsonl), { recursive: true });
      appendFileSync(this.jsonl, JSON.stringify({ ts: nowIso(), event, experiment: exp }) + '\n');
    } catch {
      /* jsonl mirror must never break the DB write */
    }
  }

  // ---- configs -------------------------------------------------------------

  insertConfig(c: Omit<ConfigRow, 'createdAt' | 'promotedAt'> & { createdAt?: string }): ConfigRow {
    this.raw
      .prepare(
        `INSERT INTO configs (config_id, hash, parent_id, path, hypothesis, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(c.configId, c.hash, c.parentId, c.path, c.hypothesis, c.createdAt ?? nowIso());
    return this.getConfig(c.configId)!;
  }

  /** Insert a config row if absent (e.g. 'baseline'); returns the row. */
  ensureConfig(c: Omit<ConfigRow, 'createdAt' | 'promotedAt'>): ConfigRow {
    return this.getConfig(c.configId) ?? this.insertConfig(c);
  }

  getConfig(configId: string): ConfigRow | null {
    const r = this.raw.prepare(`SELECT * FROM configs WHERE config_id = ?`).get(configId) as Raw | undefined;
    return r ? mapConfig(r) : null;
  }

  listConfigs(): ConfigRow[] {
    return (this.raw.prepare(`SELECT * FROM configs ORDER BY created_at, config_id`).all() as Raw[]).map(mapConfig);
  }

  markConfigPromoted(configId: string, at: string = nowIso()): void {
    const cfg = this.getConfig(configId);
    if (!cfg || cfg.promotedAt) return;
    this.raw.prepare(`UPDATE configs SET promoted_at = ? WHERE config_id = ?`).run(at, configId);
  }

  // ---- sessions ------------------------------------------------------------

  createSession(s: { id: string; budgets: ResearchBudgets; settings?: Record<string, unknown>; isMock?: boolean; pid?: number }): SessionRow {
    const t = nowIso();
    this.raw
      .prepare(
        `INSERT INTO research_sessions (id, started_at, status, budgets_json, settings_json, pid, heartbeat_at, is_mock)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(s.id, t, JSON.stringify(s.budgets), s.settings ? JSON.stringify(s.settings) : null, s.pid ?? process.pid, t, s.isMock ? 1 : 0);
    return this.getSession(s.id)!;
  }

  getSession(id: string): SessionRow | null {
    const r = this.raw.prepare(`SELECT * FROM research_sessions WHERE id = ?`).get(id) as Raw | undefined;
    return r ? mapSession(r) : null;
  }

  latestSession(): SessionRow | null {
    const r = this.raw.prepare(`SELECT * FROM research_sessions ORDER BY started_at DESC, rowid DESC LIMIT 1`).get() as Raw | undefined;
    return r ? mapSession(r) : null;
  }

  listSessions(): SessionRow[] {
    return (this.raw.prepare(`SELECT * FROM research_sessions ORDER BY started_at, rowid`).all() as Raw[]).map(mapSession);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionRow, 'status' | 'experimentsRun' | 'spentUsd' | 'activeMs' | 'stopReason' | 'endedAt' | 'pid' | 'budgets'>> & {
      heartbeat?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.experimentsRun !== undefined) add('experiments_run', patch.experimentsRun);
    if (patch.spentUsd !== undefined) add('spent_usd', patch.spentUsd);
    if (patch.activeMs !== undefined) add('active_ms', Math.round(patch.activeMs));
    if (patch.stopReason !== undefined) add('stop_reason', patch.stopReason);
    if (patch.endedAt !== undefined) add('ended_at', patch.endedAt);
    if (patch.pid !== undefined) add('pid', patch.pid);
    if (patch.budgets !== undefined) add('budgets_json', JSON.stringify(patch.budgets));
    if (patch.heartbeat) add('heartbeat_at', nowIso());
    if (!sets.length) return;
    vals.push(id);
    this.raw.prepare(`UPDATE research_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** coding + evaluator + research cost attributed to a session. */
  sessionSpend(sessionId: string): RoleTotals {
    const coding =
      (this.raw
        .prepare(
          `SELECT COALESCE(SUM(r.cost_usd),0) c FROM runs r JOIN experiments e ON e.id = r.experiment_id WHERE e.session_id = ?`,
        )
        .get(sessionId) as Raw).c ?? 0;
    const evaluator =
      (this.raw
        .prepare(
          `SELECT COALESCE(SUM(v.evaluator_cost_usd),0) c FROM evaluations v JOIN runs r ON r.run_id = v.run_id
           JOIN experiments e ON e.id = r.experiment_id WHERE e.session_id = ?`,
        )
        .get(sessionId) as Raw).c ?? 0;
    const research =
      (this.raw
        .prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM usage_records WHERE role = 'research' AND session_id = ?`)
        .get(sessionId) as Raw).c ?? 0;
    return { coding, evaluator, research, total: coding + evaluator + research };
  }

  // ---- experiments ---------------------------------------------------------

  nextExperimentId(): string {
    const r = this.raw.prepare(`SELECT COALESCE(MAX(seq), 0) m FROM experiments`).get() as Raw;
    return `exp-${String((r.m as number) + 1).padStart(4, '0')}`;
  }

  insertExperiment(e: NewExperiment): ExperimentRow {
    const id = e.id ?? this.nextExperimentId();
    this.raw
      .prepare(
        `INSERT INTO experiments (id, session_id, kind, parent_config_id, candidate_config_id, hypothesis, change_summary, changes,
           provider, model, created_at, status, outcome, is_mock, error, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        e.sessionId ?? null,
        e.kind,
        e.parentConfigId,
        e.candidateConfigId,
        e.hypothesis,
        e.changeSummary ?? null,
        e.changes ?? '',
        e.provider,
        e.model,
        e.createdAt ?? nowIso(),
        e.status ?? 'pending',
        e.outcome ?? null,
        e.isMock ? 1 : 0,
        e.error ?? null,
        e.notes ?? null,
      );
    const row = this.getExperiment(id)!;
    this.appendExperimentEvent('created', row);
    return row;
  }

  /** Status transition of an in-progress experiment (blocked by trigger once finished). */
  updateExperiment(id: string, p: ExperimentPatch): ExperimentRow {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.status !== undefined) add('status', p.status);
    if (p.outcome !== undefined) add('outcome', p.outcome);
    if (p.quickPassed !== undefined) add('quick_passed', b(p.quickPassed));
    if (p.summary !== undefined) add('summary_json', p.summary ? JSON.stringify(p.summary) : null);
    if (p.holdoutPassed !== undefined) add('holdout_passed', b(p.holdoutPassed));
    if (p.error !== undefined) add('error', p.error);
    if (p.notes !== undefined) add('notes', p.notes);
    if (p.isMock !== undefined) add('is_mock', p.isMock ? 1 : 0);
    if (p.candidateConfigId !== undefined) add('candidate_config_id', p.candidateConfigId);
    if (p.changes !== undefined) add('changes', p.changes);
    if (p.changeSummary !== undefined) add('change_summary', p.changeSummary);
    if (p.hypothesis !== undefined) add('hypothesis', p.hypothesis);
    if (p.provider !== undefined) add('provider', p.provider);
    if (p.model !== undefined) add('model', p.model);
    const terminal = p.status && !['pending', 'running', 'verifying'].includes(p.status);
    if (p.finishedAt !== undefined) add('finished_at', p.finishedAt);
    else if (terminal) add('finished_at', nowIso());
    if (sets.length) {
      vals.push(id);
      this.raw.prepare(`UPDATE experiments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    const row = this.getExperiment(id);
    if (!row) throw new Error(`experiment ${id} not found`);
    this.appendExperimentEvent(p.status ? `status:${p.status}` : 'updated', row);
    return row;
  }

  getExperiment(id: string): ExperimentRow | null {
    const r = this.raw.prepare(`SELECT * FROM experiments WHERE id = ?`).get(id) as Raw | undefined;
    return r ? mapExperiment(r) : null;
  }

  listExperiments(filter: { sessionId?: string; statuses?: ExperimentStatus[] } = {}): ExperimentRow[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      vals.push(filter.sessionId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      vals.push(...filter.statuses);
    }
    const sql = `SELECT * FROM experiments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq`;
    return (this.raw.prepare(sql).all(...vals) as Raw[]).map(mapExperiment);
  }

  // ---- runs ----------------------------------------------------------------

  insertRunStart(r: {
    runId: string;
    experimentId?: string | null;
    configId: string;
    configHash?: string | null;
    seed: number;
    phase: RunPhase;
    suite: Suite;
    provider?: string | null;
    model?: string | null;
    startedAt?: string;
    usedMockProvider?: boolean;
  }): RunRow {
    this.raw
      .prepare(
        `INSERT INTO runs (run_id, experiment_id, config_id, config_hash, seed, phase, suite, provider, model, started_at, status, used_mock_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        r.runId,
        r.experimentId ?? null,
        r.configId,
        r.configHash ?? null,
        r.seed,
        r.phase,
        r.suite,
        r.provider ?? null,
        r.model ?? null,
        r.startedAt ?? nowIso(),
        r.usedMockProvider ? 1 : 0,
      );
    return this.getRun(r.runId)!;
  }

  /** Finalize a running run from its CodingRunResult (one-time transition out of 'running'). */
  finishRun(runId: string, c: CodingRunResult, passed: boolean): RunRow {
    const u = c.usage;
    this.raw
      .prepare(
        `UPDATE runs SET config_hash = COALESCE(?, config_hash), image_id = ?, starter_hash = ?, started_at = ?, finished_at = ?,
           status = ?, failure_reason = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, cache_read_tokens = ?,
           cache_write_tokens = ?, total_tokens = ?, cost_usd = ?, cost_estimated = ?, usage_estimated = ?, model_calls = ?,
           tool_calls = ?, duration_ms = ?, used_mock_provider = ?, passed = ?
         WHERE run_id = ?`,
      )
      .run(
        c.configHash || null,
        c.imageId || null,
        c.starterHash || null,
        c.startedAt,
        c.finishedAt,
        c.status,
        c.failureReason ?? null,
        u.inputTokens,
        u.outputTokens,
        u.reasoningTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.totalTokens,
        u.costUsd,
        (u.costEstimated ?? u.anyEstimated) ? 1 : 0,
        u.anyEstimated ? 1 : 0,
        u.modelCalls,
        c.toolCalls,
        c.durationMs,
        c.usedMockProvider ? 1 : 0,
        passed ? 1 : 0,
        runId,
      );
    return this.getRun(runId)!;
  }

  /** Mark a running run as failed without a CodingRunResult (infra crash / interruption). */
  failRun(runId: string, status: RunStatus, reason: string): void {
    this.raw
      .prepare(`UPDATE runs SET status = ?, failure_reason = ?, finished_at = ?, passed = 0 WHERE run_id = ? AND status = 'running'`)
      .run(status, reason, nowIso(), runId);
  }

  getRun(runId: string): RunRow | null {
    const r = this.raw.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as Raw | undefined;
    return r ? mapRun(r) : null;
  }

  listRuns(filter: { experimentId?: string; configId?: string; phase?: RunPhase; limit?: number } = {}): RunRow[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.experimentId) {
      where.push('experiment_id = ?');
      vals.push(filter.experimentId);
    }
    if (filter.configId) {
      where.push('config_id = ?');
      vals.push(filter.configId);
    }
    if (filter.phase) {
      where.push('phase = ?');
      vals.push(filter.phase);
    }
    let sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at, rowid`;
    if (filter.limit) sql += ` LIMIT ${Math.floor(filter.limit)}`;
    return (this.raw.prepare(sql).all(...vals) as Raw[]).map(mapRun);
  }

  // ---- evaluations ---------------------------------------------------------

  insertEvaluation(e: EvaluationResult): EvaluationRow {
    const u = e.evaluatorUsage;
    this.raw
      .prepare(
        `INSERT INTO evaluations (run_id, suite, seed, started_at, finished_at, app_started, passed, evaluator_failure, visual_score,
           visual_threshold, checks_json, failure_summary, evaluator_input_tokens, evaluator_output_tokens, evaluator_reasoning_tokens,
           evaluator_cache_read_tokens, evaluator_cache_write_tokens, evaluator_total_tokens, evaluator_cost_usd, evaluator_model_calls,
           evaluator_usage_estimated, report_path, browser_agent_skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.runId,
        e.suite,
        e.seed,
        e.startedAt,
        e.finishedAt,
        e.appStarted ? 1 : 0,
        e.passed ? 1 : 0,
        e.evaluatorFailure ? 1 : 0,
        e.visualScore,
        e.visualThreshold,
        JSON.stringify(e.checks ?? []),
        e.failureSummary ?? null,
        u?.inputTokens ?? 0,
        u?.outputTokens ?? 0,
        u?.reasoningTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.cacheWriteTokens ?? 0,
        u?.totalTokens ?? 0,
        u?.costUsd ?? 0,
        u?.modelCalls ?? 0,
        u?.anyEstimated ? 1 : 0,
        e.reportFile ?? null,
        e.browserAgentSkipped ? 1 : 0,
      );
    return this.listEvaluations(e.runId).find((x) => x.suite === e.suite)!;
  }

  listEvaluations(runId: string): EvaluationRow[] {
    return (this.raw.prepare(`SELECT * FROM evaluations WHERE run_id = ? ORDER BY id`).all(runId) as Raw[]).map(mapEvaluation);
  }

  // ---- usage records -------------------------------------------------------

  /** Insert raw UsageRecords; duplicates (same id) are ignored. Returns number inserted. */
  insertUsageRecords(records: UsageRecord[], ctx: { sessionId?: string | null; experimentId?: string | null; runId?: string | null } = {}): number {
    const stmt = this.raw.prepare(
      `INSERT OR IGNORE INTO usage_records (id, role, run_id, experiment_id, session_id, provider, model, timestamp, input_tokens,
         output_tokens, reasoning_tokens, reasoning_included_in_output, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd,
         cost_estimated, usage_estimated, purpose, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    this.raw.transaction(() => {
      for (const r of records) {
        const res = stmt.run(
          r.id,
          r.role,
          r.runId ?? ctx.runId ?? null,
          r.experimentId ?? ctx.experimentId ?? null,
          ctx.sessionId ?? null,
          r.provider,
          r.model,
          r.timestamp,
          r.inputTokens ?? 0,
          r.outputTokens ?? 0,
          r.reasoningTokens ?? 0,
          r.reasoningIncludedInOutput ? 1 : 0,
          r.cacheReadTokens ?? 0,
          r.cacheWriteTokens ?? 0,
          r.totalTokens ?? 0,
          r.costUsd ?? 0,
          r.costEstimated ? 1 : 0,
          r.usageEstimated ? 1 : 0,
          r.purpose ?? null,
          r.raw === undefined ? null : JSON.stringify(r.raw),
        );
        n += res.changes;
      }
    })();
    return n;
  }

  /** Raw usage_records totals per role (audit view; research totals are authoritative only here). */
  usageRecordTotalsByRole(filter: { sessionId?: string; experimentId?: string; runId?: string } = {}): RoleBreakdown {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.sessionId) (where.push('session_id = ?'), vals.push(filter.sessionId));
    if (filter.experimentId) (where.push('experiment_id = ?'), vals.push(filter.experimentId));
    if (filter.runId) (where.push('run_id = ?'), vals.push(filter.runId));
    const rows = this.raw
      .prepare(
        `SELECT role, SUM(input_tokens) i, SUM(output_tokens) o, SUM(reasoning_tokens) rs, SUM(cache_read_tokens) cr,
           SUM(cache_write_tokens) cw, SUM(total_tokens) t, SUM(cost_usd) c, COUNT(*) n, MAX(usage_estimated) est
         FROM usage_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY role`,
      )
      .all(...vals) as Raw[];
    const out: RoleBreakdown = { coding: emptyBreakdown(), evaluator: emptyBreakdown(), research: emptyBreakdown() };
    for (const r of rows) {
      const role = r.role as AgentRole;
      if (!(role in out)) continue;
      out[role] = {
        inputTokens: r.i ?? 0,
        outputTokens: r.o ?? 0,
        reasoningTokens: r.rs ?? 0,
        cacheReadTokens: r.cr ?? 0,
        cacheWriteTokens: r.cw ?? 0,
        totalTokens: r.t ?? 0,
        costUsd: r.c ?? 0,
        modelCalls: r.n ?? 0,
        anyEstimated: Boolean(r.est),
      };
    }
    return out;
  }

  listUsageRecords(filter: { role?: AgentRole; runId?: string; experimentId?: string; sessionId?: string } = {}): (UsageRecord & {
    sessionId: string | null;
  })[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.role) (where.push('role = ?'), vals.push(filter.role));
    if (filter.runId) (where.push('run_id = ?'), vals.push(filter.runId));
    if (filter.experimentId) (where.push('experiment_id = ?'), vals.push(filter.experimentId));
    if (filter.sessionId) (where.push('session_id = ?'), vals.push(filter.sessionId));
    const rows = this.raw
      .prepare(`SELECT * FROM usage_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp, rowid`)
      .all(...vals) as Raw[];
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      runId: r.run_id ?? undefined,
      experimentId: r.experiment_id ?? undefined,
      sessionId: r.session_id ?? null,
      provider: r.provider,
      model: r.model,
      timestamp: r.timestamp,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      reasoningTokens: r.reasoning_tokens,
      reasoningIncludedInOutput: Boolean(r.reasoning_included_in_output),
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
      costEstimated: Boolean(r.cost_estimated),
      usageEstimated: Boolean(r.usage_estimated),
      purpose: r.purpose ?? '',
      raw: parseJson(r.raw_json, null),
    }));
  }

  // ---- artifacts -----------------------------------------------------------

  insertArtifact(a: { runId?: string | null; experimentId?: string | null; kind: string; path: string; sha256: string; bytes: number }): ArtifactRow {
    const res = this.raw
      .prepare(`INSERT INTO artifacts (run_id, experiment_id, kind, path, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(a.runId ?? null, a.experimentId ?? null, a.kind, a.path, a.sha256, a.bytes, nowIso());
    return mapArtifact(this.raw.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(res.lastInsertRowid) as Raw);
  }

  listArtifacts(filter: { runId?: string; experimentId?: string } = {}): ArtifactRow[] {
    if (filter.runId) return (this.raw.prepare(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY id`).all(filter.runId) as Raw[]).map(mapArtifact);
    if (filter.experimentId)
      return (
        this.raw
          .prepare(
            `SELECT a.* FROM artifacts a LEFT JOIN runs r ON r.run_id = a.run_id
             WHERE a.experiment_id = ? OR r.experiment_id = ? ORDER BY a.id`,
          )
          .all(filter.experimentId, filter.experimentId) as Raw[]
      ).map(mapArtifact);
    return (this.raw.prepare(`SELECT * FROM artifacts ORDER BY id`).all() as Raw[]).map(mapArtifact);
  }

  // ---- best history --------------------------------------------------------

  recordPromotion(p: { experimentId: string; configId: string; summary: StoredSummary; promotedAt?: string }): BestEntry {
    if (p.summary.usedMockProvider) throw new Error('refusing to promote a mock-provider result');
    if (!p.summary.meetsQualityRequirements) throw new Error('refusing to promote a config that does not meet quality requirements');
    if (p.summary.browserAgentSkipped) throw new Error('refusing to promote a config evaluated without the browser agent ([NO-BROWSER-AGENT])');
    // Defense in depth: the summary may have been built by a caller that ignored the flag.
    const skipped = this.raw
      .prepare(
        `SELECT COUNT(*) n FROM evaluations v JOIN runs r ON r.run_id = v.run_id
         WHERE r.experiment_id = ? AND r.phase <> 'holdout' AND v.browser_agent_skipped = 1`,
      )
      .get(p.experimentId) as Raw;
    if (skipped.n > 0) throw new Error(`refusing to promote: ${skipped.n} evaluation(s) of ${p.experimentId} skipped the browser agent ([NO-BROWSER-AGENT])`);
    const prev = this.getBestVerified();
    const at = p.promotedAt ?? nowIso();
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `INSERT INTO best_history (experiment_id, config_id, median_tokens, pass_rate, summary_json, promoted_at, previous_config_id, previous_median_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.experimentId, p.configId, p.summary.medianTokens, p.summary.passRate, JSON.stringify(p.summary), at, prev?.configId ?? null, prev?.medianTokens ?? null);
      this.markConfigPromoted(p.configId, at);
    })();
    return this.getBestVerified()!;
  }

  getBestVerified(): BestEntry | null {
    const r = this.raw.prepare(`SELECT * FROM best_history ORDER BY seq DESC LIMIT 1`).get() as Raw | undefined;
    return r ? mapBest(r) : null;
  }

  /** Every promotion in order (the "best verified token usage over experiments" series). */
  getBestHistory(): (BestEntry & { experimentSeq: number | null })[] {
    return (
      this.raw
        .prepare(`SELECT b.*, e.seq AS experiment_seq FROM best_history b LEFT JOIN experiments e ON e.id = b.experiment_id ORDER BY b.seq`)
        .all() as Raw[]
    ).map((r) => ({ ...mapBest(r), experimentSeq: r.experiment_seq ?? null }));
  }

  // ---- recovery ------------------------------------------------------------

  /**
   * Mark leftovers of dead sessions as interrupted. Call once at startup of a process that owns
   * the research loop (single-writer). Returns counts.
   */
  recoverInterrupted(reason = 'process died before completion'): { sessions: number; experiments: number; runs: number } {
    let sessions = 0;
    let experiments = 0;
    let runs = 0;
    this.raw.transaction(() => {
      runs = this.raw
        .prepare(`UPDATE runs SET status = 'interrupted', failure_reason = ?, finished_at = ?, passed = 0 WHERE status = 'running'`)
        .run(reason, nowIso()).changes;
      const active = this.listExperiments({ statuses: ['pending', 'running', 'verifying'] });
      for (const e of active) {
        this.updateExperiment(e.id, { status: 'interrupted', error: reason });
        experiments++;
      }
      sessions = this.raw
        .prepare(`UPDATE research_sessions SET status = 'interrupted', stop_reason = COALESCE(stop_reason, ?), ended_at = ? WHERE status = 'running'`)
        .run(reason, nowIso()).changes;
    })();
    return { sessions, experiments, runs };
  }

  // ---- usage-limit waits ---------------------------------------------------

  insertUsageLimitWait(w: Omit<UsageLimitWaitRow, 'id'>): UsageLimitWaitRow {
    const info = this.raw
      .prepare(
        `INSERT INTO usage_limit_waits (session_id, experiment_id, run_id, source, detected_at, reset_at, planned_ms, waited_ms, outcome, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.sessionId, w.experimentId, w.runId, w.source, w.detectedAt, w.resetAt, Math.round(w.plannedMs), Math.round(w.waitedMs), w.outcome, w.note);
    return this.listUsageLimitWaits().find((r) => r.id === Number(info.lastInsertRowid))!;
  }

  listUsageLimitWaits(filter: { sessionId?: string } = {}): UsageLimitWaitRow[] {
    const rows = (
      filter.sessionId
        ? this.raw.prepare(`SELECT * FROM usage_limit_waits WHERE session_id = ? ORDER BY id`).all(filter.sessionId)
        : this.raw.prepare(`SELECT * FROM usage_limit_waits ORDER BY id`).all()
    ) as Raw[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id ?? null,
      experimentId: r.experiment_id ?? null,
      runId: r.run_id ?? null,
      source: r.source,
      detectedAt: r.detected_at,
      resetAt: r.reset_at ?? null,
      plannedMs: r.planned_ms,
      waitedMs: r.waited_ms,
      outcome: r.outcome,
      note: r.note ?? null,
    }));
  }

  /** Tokens per role attributed to a session (same sources as costAndTokensByRole). */
  sessionTokens(sessionId: string): RoleTotals {
    const b = this.costAndTokensByRole({ sessionId });
    const coding = b.coding.totalTokens;
    const evaluator = b.evaluator.totalTokens;
    const research = b.research.totalTokens;
    return { coding, evaluator, research, total: coding + evaluator + research };
  }

  // ---- query functions for dashboard / CLI ---------------------------------

  /** Totals per role: coding from runs, evaluator from evaluations, research from usage_records. */
  costAndTokensByRole(filter: { sessionId?: string; experimentId?: string } = {}): RoleBreakdown {
    const out: RoleBreakdown = { coding: emptyBreakdown(), evaluator: emptyBreakdown(), research: emptyBreakdown() };
    let runWhere = '';
    const runVals: unknown[] = [];
    if (filter.experimentId) {
      runWhere = 'WHERE r.experiment_id = ?';
      runVals.push(filter.experimentId);
    } else if (filter.sessionId) {
      runWhere = 'WHERE r.experiment_id IN (SELECT id FROM experiments WHERE session_id = ?)';
      runVals.push(filter.sessionId);
    }
    const c = this.raw
      .prepare(
        `SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(reasoning_tokens) rs, SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
           SUM(total_tokens) t, SUM(cost_usd) c, SUM(model_calls) n, MAX(usage_estimated) est FROM runs r ${runWhere}`,
      )
      .get(...runVals) as Raw;
    out.coding = {
      inputTokens: c.i ?? 0,
      outputTokens: c.o ?? 0,
      reasoningTokens: c.rs ?? 0,
      cacheReadTokens: c.cr ?? 0,
      cacheWriteTokens: c.cw ?? 0,
      totalTokens: c.t ?? 0,
      costUsd: c.c ?? 0,
      modelCalls: c.n ?? 0,
      anyEstimated: Boolean(c.est),
    };
    const e = this.raw
      .prepare(
        `SELECT SUM(v.evaluator_input_tokens) i, SUM(v.evaluator_output_tokens) o, SUM(v.evaluator_reasoning_tokens) rs,
           SUM(v.evaluator_cache_read_tokens) cr, SUM(v.evaluator_cache_write_tokens) cw, SUM(v.evaluator_total_tokens) t,
           SUM(v.evaluator_cost_usd) c, SUM(v.evaluator_model_calls) n, MAX(v.evaluator_usage_estimated) est
         FROM evaluations v JOIN runs r ON r.run_id = v.run_id ${runWhere}`,
      )
      .get(...runVals) as Raw;
    out.evaluator = {
      inputTokens: e.i ?? 0,
      outputTokens: e.o ?? 0,
      reasoningTokens: e.rs ?? 0,
      cacheReadTokens: e.cr ?? 0,
      cacheWriteTokens: e.cw ?? 0,
      totalTokens: e.t ?? 0,
      costUsd: e.c ?? 0,
      modelCalls: e.n ?? 0,
      anyEstimated: Boolean(e.est),
    };
    out.research = this.usageRecordTotalsByRole({ sessionId: filter.sessionId, experimentId: filter.experimentId }).research;
    return out;
  }

  private aggregateExperiment(e: ExperimentRow, bestMedian: number | null): ExperimentListItem {
    const runs = this.listRuns({ experimentId: e.id });
    const quick = runs.filter((r) => r.phase === 'quick');
    const verify = runs.filter((r) => r.phase === 'verify');
    // Runs cut short by a subscription usage limit were retried; they never count toward summaries.
    const finished = (rs: RunRow[]) => rs.filter((r) => r.status !== 'running' && !isUsageLimitRun(r.failureReason));
    // Manual batches (`npm run benchmark`) have neither quick nor verify runs: aggregate their dev runs.
    const manual = runs.filter((r) => r.phase === 'manual' && r.suite === 'dev');
    const basis = finished(verify.length ? verify : quick.length ? quick : manual);
    const tokens = basis.map((r) => r.totalTokens);
    const visuals: number[] = [];
    for (const r of basis) {
      const ev = this.listEvaluations(r.runId).find((x) => x.suite === 'dev');
      if (ev?.visualScore !== null && ev?.visualScore !== undefined) visuals.push(ev.visualScore);
    }
    const anyBrowserAgentSkipped =
      Boolean(e.summary?.browserAgentSkipped) || runs.some((r) => this.listEvaluations(r.runId).some((v) => v.browserAgentSkipped));
    const roles = this.costAndTokensByRole({ experimentId: e.id });
    const med = median(tokens);
    const verifyDone = finished(verify);
    return {
      ...e,
      runsTotal: runs.length,
      quickRuns: quick.length,
      verifyRuns: verifyDone.length,
      verifyPasses: verifyDone.filter((r) => r.passed).length,
      passRate: basis.length ? basis.filter((r) => r.passed).length / basis.length : null,
      medianTokens: med,
      meanTokens: mean(tokens),
      medianVisualScore: median(visuals),
      medianDurationMs: median(basis.map((r) => r.durationMs)),
      meanToolCalls: mean(basis.map((r) => r.toolCalls)),
      totalCostUsd: roles.coding.costUsd + roles.evaluator.costUsd + roles.research.costUsd,
      researchCostUsd: roles.research.costUsd,
      improvementVsBestPct: med !== null && bestMedian ? ((bestMedian - med) / bestMedian) * 100 : null,
      anyMock: e.isMock || runs.some((r) => r.usedMockProvider),
      anyBrowserAgentSkipped,
    };
  }

  /** Experiment history table with per-experiment aggregates. */
  listExperimentsWithAggregates(filter: { sessionId?: string } = {}): ExperimentListItem[] {
    const best = this.getBestVerified();
    return this.listExperiments(filter).map((e) => this.aggregateExperiment(e, best?.medianTokens ?? null));
  }

  getExperimentDetail(id: string): ExperimentDetail | null {
    const e = this.getExperiment(id);
    if (!e) return null;
    const best = this.getBestVerified();
    const runs = this.listRuns({ experimentId: id }).map((r) => ({ ...r, evaluations: this.listEvaluations(r.runId) }));
    return {
      experiment: this.aggregateExperiment(e, best?.medianTokens ?? null),
      runs,
      usageByRole: this.costAndTokensByRole({ experimentId: id }),
      artifacts: this.listArtifacts({ experimentId: id }),
      config: e.candidateConfigId ? this.getConfig(e.candidateConfigId) : null,
      parentConfig: e.parentConfigId ? this.getConfig(e.parentConfigId) : null,
    };
  }

  getOverview(): Overview {
    const best = this.getBestVerified();
    const baseRow = this.raw
      .prepare(`SELECT * FROM experiments WHERE kind = 'baseline' AND status = 'completed' ORDER BY seq DESC LIMIT 1`)
      .get() as Raw | undefined;
    const baseExp = baseRow ? mapExperiment(baseRow) : null;
    const baseline = baseExp
      ? {
          experimentId: baseExp.id,
          configId: baseExp.candidateConfigId ?? 'baseline',
          medianTokens: baseExp.summary?.medianTokens ?? null,
          meetsQuality: Boolean(baseExp.summary?.meetsQualityRequirements),
          isMock: baseExp.isMock,
        }
      : null;
    const byOutcome: Record<string, number> = {};
    for (const r of this.raw.prepare(`SELECT COALESCE(outcome, status) k, COUNT(*) n FROM experiments GROUP BY k`).all() as Raw[]) {
      byOutcome[r.k] = r.n;
    }
    const counts = this.raw
      .prepare(
        `SELECT COUNT(*) total, SUM(CASE WHEN status IN ('completed','rejected','failed','interrupted') THEN 1 ELSE 0 END) fin,
           SUM(is_mock) mock FROM experiments`,
      )
      .get() as Raw;
    const runCounts = this.raw
      .prepare(`SELECT COUNT(*) total, SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) passed, SUM(used_mock_provider) mock FROM runs`)
      .get() as Raw;
    const roles = this.costAndTokensByRole();
    const latest = this.latestSession();
    // Column exists from schema v2; read-only viewers may open an older DB.
    let anyBrowserAgentSkipped = false;
    if (this.schemaVersion() >= 2) {
      anyBrowserAgentSkipped = Boolean((this.raw.prepare(`SELECT MAX(browser_agent_skipped) m FROM evaluations`).get() as Raw).m);
    }
    return {
      best,
      baseline,
      improvementPct:
        best && baseline?.medianTokens ? ((baseline.medianTokens - best.medianTokens) / baseline.medianTokens) * 100 : null,
      experimentsTotal: counts.total ?? 0,
      experimentsFinished: counts.fin ?? 0,
      experimentsByOutcome: byOutcome,
      runsTotal: runCounts.total ?? 0,
      runsPassed: runCounts.passed ?? 0,
      costByRole: {
        coding: roles.coding.costUsd,
        evaluator: roles.evaluator.costUsd,
        research: roles.research.costUsd,
        total: roles.coding.costUsd + roles.evaluator.costUsd + roles.research.costUsd,
      },
      tokensByRole: {
        coding: roles.coding.totalTokens,
        evaluator: roles.evaluator.totalTokens,
        research: roles.research.totalTokens,
        total: roles.coding.totalTokens + roles.evaluator.totalTokens + roles.research.totalTokens,
      },
      anyMock: Boolean(counts.mock) || Boolean(runCounts.mock),
      anyBrowserAgentSkipped,
      activeSession: latest && latest.status === 'running' ? latest : null,
    };
  }

  /** Cumulative cost series over time, one point per cost event (run finish, evaluation finish, research call). */
  getResearchCostOverTime(): CostPoint[] {
    const events: { timestamp: string; role: AgentRole; costUsd: number }[] = [];
    for (const r of this.raw.prepare(`SELECT finished_at t, cost_usd c FROM runs WHERE finished_at IS NOT NULL`).all() as Raw[])
      events.push({ timestamp: r.t, role: 'coding', costUsd: r.c ?? 0 });
    for (const r of this.raw
      .prepare(`SELECT COALESCE(finished_at, started_at) t, evaluator_cost_usd c FROM evaluations WHERE COALESCE(finished_at, started_at) IS NOT NULL`)
      .all() as Raw[])
      events.push({ timestamp: r.t, role: 'evaluator', costUsd: r.c ?? 0 });
    for (const r of this.raw.prepare(`SELECT timestamp t, cost_usd c FROM usage_records WHERE role = 'research'`).all() as Raw[])
      events.push({ timestamp: r.t, role: 'research', costUsd: r.c ?? 0 });
    events.sort((a, c) => a.timestamp.localeCompare(c.timestamp));
    const cum: RoleTotals = { coding: 0, evaluator: 0, research: 0, total: 0 };
    return events.map((ev) => {
      cum[ev.role] += ev.costUsd;
      cum.total += ev.costUsd;
      return { ...ev, cumulativeUsd: cum.total, cumulativeByRole: { ...cum } };
    });
  }

  /** One point per finished run with a dev evaluation: tokens vs visual score / pass. */
  getTokensVsQuality(): {
    runId: string;
    experimentId: string | null;
    configId: string;
    phase: RunPhase;
    totalTokens: number;
    visualScore: number | null;
    passed: boolean;
    usedMockProvider: boolean;
  }[] {
    return (
      this.raw
        .prepare(
          `SELECT r.run_id, r.experiment_id, r.config_id, r.phase, r.total_tokens, r.passed, r.used_mock_provider, v.visual_score
           FROM runs r LEFT JOIN evaluations v ON v.run_id = r.run_id AND v.suite = r.suite
           WHERE r.status <> 'running' AND r.suite = 'dev' AND IFNULL(r.failure_reason, '') NOT LIKE '${USAGE_LIMIT_REASON}%' ORDER BY r.started_at`,
        )
        .all() as Raw[]
    ).map((r) => ({
      runId: r.run_id,
      experimentId: r.experiment_id ?? null,
      configId: r.config_id,
      phase: r.phase,
      totalTokens: r.total_tokens,
      visualScore: r.visual_score ?? null,
      passed: Boolean(r.passed),
      usedMockProvider: Boolean(r.used_mock_provider),
    }));
  }

  /** Pass rate per configuration over finished dev runs. */
  getPassRateByConfig(): { configId: string; runs: number; passes: number; passRate: number; medianTokens: number | null; anyMock: boolean }[] {
    const rows = this.raw
      .prepare(`SELECT config_id, total_tokens, passed, used_mock_provider FROM runs WHERE status <> 'running' AND suite = 'dev' AND IFNULL(failure_reason, '') NOT LIKE '${USAGE_LIMIT_REASON}%' ORDER BY config_id`)
      .all() as Raw[];
    const by = new Map<string, { tokens: number[]; passes: number; mock: boolean }>();
    for (const r of rows) {
      const g = by.get(r.config_id) ?? { tokens: [], passes: 0, mock: false };
      g.tokens.push(r.total_tokens);
      if (r.passed) g.passes++;
      if (r.used_mock_provider) g.mock = true;
      by.set(r.config_id, g);
    }
    return [...by.entries()].map(([configId, g]) => ({
      configId,
      runs: g.tokens.length,
      passes: g.passes,
      passRate: g.passes / g.tokens.length,
      medianTokens: median(g.tokens),
      anyMock: g.mock,
    }));
  }
}

export function openDb(path?: string, opts?: OpenDbOptions): Db {
  return new Db(path || process.env.FRUGAL_DB_PATH || DEFAULT_DB_PATH, opts);
}

/**
 * Read-only handle for viewers (dashboard): same query methods; any write throws
 * (SQLITE_READONLY). The DB file must already exist.
 */
export function openDbReadOnly(path?: string): Db {
  return new Db(path || process.env.FRUGAL_DB_PATH || DEFAULT_DB_PATH, { readOnly: true });
}
