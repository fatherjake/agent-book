/** Research settings (configs/research.json) with defaults and validation. */
import { existsSync, readFileSync } from 'node:fs';
import type { Effort } from '../runner/types.js';
import type { ResearchBudgets } from '../storage/db.js';

export const DEFAULT_RESEARCH_SETTINGS_PATH = 'configs/research.json';

export interface ResearchSettings extends ResearchBudgets {
  /** Provider/model of the research agent itself. */
  researchProvider: string;
  researchModel: string;
  researchEffort: Effort | null;
  researchMaxOutputTokens: number;
  /**
   * 'agentic' (default): the research agent runs in a sandbox container with Read/Grep/Glob/Bash and
   * studies past coding sessions (researcher/research-workspace.ts). 'simple': one host call with no
   * tools and a text digest (the old mode). Only applies to researchProvider 'claude-code'.
   */
  researchMode: ResearchMode;
  /** Agentic mode: wall clock per proposal (incl. the one feedback attempt). */
  researchMaxRuntimeSec: number;
  /** Agentic mode: research tokens per proposal (enforced by the research gateway). */
  researchMaxTotalTokens: number;
  /** Agentic mode: what goes into the research workspace. */
  researchWorkspace: { maxExperiments: number; maxRuns: number; maxRunMB: number };
  /** Override the coding (and evaluator) provider for all runs; null = use each config's provider. */
  codingProvider: string | null;
  /** Runs in the quick screen (1 per TASK §10). */
  quickRuns: number;
  /**
   * Benchmark runs executed in parallel within a batch (verification, baseline, holdout). Each run is
   * fully isolated (own containers/network/gateway/ports). Budgets are checked before each run starts,
   * so they can be overshot by up to runConcurrency-1 in-flight runs.
   */
  runConcurrency: number;
  /** Required improvement over the best median, in percent (0 = any strict improvement). */
  noiseMarginPct: number;
  /**
   * Skip verification when the quick run used more than ratio × the best verified median (null = never
   * skip). 1.0 (default) = only verify candidates whose quick run already beat the current best.
   */
  quickRunMaxTokenRatio: number | null;
  /** For the first N candidate experiments, exactly one major variable may change. */
  singleVariableExperiments: number;
  allowModelChange: boolean;
  allowedModels: string[];
  holdout: { onPromotion: boolean; runs: number };
  pausePollSec: number;
  historyMaxExperiments: number;
  maxConsecutiveProposalFailures: number;
  skipBrowserAgent: boolean;
  /**
   * Longest single wait for a Claude subscription usage-limit reset. If the reported reset is
   * further away (or limits keep recurring without a known reset), the loop stops with 'usage_limit'.
   */
  maxUsageLimitWaitSec: number;
  /** Extra time added after the reported reset before retrying. */
  usageLimitMarginSec: number;
  /** Wait used when the gateway saw a usage limit but reported no reset time. */
  usageLimitUnknownResetWaitSec: number;
}

/** Providers that run on the Claude subscription via Claude Code (no per-token billing). */
export const SUBSCRIPTION_PROVIDERS = ['claude-code'] as const;
export const RESEARCH_PROVIDERS = ['claude-code', 'anthropic', 'mock'] as const;
/** Coding-provider OVERRIDE (a ModelProvider for the api backend). Claude Code coding runs are chosen per config (`backend`). */
export const CODING_PROVIDERS = ['anthropic', 'mock'] as const;

export type ResearchMode = 'agentic' | 'simple';
export const RESEARCH_MODES: readonly ResearchMode[] = ['agentic', 'simple'];
/** Research models offered in docs/CLI help (any model id is accepted). Opus is worth it when analysis quality matters. */
export const SUGGESTED_RESEARCH_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'] as const;

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  researchProvider: 'claude-code',
  researchModel: 'claude-sonnet-5-5',
  researchEffort: 'high',
  researchMaxOutputTokens: 16000,
  researchMode: 'agentic',
  researchMaxRuntimeSec: 900,
  researchMaxTotalTokens: 1_500_000,
  researchWorkspace: { maxExperiments: 10, maxRuns: 12, maxRunMB: 40 },
  codingProvider: null,
  maxExperiments: 20,
  maxResearchCostUsd: null,
  maxTotalTokens: null,
  maxCodingTokens: null,
  maxTokensPerCodingRun: 3_000_000,
  maxRuntimePerExperimentSec: 4 * 3600,
  maxTotalDurationSec: 24 * 3600,
  verificationRuns: 5,
  quickRuns: 1,
  runConcurrency: 5,
  noiseMarginPct: 0,
  quickRunMaxTokenRatio: 1.0,
  singleVariableExperiments: 8,
  allowModelChange: false,
  allowedModels: [],
  holdout: { onPromotion: true, runs: 1 },
  pausePollSec: 5,
  historyMaxExperiments: 40,
  maxConsecutiveProposalFailures: 3,
  skipBrowserAgent: false,
  maxUsageLimitWaitSec: 6 * 3600,
  usageLimitMarginSec: 120,
  usageLimitUnknownResetWaitSec: 15 * 60,
};

