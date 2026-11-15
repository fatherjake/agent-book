import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenTracker, computeCost, computeTotalTokens, priceFor, sumUsage } from '../../runner/token-tracker.js';
import type { ModelProvider, ModelResponse, UsageRecord } from '../../runner/types.js';

const usage = (over: Partial<ModelResponse['usage']> = {}): ModelResponse['usage'] => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  inputTokens: 1000,
  outputTokens: 500,
  reasoningTokens: 0,
  reasoningIncludedInOutput: true,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 1500,
  costUsd: 0,
  costEstimated: true,
  usageEstimated: false,
  raw: { input_tokens: 1000 },
  ...over,
});

describe('totals and reasoning', () => {
  it('does not double count reasoning included in output', () => {
    expect(computeTotalTokens({ inputTokens: 10, outputTokens: 100, reasoningTokens: 60, reasoningIncludedInOutput: true, cacheReadTokens: 5, cacheWriteTokens: 7 })).toBe(122);
  });
  it('adds reasoning when reported separately', () => {
    expect(computeTotalTokens({ inputTokens: 10, outputTokens: 100, reasoningTokens: 60, reasoningIncludedInOutput: false, cacheReadTokens: 5, cacheWriteTokens: 7 })).toBe(182);
  });
});

describe('computeCost', () => {
  it('prices Sonnet 5.5 including cache reads and writes', () => {
    // 1M input $2, 1M output $10, 1M cache read $0.10, 1M cache write $2.50
    const c = computeCost('claude-sonnet-5-5', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 });
    expect(c.costUsd).toBeCloseTo(14.6, 6);
    expect(c.estimated).toBe(true);
    expect(c.known).toBe(true);
  });
  it('bills separate reasoning at the output rate, but not when included', () => {
    const inc = computeCost('claude-opus-5-5', { inputTokens: 0, outputTokens: 1e6, reasoningTokens: 5e5, reasoningIncludedInOutput: true, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const sep = computeCost('claude-opus-5-5', { inputTokens: 0, outputTokens: 1e6, reasoningTokens: 5e5, reasoningIncludedInOutput: false, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(inc.costUsd).toBeCloseTo(20, 6);
    expect(sep.costUsd).toBeCloseTo(30, 6);
  });
  it('unknown model → cost 0, estimated, not known', () => {
    expect(computeCost('some-other-model', { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toEqual({ costUsd: 0, estimated: true, known: false });
  });
  it('tolerates prefixes', () => {
    expect(priceFor('anthropic.claude-sonnet-5-5')).toEqual(priceFor('claude-sonnet-5-5'));
    expect(priceFor('claude-sonnet-5')?.cacheRead).toBe(0.2);
  });
});

describe('sumUsage', () => {
  it('sums and flags estimates', () => {
    const base = { id: 'x', role: 'coding', provider: 'anthropic', model: 'm', timestamp: '', purpose: 'agent-turn', raw: null, reasoningIncludedInOutput: true, costEstimated: true } as const;
    const recs: UsageRecord[] = [
      { ...base, inputTokens: 1, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10, costUsd: 0.1, usageEstimated: false },
      { ...base, inputTokens: 10, outputTokens: 20, reasoningTokens: 5, reasoningIncludedInOutput: false, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 35, costUsd: 0.2, usageEstimated: true },
    ];
    const t = sumUsage(recs);
    expect(t).toMatchObject({ inputTokens: 11, outputTokens: 22, reasoningTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 45, modelCalls: 2, anyEstimated: true, costEstimated: true });
    expect(t.costUsd).toBeCloseTo(0.3, 9);
  });
  it('empty → zeros', () => {
    expect(sumUsage([])).toMatchObject({ totalTokens: 0, modelCalls: 0, anyEstimated: false });
  });
});

describe('TokenTracker', () => {
  it('records every call with role/run/purpose, recomputes totals and cost, appends JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-'));
    const usageFile = join(dir, 'usage.jsonl');
    const tracker = new TokenTracker({ role: 'coding', runId: 'run_1', experimentId: 'exp_1', usageFile });
    const provider: ModelProvider = {
      name: 'anthropic',
      isMock: false,
      async complete(req) {
        // a billed failed attempt reported by the provider's internal retry
        req.onBilledFailedAttempt?.(usage({ inputTokens: 300, outputTokens: 0, usageEstimated: true }));
        return { content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn', usage: usage({ totalTokens: 999999 /* wrong; recomputed */ }) };
      },
    };
    const wrapped = tracker.wrap(provider, 'agent-turn');
    await wrapped.complete({ model: 'claude-sonnet-5-5', system: '', messages: [], maxOutputTokens: 10 });
    await wrapped.complete({ model: 'claude-sonnet-5-5', system: '', messages: [], maxOutputTokens: 10, purpose: 'compaction' });
    const recs = tracker.records();
    expect(recs.map((r) => r.purpose)).toEqual(['retry', 'agent-turn', 'retry', 'compaction']);
    expect(recs[1]).toMatchObject({ role: 'coding', runId: 'run_1', experimentId: 'exp_1', totalTokens: 1500, costEstimated: true, usageEstimated: false });
    expect(recs[1].costUsd).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6, 9);
    expect(recs[0].usageEstimated).toBe(true);
    expect(recs[1].raw).toEqual({ input_tokens: 1000 });
    const lines = readFileSync(usageFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]).purpose).toBe('compaction');
    const t = tracker.totals();
    expect(t.modelCalls).toBe(4);
    expect(t.totalTokens).toBe(1500 * 2 + 300 * 2);
    expect(t.anyEstimated).toBe(true);
  });

  it('mock usage costs 0 and stays estimated', () => {
    const tracker = new TokenTracker({ role: 'coding' });
    const r = tracker.record(usage({ provider: 'mock', usageEstimated: true }), 'agent-turn');
    expect(r.costUsd).toBe(0);
    expect(r.usageEstimated).toBe(true);
    expect(r.costEstimated).toBe(true);
  });

  it('uses a provider-billed cost when marked as not estimated', () => {
    const tracker = new TokenTracker({ role: 'research' });
    const r = tracker.record(usage({ costUsd: 1.23, costEstimated: false }), 'x');
    expect(r.costUsd).toBe(1.23);
    expect(r.costEstimated).toBe(false);
  });

  it('does not record anything when the call fails without billing', async () => {
    const tracker = new TokenTracker({ role: 'coding' });
    const failing: ModelProvider = { name: 'anthropic', isMock: false, complete: async () => Promise.reject(new Error('boom')) };
    await expect(tracker.wrap(failing).complete({ model: 'm', system: '', messages: [], maxOutputTokens: 1 })).rejects.toThrow('boom');
    expect(tracker.records()).toHaveLength(0);
  });
});
