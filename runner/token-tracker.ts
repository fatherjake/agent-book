/**
 * Token accounting. This module is the single source of truth for how model usage is recorded,
 * totalled and priced. It is OUT OF BOUNDS for the research agent.
 *
 * Rules:
 *  - Provider-reported usage is authoritative. Records whose counts were not reported by the
 *    provider are flagged `usageEstimated` and must never be presented as exact.
 *  - totalTokens = input + output + cacheRead + cacheWrite (+ reasoning ONLY when the provider
 *    reports reasoning separately from output, i.e. reasoningIncludedInOutput === false).
 *  - Cost is computed locally from PRICES (the Anthropic API does not return a per-call bill),
 *    so it is flagged `costEstimated`.
 *  - Every provider call is recorded, including compaction, tool-output summaries and billed
 *    failed attempts (purpose 'retry').
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentRole, ModelProvider, ModelRequest, ModelResponse, TokenTotals, UsageRecord } from './types.js';
import { logger } from './logger.js';

const log = logger('token-tracker');

/** USD per million tokens. cacheWrite = 5-minute ephemeral cache write (1.25x input). */
export interface PriceEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Anthropic first-party list prices (claude-api skill table, cached 2026-11-03). */
export const PRICES: Record<string, PriceEntry> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Haiku 5.5: prompts <=100K tokens; longer prompts are billed higher (not modelled).
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  reasoningIncludedInOutput?: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Part of cacheWriteTokens written with the 1-hour TTL (billed at 2x base input instead of the
   * 5-minute rate in PRICES.cacheWrite). Claude Code uses 1-hour cache writes.
   */
  cacheWrite1hTokens?: number;
}

export function priceFor(model: string): PriceEntry | undefined {
  if (PRICES[model]) return PRICES[model];
  // Tolerate provider prefixes / dated suffixes, e.g. 'anthropic.claude-sonnet-5-5' or '...-20260101'.
  const keys = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  return keys.map((k) => (model.includes(k) ? PRICES[k] : undefined)).find(Boolean);
}

/** Reasoning tokens to add on top of output (0 when already included in output). */
function extraReasoning(u: TokenCounts): number {
  return u.reasoningIncludedInOutput === false ? u.reasoningTokens ?? 0 : 0;
}

/** input + output + cacheRead + cacheWrite (+ reasoning only if NOT included in output). */
export function computeTotalTokens(u: TokenCounts): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + extraReasoning(u);
}

/**
 * Cost from the local price table. Always `estimated: true` (computed locally, not billed).
 * `known` is false when the model is not in the table (cost reported as 0).
 */
export function computeCost(model: string, u: TokenCounts): { costUsd: number; estimated: boolean; known: boolean } {
  const p = priceFor(model);
  if (!p) return { costUsd: 0, estimated: true, known: false };
  const billedOutput = u.outputTokens + extraReasoning(u);
  const w1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens);
  const cost =
    (u.inputTokens * p.input + billedOutput * p.output + u.cacheReadTokens * p.cacheRead + (u.cacheWriteTokens - w1h) * p.cacheWrite + w1h * p.input * 2) /
    1_000_000;
  return { costUsd: Math.round(cost * 1e8) / 1e8, estimated: true, known: true };
}

export function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    anyEstimated: false,
    costEstimated: false,
  };
}

/**
 * Sum usage records. `totalTokens` is recomputed from the components with the reasoning rule, so
 * a malformed record total can't skew the sum. `anyEstimated` reflects estimated token COUNTS;
 * `costEstimated` reflects locally computed costs.
 */
export function sumUsage(records: UsageRecord[]): TokenTotals {
  const t = emptyTotals();
  for (const r of records) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.reasoningTokens += r.reasoningTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheWriteTokens += r.cacheWriteTokens;
    t.totalTokens += computeTotalTokens(r);
    t.costUsd += r.costUsd;
    t.modelCalls += 1;
    if (r.usageEstimated) t.anyEstimated = true;
    if (r.costEstimated) t.costEstimated = true;
  }
  t.costUsd = Math.round(t.costUsd * 1e8) / 1e8;
  return t;
}

