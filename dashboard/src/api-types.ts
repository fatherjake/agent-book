/**
 * JSON shapes returned by the dashboard server (scripts/dashboard.ts).
 * Shared by the server (type-only import) and the React client.
 */

export type Role = 'coding' | 'evaluator' | 'research';

export interface RoleCost {
  tokens: number;
  costUsd: number;
  calls: number;
}

export interface ConfigSummary {
  configId: string;
  experimentId: string | null;
  runs: number;
  passes: number;
  passRate: number;
  medianTokens: number | null;
  medianVisualScore: number | null;
  verified: boolean;
  isMock: boolean;
}

export interface Overview {
  generatedAt: string;
  dbPath: string;
  anyMock: boolean;
  allMock: boolean;
  /** Some evaluation skipped the LLM browser agent ([NO-BROWSER-AGENT]): never eligible for promotion. */
  anyNoBrowserAgent: boolean;
  /** Best verified configuration among REAL (non-mock) results. */
  best: ConfigSummary | null;
  /** Best verified configuration among mock results — shown only with a [MOCK] badge. */
  mockBest: ConfigSummary | null;
  baseline: ConfigSummary | null;
  /** (baseline - best) / baseline * 100, using best (or mockBest when everything is mock). */
  improvementPct: number | null;
  improvementIsMock: boolean;
  experiments: { total: number; completed: number; running: number; byOutcome: Record<string, number> };
  runs: { total: number; evaluated: number; passed: number };
  cost: { coding: RoleCost; evaluator: RoleCost; research: RoleCost; totalUsd: number };
}

export interface ExperimentRow {
  id: string;
  /** Benchmark task the experiment ran on (docs/TASKS.md); 'todo' for older rows. */
  taskId: string;
  createdAt: string;
  provider: string;
  model: string;
  configId: string;
  parentConfigId: string | null;
  status: string;
  outcome: string | null;
  hypothesis: string;
  /** null = no evaluated runs yet. */
  passed: boolean | null;
  runs: number;
  passes: number;
  passRate: number | null;
  medianTokens: number | null;
  costUsd: number;
  /** Median wall clock per run: coding start → end of evaluation. */
  medianDurationMs: number | null;
  /**
   * Wall clock of the whole experiment: created (before the research agent's proposal) → finished, covering
   * the proposal, quick run, verification runs, evaluations and holdout. Still running: up to now.
   */
  totalMs: number | null;
  visualScore: number | null;
  /** (bestTokens - medianTokens) / bestTokens * 100 vs the best of the experiment's own task; positive = fewer tokens than the best. */
  improvementVsBestPct: number | null;
  isMock: boolean;
  /** Flagged as cheating by a human (directly, or inherited from the parent config). */
  cheating: { reason: string; flaggedAt: string; inheritedFrom: string | null } | null;
}

export interface RunRow {
  id: string;
  experimentId: string | null;
  configId: string;
  seed: number | null;
  status: string;
  passed: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Wall clock: coding start → end of evaluation. */
  durationMs: number | null;
  /** Coding agent only. */
  codingMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  toolCalls: number | null;
  visualScore: number | null;
  failureReason: string | null;
  imageId: string | null;
  starterHash: string | null;
  isMock: boolean;
}

export interface ExperimentDetail {
  experiment: ExperimentRow & { changes: string; changeSummary: string | null; error: string | null; notes: string | null; kind: string };
  /** Unified-diff-ish text of the config change, if one could be found. */
  configDiff: string | null;
  runs: RunRow[];
  artifacts: ArtifactRef[];
}

export interface ArtifactRef {
  kind: string;
  path: string; // relative to repo root, e.g. results/runs/<id>/trace.jsonl
  url: string | null; // /artifacts/... when inside results/
  sha256: string | null;
  bytes: number | null;
}

export interface CheckRow {
  id: string;
  category: string;
  mandatory: boolean;
  outcome: 'pass' | 'fail' | 'error' | string;
  message: string | null;
  evidence: string[];
  attempts: number;
}

export interface EvaluationView {
  suite: string;
  passed: boolean | null;
  appStarted: boolean | null;
  visualScore: number | null;
  visualThreshold: number | null;
  evaluatorFailure: boolean;
  failureSummary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  checks: CheckRow[];
  reportUrl: string | null;
  browserAgentSkipped: boolean;
}

export interface TokenBreakdownRow {
  role: Role | string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
  anyEstimated: boolean;
}

export interface TraceEntry {
  [key: string]: unknown;
}

export interface RunDetail {
  run: RunRow;
  evaluations: EvaluationView[];
  tokens: TokenBreakdownRow[];
  screenshots: { url: string; name: string }[];
  artifacts: ArtifactRef[];
  trace: { url: string | null; entries: TraceEntry[]; truncated: boolean; totalLines: number };
  /** /artifacts URL of the run's session token profile (researcher/session-profile.ts), when present. */
  profileUrl?: string | null;
}

/** Subset of researcher/session-profile.ts SessionProfile used by the dashboard. */
export interface SessionProfileView {
  version: number;
  runId: string;
  backend: string;
  model: string | null;
  usedMockProvider: boolean;
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; thinkingTokens: number; totalTokens: number; modelCalls: number };
  byPurpose: Record<string, { calls: number; totalTokens: number }>;
  overhead: {
    firstCallContextTokens: number | null;
    firstCallCacheReadTokens: number | null;
    userPromptTokensEst: number | null;
    fixedOverheadTokensEst: number | null;
    overheadReReadTokensEst: number | null;
    overheadShareOfTotal: number | null;
    method: string;
  };
  calls: {
    index: number;
    purpose: string;
    thread: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    thinkingTokens: number;
    totalTokens: number;
    contextTokens: number;
    contextDelta: number | null;
    tools: string[];
    textChars: number;
  }[];
  tools: {
    id: string;
    callIndex: number | null;
    name: string;
    inputSummary: string;
    outputChars: number;
    images: number;
    outputTokensEst: number;
    isError: boolean;
    remainingCalls: number;
    carriedTokensEst: number;
  }[];
  waste: { kind: string; severity: 'info' | 'low' | 'medium' | 'high'; title: string; evidence: string[]; tokens: number; tokensEstimated: boolean }[];
  notes: string[];
}

export interface Charts {
  bestOverTime: {
    index: number;
    experimentId: string;
    createdAt: string;
    medianTokens: number | null;
    passed: boolean | null;
    bestTokens: number | null;
    isMock: boolean;
  }[];
  scatter: {
    runId: string;
    experimentId: string | null;
    configId: string;
    tokens: number;
    visualScore: number | null;
    passed: boolean | null;
    isMock: boolean;
  }[];
  passRateByConfig: { configId: string; runs: number; passes: number; passRate: number; isMock: boolean }[];
  costOverTime: { timestamp: string; coding: number; evaluator: number; research: number; total: number }[];
}

// ---- chat pane (dashboard/server/chat.ts) -------------------------------------------------------

export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; label: string };
export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
}
export interface ChatInfo {
  /** False when the dashboard is not bound to loopback: chat requests are refused. */
  enabled: boolean;
  /** Claude Code session id; continue in a terminal with `claude --resume <id>`. */
  sessionId: string;
  started: boolean;
  messages: ChatMessage[];
  busy: boolean;
}
