/**
 * Shared contracts for the whole system. Every module (runner, evaluator,
 * researcher, storage, dashboard) builds against these types.
 * Change them only with care — other modules depend on them.
 */

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

/** Which agent consumed tokens. Tracked and reported separately. */
export type AgentRole = 'coding' | 'evaluator' | 'research';

/** One provider call's usage — the authoritative accounting unit. */
export interface UsageRecord {
  id: string;
  role: AgentRole;
  runId?: string;
  experimentId?: string;
  provider: string; // 'anthropic' | 'mock' | ...
  model: string;
  timestamp: string; // ISO
  /** Uncached input tokens as reported by the provider. */
  inputTokens: number;
  outputTokens: number;
  /** Reasoning/thinking tokens when the provider reports them separately. */
  reasoningTokens: number;
  /** True when reasoningTokens are already counted inside outputTokens (do NOT add again). */
  reasoningIncludedInOutput: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cacheRead + cacheWrite (+ reasoning only if not included in output). */
  totalTokens: number;
  costUsd: number;
  /** Cost computed from a local price table rather than billed by the provider. */
  costEstimated: boolean;
  /** Token counts are estimates (provider gave no usage). Never present as exact. */
  usageEstimated: boolean;
  /** Purpose label: 'agent-turn' | 'compaction' | 'retry' | 'summarize-tool-output' | ... */
  purpose: string;
  /** Raw provider usage object, stored verbatim for audit. */
  raw: unknown;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  modelCalls: number;
  /** True if ANY constituent record was estimated. */
  anyEstimated: boolean;
  /** (runner addition) True if any constituent record's cost was computed locally, not billed. */
  costEstimated?: boolean;
}

// ---------------------------------------------------------------------------
// Model providers (neutral message format, Anthropic-like blocks)
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; dataBase64: string };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /**
   * (runner addition) Opaque provider-native content for this assistant turn (e.g. Anthropic
   * thinking blocks + signatures) that must be replayed verbatim on the next request. Providers
   * ignore it when `provider`/`model` differ. Dropping it is always safe; editing it is not.
   */
  providerState?: ProviderState;
}

/** (runner addition) Provider-native replay data attached to assistant messages. */
export interface ProviderState {
  provider: string;
  model: string;
  content: unknown[];
  /** Provider stop reason before mapping to the neutral set. */
  rawStopReason?: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxOutputTokens: number;
  temperature?: number;
  /** Enable provider prompt caching where supported. */
  promptCaching?: boolean;
  /** Extended thinking budget, 0/undefined = off. */
  thinkingBudget?: number;
  /** (runner addition) Provider effort level where supported (Anthropic output_config.effort). */
  effort?: Effort;
  /** (runner addition) Purpose label for accounting ('agent-turn', 'compaction', ...). */
  purpose?: string;
  /** (runner addition) Cancels the in-flight call (and pending retries). */
  signal?: AbortSignal;
  /**
   * (runner addition) Called by providers that retry internally, once per FAILED attempt that the
   * provider billed (e.g. a stream that died mid-response). TokenTracker records these as 'retry'.
   */
  onBilledFailedAttempt?: (usage: ModelResponse['usage']) => void;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';
  /** Usage without role/run ids — the gateway attaches those. */
  usage: Omit<UsageRecord, 'id' | 'role' | 'runId' | 'experimentId' | 'timestamp' | 'purpose'>;
  /** (runner addition) Provider-native content to store on the assistant Message for replay. */
  providerState?: ProviderState;
}