export interface TrackerContext {
  role: AgentRole;
  runId?: string;
  experimentId?: string;
  /** Task of the run (multi-task benchmark); recorded on every record when set. */
  taskId?: string;
  /** Append every record as one JSON line to this file. */
  usageFile?: string;
  /** Observer, e.g. for writing to SQLite. Errors are swallowed. */
  onRecord?: (r: UsageRecord) => void;
}

export class TokenTracker {
  private readonly recs: UsageRecord[] = [];
  constructor(private readonly ctx: TrackerContext) {}

  /** Normalise provider usage into a full UsageRecord, store it and append it to usage.jsonl. */
  record(usage: ModelResponse['usage'], purpose: string): UsageRecord {
    const counts: TokenCounts = {
      inputTokens: nn(usage.inputTokens),
      outputTokens: nn(usage.outputTokens),
      reasoningTokens: nn(usage.reasoningTokens),
      reasoningIncludedInOutput: usage.reasoningIncludedInOutput,
      cacheReadTokens: nn(usage.cacheReadTokens),
      cacheWriteTokens: nn(usage.cacheWriteTokens),
      cacheWrite1hTokens: nn((usage.raw as { cache_creation?: { ephemeral_1h_input_tokens?: unknown } } | null | undefined)?.cache_creation?.ephemeral_1h_input_tokens),
    };
    // Billed cost from the provider is used only when it explicitly says it is not estimated.
    const cost =
      usage.costEstimated === false && Number.isFinite(usage.costUsd)
        ? { costUsd: usage.costUsd, estimated: false }
        : usage.provider === 'mock'
          ? { costUsd: 0, estimated: true }
          : computeCost(usage.model, counts);
    const rec: UsageRecord = {
      id: randomUUID(),
      role: this.ctx.role,
      runId: this.ctx.runId,
      experimentId: this.ctx.experimentId,
      ...(this.ctx.taskId ? { taskId: this.ctx.taskId } : {}),
      provider: usage.provider,
      model: usage.model,
      timestamp: new Date().toISOString(),
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      reasoningTokens: counts.reasoningTokens ?? 0,
      reasoningIncludedInOutput: usage.reasoningIncludedInOutput ?? true,
      cacheReadTokens: counts.cacheReadTokens,
      cacheWriteTokens: counts.cacheWriteTokens,
      totalTokens: computeTotalTokens(counts),
      costUsd: cost.costUsd,
      costEstimated: cost.estimated,
      usageEstimated: usage.usageEstimated === true,
      purpose,
      raw: usage.raw ?? null,
    };
    this.recs.push(rec);
    if (this.ctx.usageFile) {
      try {
        mkdirSync(dirname(this.ctx.usageFile), { recursive: true });
        appendFileSync(this.ctx.usageFile, JSON.stringify(rec) + '\n');
      } catch (e) {
        log.error('failed to append usage record', { file: this.ctx.usageFile, error: String(e) });
      }
    }
    try {
      this.ctx.onRecord?.(rec);
    } catch (e) {
      log.warn('onRecord observer failed', { error: String(e) });
    }
    return rec;
  }

  /**
   * Wrap a provider so every call is recorded. The record's purpose is `req.purpose` when set,
   * otherwise `purpose`. Billed failed attempts reported by the provider are recorded as 'retry'.
   */
  wrap(provider: ModelProvider, purpose = 'agent-turn'): ModelProvider {
    const tracker = this;
    return {
      name: provider.name,
      isMock: provider.isMock,
      async complete(req: ModelRequest): Promise<ModelResponse> {
        const userHook = req.onBilledFailedAttempt;
        const res = await provider.complete({
          ...req,
          onBilledFailedAttempt: (u) => {
            tracker.record(u, 'retry');
            userHook?.(u);
          },
        });
        tracker.record(res.usage, req.purpose ?? purpose);
        return res;
      },
    };
  }

  records(): UsageRecord[] {
    return [...this.recs];
  }

  totals(): TokenTotals {
    return sumUsage(this.recs);
  }
}

function nn(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