export function validateSettings(s: ResearchSettings): string[] {
  const errs: string[] = [];
  const posInt = (k: keyof ResearchSettings, min = 1) => {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) errs.push(`${String(k)} must be an integer >= ${min}`);
  };
  posInt('maxExperiments', 0);
  posInt('verificationRuns', 1);
  posInt('quickRuns', 1);
  posInt('runConcurrency', 1);
  if (s.runConcurrency > 8) errs.push('runConcurrency must be <= 8');
  posInt('maxRuntimePerExperimentSec', 1);
  posInt('maxTotalDurationSec', 1);
  posInt('singleVariableExperiments', 0);
  posInt('historyMaxExperiments', 1);
  posInt('maxConsecutiveProposalFailures', 1);
  if (s.maxResearchCostUsd !== null && (typeof s.maxResearchCostUsd !== 'number' || s.maxResearchCostUsd < 0))
    errs.push('maxResearchCostUsd (API-equivalent cost) must be null (disabled) or >= 0');
  for (const k of ['maxTotalTokens', 'maxCodingTokens'] as const) {
    const v = s[k];
    if (v !== null && v !== undefined && (!Number.isInteger(v) || v < 1)) errs.push(`${k} must be null (no cap) or an integer >= 1`);
  }
  posInt('maxUsageLimitWaitSec', 1);
  if (typeof s.usageLimitMarginSec !== 'number' || s.usageLimitMarginSec < 0) errs.push('usageLimitMarginSec must be >= 0');
  posInt('usageLimitUnknownResetWaitSec', 1);
  if (s.maxTokensPerCodingRun !== null && (!Number.isInteger(s.maxTokensPerCodingRun) || s.maxTokensPerCodingRun < 1000))
    errs.push('maxTokensPerCodingRun must be null or an integer >= 1000');
  if (typeof s.noiseMarginPct !== 'number' || s.noiseMarginPct < 0 || s.noiseMarginPct >= 100) errs.push('noiseMarginPct must be in [0,100)');
  if (s.quickRunMaxTokenRatio !== null && (typeof s.quickRunMaxTokenRatio !== 'number' || s.quickRunMaxTokenRatio <= 0))
    errs.push('quickRunMaxTokenRatio must be null or > 0');
  if (!s.holdout || typeof s.holdout.onPromotion !== 'boolean' || !Number.isInteger(s.holdout.runs) || s.holdout.runs < 1)
    errs.push('holdout must be {onPromotion: boolean, runs: integer >= 1}');
  if (typeof s.pausePollSec !== 'number' || s.pausePollSec <= 0) errs.push('pausePollSec must be > 0');
  if (s.codingProvider !== null && !(CODING_PROVIDERS as readonly string[]).includes(s.codingProvider))
    errs.push(`codingProvider must be null or one of ${CODING_PROVIDERS.join(', ')}`);
  if (!RESEARCH_MODES.includes(s.researchMode)) errs.push(`researchMode must be one of ${RESEARCH_MODES.join(', ')}`);
  posInt('researchMaxRuntimeSec', 60);
  posInt('researchMaxTotalTokens', 10_000);
  const w = s.researchWorkspace;
  if (!w || ![w.maxExperiments, w.maxRuns, w.maxRunMB].every((n) => Number.isInteger(n) && n >= 1))
    errs.push('researchWorkspace must be {maxExperiments, maxRuns, maxRunMB} (integers >= 1)');
  if (!(RESEARCH_PROVIDERS as readonly string[]).includes(s.researchProvider)) errs.push(`researchProvider must be one of ${RESEARCH_PROVIDERS.join(', ')}`);
  return errs;
}

export function loadResearchSettings(path: string = DEFAULT_RESEARCH_SETTINGS_PATH, overrides: Partial<ResearchSettings> = {}): ResearchSettings {
  let fromFile: Partial<ResearchSettings> = {};
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete raw.$comment;
    delete raw._doc;
    fromFile = raw as Partial<ResearchSettings>;
  }
  const s: ResearchSettings = {
    ...DEFAULT_RESEARCH_SETTINGS,
    ...fromFile,
    ...stripUndefined(overrides),
    holdout: { ...DEFAULT_RESEARCH_SETTINGS.holdout, ...(fromFile.holdout ?? {}), ...(overrides.holdout ?? {}) },
    researchWorkspace: { ...DEFAULT_RESEARCH_SETTINGS.researchWorkspace, ...(fromFile.researchWorkspace ?? {}), ...(overrides.researchWorkspace ?? {}) },
  };
  // Precedence: explicit override > RESEARCH_MODEL env > file > default.
  if (process.env.RESEARCH_MODEL && !overrides.researchModel) s.researchModel = process.env.RESEARCH_MODEL;
  const errs = validateSettings(s);
  if (errs.length) throw new Error(`invalid research settings (${path}): ${errs.join('; ')}`);
  return s;
}

export function budgetsOf(s: ResearchSettings): ResearchBudgets {
  return {
    maxExperiments: s.maxExperiments,
    maxResearchCostUsd: s.maxResearchCostUsd,
    maxTotalTokens: s.maxTotalTokens ?? null,
    maxCodingTokens: s.maxCodingTokens ?? null,
    maxTokensPerCodingRun: s.maxTokensPerCodingRun,
    maxRuntimePerExperimentSec: s.maxRuntimePerExperimentSec,
    maxTotalDurationSec: s.maxTotalDurationSec,
    verificationRuns: s.verificationRuns,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