export interface ModelProvider {
  readonly name: string;
  /** True for the mock provider; results from it must never be reported as real. */
  readonly isMock: boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------------
// Agent configuration (what the researcher is allowed to change)
// ---------------------------------------------------------------------------

export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'list_dir' | 'run_command' | 'view_image';

export interface ToolConfig {
  name: ToolName;
  enabled: boolean;
  /** Override the default description shown to the model. */
  description?: string;
  /** Truncate tool output beyond this many characters (head+tail kept). */
  maxOutputChars?: number;
  /** 'raw' | 'truncate' | 'summarize' (summarize = extra model call, counted as coding tokens). */
  outputMode?: 'raw' | 'truncate' | 'summarize';
  /** run_command only: default timeout. */
  timeoutSec?: number;
}

export interface ContextConfig {
  /** 'none' | 'drop-old-tool-results' | 'summarize' */
  strategy: 'none' | 'drop-old-tool-results' | 'summarize';
  /** Trigger compaction when estimated context exceeds this many tokens. */
  compactAtTokens?: number;
  /** For drop-old-tool-results: keep this many most recent tool results verbatim. */
  keepRecentToolResults?: number;
}

/** On-disk layout: configs/<id>/{config.json, system-prompt.md, tools.json, skills/*.md} */
export interface AgentConfig {
  id: string; // e.g. 'baseline' or 'experiments/001'
  parentId?: string;
  description?: string;
  provider: string; // 'anthropic' | 'mock'
  model: string; // e.g. 'claude-sonnet-5-5'
  temperature?: number;
  maxOutputTokensPerCall: number;
  thinkingBudget?: number;
  /** (runner addition) Provider effort level (Anthropic: low|medium|high|xhigh|max). Omit = model default. */
  effort?: Effort;
  promptCaching: boolean;
  /** Whether to show the reference design image to the agent up front, on demand, or not. */
  designDelivery: 'inline-image' | 'file-only';
  /** Which spec files to include inline in the first user message (others available on disk). */
  inlineSpecFiles: string[];
  systemPrompt: string; // loaded from system-prompt.md
  skills: { name: string; content: string }[]; // loaded from skills/*.md, appended to system prompt
  tools: ToolConfig[]; // loaded from tools.json
  context: ContextConfig;
  limits: RunLimits;
  /**
   * (runner addition) Agent backend. 'api' (default when absent) = the runner's own agent loop
   * calling the provider API; 'claude-code' = the real Claude Code CLI inside the coding container,
   * authenticated with the user's subscription through the host gateway (runner/gateway.ts).
   */
  backend?: AgentBackend;
  /** (runner addition) Claude Code options; only valid with backend 'claude-code'. */
  claudeCode?: ClaudeCodeConfig;
  /** (runner addition) Content of the config's CLAUDE.md (loaded when claudeCode.claudeMd is true). */
  claudeMdContent?: string;
  /**
   * (config-surface addition, claude-code only) Helper scripts from bin/<name> (shebang required).
   * Installed root-owned and read-only at /opt/frugal/bin/<name> (on PATH) behind an audit wrapper.
   * Absent when the config has no bin/ files (so existing hashes are unchanged).
   */
  bin?: { name: string; content: string }[];
  /** (config-surface addition, claude-code only) Custom subagents from agents/<name>.md → ~/.claude/agents/. */
  agents?: { name: string; content: string }[];
  /** (config-surface addition, claude-code only) Slash commands from commands/<name>.md → ~/.claude/commands/. */
  commands?: { name: string; content: string }[];
}

export type AgentBackend = 'api' | 'claude-code';

export interface ClaudeCodeConfig {
  /** 'append' = --append-system-prompt <system-prompt.md>; 'replace' = --system-prompt <system-prompt.md>. */
  systemPromptMode: 'append' | 'replace';
  /** Built-in tool set (--tools). Omitted = Claude Code's default set. */
  tools?: string[];
  /** --disallowedTools */
  disallowedTools?: string[];
  /** Written to a settings file and passed with --settings (keys like env/model/apiKeyHelper are rejected). */
  settings?: Record<string, unknown>;
  /** Extra env for the claude process; keys restricted to CLAUDE_CODE_ENV_ALLOWLIST (runner/claude-code.ts). */
  env?: Record<string, string>;
  /** Place the config's CLAUDE.md at /home/node/.claude/CLAUDE.md (user level, outside /workspace). */
  claudeMd?: boolean;
}

export interface RunLimits {
  maxTotalTokens: number;
  maxModelCalls: number;
  maxRuntimeSec: number;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface Sandbox {
  readonly containerId: string;
  readonly imageId: string;
  exec(command: string, opts?: { timeoutSec?: number; cwd?: string }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  /** Copy a path out of the container to the host (used for the app snapshot). */
  copyOut(containerPath: string, hostPath: string): Promise<void>;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Coding run
// ---------------------------------------------------------------------------

export type RunStatus = 'completed' | 'limit_exceeded' | 'agent_error' | 'infra_error' | 'interrupted';

export interface CodingRunResult {
  runId: string;
  experimentId?: string;
  configId: string;
  seed: number;
  status: RunStatus;
  failureReason?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  imageId: string;
  starterHash: string;
  configHash: string;
  usage: TokenTotals; // coding-agent role only
  toolCalls: number;
  /** Host paths (relative to repo root) under results/runs/<runId>/ */
  artifacts: {
    appSnapshotDir: string; // results/runs/<runId>/app
    traceFile: string; // trace.jsonl
    usageFile: string; // usage.jsonl (raw UsageRecords)
    configSnapshotDir: string;
  };
  usedMockProvider: boolean;
  /** (runner addition) Limits actually enforced: min(config.limits, limitsOverride) per field. */
  effectiveLimits?: RunLimits;
  /** (runner addition) Backend that produced this run ('api' when absent). */
  backend?: AgentBackend;
  /**
   * (runner addition) Set when a Claude subscription usage limit stopped the run (status 'infra_error',
   * failureReason 'usage_limit'): ISO time the limit resets. The research loop should wait and retry
   * instead of counting the run as a failed config.
   */
  usageLimitResetAt?: string;
  /**
   * (runner addition) claude-code backend: gateway totals (authoritative) vs the totals Claude Code
   * reported in its final stream `result`. `match` is false when they differ.
   */
  usageCrossCheck?: {
    gateway: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; modelCalls: number };
    stream: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | null;
    match: boolean;
    note?: string;
  };
  /** (config-guard addition) Runtime anti-cheating audit of a claude-code run (see researcher/config-guard.ts). */
  configAudit?: ConfigRunAudit;
}

/** One invocation of a config bin script inside the coding container (written by the audit wrapper). */
export interface BinInvocation {
  ts: string;
  script: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  /** Files under /workspace (excluding node_modules, dist, .git, databases) created or modified while it ran. */
  changedFiles: string[];
}

export interface ConfigRunAudit {
  /** Every /opt/frugal/bin script run (agent Bash calls and hooks), from the in-container audit log. */
  binInvocations: BinInvocation[];
  /** Per-script invocation counts. */
  binCounts: Record<string, number>;
  /** App source files (by extension) that a bin script created/modified. Non-empty = cheating evidence. */
  binSourceWrites: string[];
  /** Completed hook runs seen in the stream (--include-hook-events), per hook name "<event>:<matcher>". */
  hookCounts: Record<string, number>;
  /** Similarity of config content to the produced app snapshot (winnowed shingles). */
  snapshotOverlap?: { configFile: string; appFile: string; matched: number; ratio: number; channel?: 'exact' | 'norm'; exceeds?: boolean } | null;
  /** True when the audit found evidence that app code came from the config (the run is then failed). */
  flagged: boolean;
  reasons: string[];
  /** Audit limitations (e.g. the log is writable by the agent user). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type CheckOutcome = 'pass' | 'fail' | 'error'; // error = evaluator infrastructure failure

export interface CheckResult {
  id: string; // e.g. 'api.create.valid', 'browser.persistence'
  category: 'startup' | 'backend' | 'functional' | 'browser' | 'visual';
  mandatory: boolean;
  outcome: CheckOutcome;
  message?: string;
  evidence?: string[]; // artifact paths (screenshots, traces)
  attempts: number;
}

export interface EvaluationResult {
  runId: string;
  suite: 'dev' | 'holdout';
  seed: number;
  startedAt: string;
  finishedAt: string;
  appStarted: boolean;
  checks: CheckResult[];
  visualScore: number; // 0-100
  visualThreshold: number;
  passed: boolean; // computed by evaluator/score.ts ONLY
  /** True if evaluation could not be completed due to evaluator infra issues (not the app's fault). */
  evaluatorFailure: boolean;
  failureSummary?: string;
  evaluatorUsage: TokenTotals; // browser-agent / vision-model tokens
  reportFile: string; // results/runs/<runId>/eval/report.json
  /**
   * (integration addition) True when the LLM browser-agent scenarios were NOT run
   * (skipBrowserAgent). Such an evaluation is incomplete: it may say passed=true for the checks
   * that did run, but it can never count toward promotion / best config.
   */
  browserAgentSkipped?: boolean;
  /**
   * (subscription addition) Set when the evaluator's Claude subscription hit its usage limit during
   * this evaluation (ISO reset time, or '' if unknown). The affected checks are 'error'
   * (evaluatorFailure); the research loop waits for the reset and retries the whole run instead of
   * counting it as a config failure.
   */
  usageLimitResetAt?: string;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ExperimentStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'rejected' | 'interrupted' | 'failed';
export type ExperimentOutcome = 'promoted' | 'not_better' | 'failed_quick_run' | 'failed_verification' | 'baseline' | 'error' | null;

export interface Experiment {
  id: string;
  parentConfigId: string | null;
  candidateConfigId: string;
  hypothesis: string;
  changes: string; // human-readable diff summary
  provider: string;
  model: string;
  createdAt: string;
  status: ExperimentStatus;
  outcome: ExperimentOutcome;
}

export interface VerificationSummary {
  configId: string;
  runs: number;
  passes: number;
  passRate: number;
  medianTokens: number;
  meanTokens: number;
  tokenVariance: number;
  medianVisualScore: number;
  totalCostUsd: number;
  medianDurationMs: number;
  meetsQualityRequirements: boolean; // all runs passed
}
