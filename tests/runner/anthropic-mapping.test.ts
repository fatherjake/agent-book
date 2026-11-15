import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  buildAnthropicRequest,
  fromAnthropicResponse,
  isRetryableError,
  mapAnthropicUsage,
  mapStopReason,
  thinkingParam,
  toAnthropicMessages,
  usesBudgetThinking,
} from '../../runner/providers/anthropic.js';
import { TokenTracker } from '../../runner/token-tracker.js';
import type { Message, ModelRequest } from '../../runner/types.js';

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'claude-sonnet-5-5',
  system: 'SYS',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [
    { name: 'a', description: 'A', inputSchema: { type: 'object', properties: {} } },
    { name: 'b', description: 'B', inputSchema: { type: 'object', properties: {} } },
  ],
  maxOutputTokens: 1000,
  promptCaching: true,
  ...over,
});

describe('request mapping', () => {
  it('maps blocks and places cache breakpoints on tools, system and last message', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }, { type: 'image', mediaType: 'image/png', dataBase64: 'QUJD' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu1', name: 'a', input: { x: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'res', isError: true }, { type: 'image', mediaType: 'image/jpeg', dataBase64: 'Rk9P' }] },
    ];
    const p = buildAnthropicRequest(req({ messages }));
    expect(p.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(p.tools?.[0]).not.toHaveProperty('cache_control');
    expect(p.tools?.[1]).toMatchObject({ name: 'b', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } });
    expect(p.messages[0].content).toEqual([
      { type: 'text', text: 'task' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
    expect(p.messages[1].content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'tu1', name: 'a', input: { x: 1 } },
    ]);
    const last = p.messages[2].content as any[];
    expect(last[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu1', content: 'res', is_error: true });
    expect(last[1]).toMatchObject({ type: 'image', cache_control: { type: 'ephemeral' } });
    // inputs untouched
    expect((messages[2].content[1] as any).cache_control).toBeUndefined();
    expect(p).not.toHaveProperty('temperature');
  });

  it('no caching → plain system string, no cache_control anywhere', () => {
    const p = buildAnthropicRequest(req({ promptCaching: false, temperature: 0.2 }));
    expect(p.system).toBe('SYS');
    expect(JSON.stringify(p)).not.toMatch(/cache_control/);
    expect(p).not.toHaveProperty('temperature');
  });

  it('replays providerState verbatim for the same model only', () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'ok' }];
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], providerState: { provider: 'anthropic', model: 'claude-sonnet-5-5', content: native } },
      { role: 'user', content: [{ type: 'text', text: 'y' }] },
    ];
    expect(toAnthropicMessages(msgs, { model: 'claude-sonnet-5-5', caching: false })[1].content).toEqual(native);
    expect(toAnthropicMessages(msgs, { model: 'claude-opus-5-5', caching: false })[1].content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('thinking and effort mapping', () => {
    expect(thinkingParam('claude-sonnet-5-5', undefined, undefined, 16000)).toBeUndefined();
    expect(thinkingParam('claude-sonnet-5-5', 8000, undefined, 16000)).toEqual({ type: 'adaptive' });
    expect(thinkingParam('claude-sonnet-5-5', 0, 'high', 16000)).toEqual({ type: 'between_tools' });
    expect(thinkingParam('claude-sonnet-5-5', 0, 'max', 16000)).toBeUndefined();
    expect(thinkingParam('claude-opus-5-5', 0, undefined, 16000)).toBeUndefined();
    expect(thinkingParam('claude-opus-4-8', 0, undefined, 16000)).toEqual({ type: 'disabled' });
    expect(thinkingParam('claude-haiku-4-5', 4000, undefined, 16000)).toEqual({ type: 'enabled', budget_tokens: 4000 });
    expect(thinkingParam('claude-haiku-4-5', 100, undefined, 16000)).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(usesBudgetThinking('claude-sonnet-4-6')).toBe(false);
    expect(usesBudgetThinking('claude-sonnet-4-5')).toBe(true);
    expect(buildAnthropicRequest(req({ effort: 'medium' })).output_config).toEqual({ effort: 'medium' });
    expect(buildAnthropicRequest(req({ model: 'claude-haiku-4-5', effort: 'medium' }))).not.toHaveProperty('output_config');
  });
});

describe('response mapping', () => {
  const msg = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Let me write.', citations: null },
      { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'a', content: 'b' } },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 300,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 700,
      output_tokens_details: { thinking_tokens: 120 },
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  } as unknown as Anthropic.Message;

  it('maps content, stop reason, usage and provider state', () => {
    const r = fromAnthropicResponse(msg, 'claude-sonnet-5-5');
    expect(r.content).toEqual([
      { type: 'text', text: 'Let me write.' },
      { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'a', content: 'b' } },
    ]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toMatchObject({
      provider: 'anthropic',
      inputTokens: 12,
      outputTokens: 300,
      reasoningTokens: 120,
      reasoningIncludedInOutput: true,
      cacheReadTokens: 5000,
      cacheWriteTokens: 700,
      totalTokens: 12 + 300 + 5000 + 700, // reasoning NOT added again
      costEstimated: true,
      usageEstimated: false,
    });
    expect(r.usage.raw).toBe(msg.usage);
    expect(r.providerState?.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Let me write.' },
      { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'a', content: 'b' } },
    ]);
  });

  it('missing usage is flagged estimated; null cache fields → 0', () => {
    expect(mapAnthropicUsage(undefined, 'claude-sonnet-5-5').usageEstimated).toBe(true);
    expect(mapAnthropicUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null }, 'x')).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 });
  });

  it('stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('end_turn');
    expect(mapStopReason('model_context_window_exceeded')).toBe('max_tokens');
    expect(mapStopReason('refusal')).toBe('other');
    expect(mapStopReason(null)).toBe('other');
  });
});

describe('retries', () => {
  it('classifies errors', () => {
    expect(isRetryableError(new Anthropic.RateLimitError(429, { error: {} }, 'rl', new Headers()))).toBe(true);
    expect(isRetryableError(new Anthropic.InternalServerError(529, { error: { type: 'overloaded_error' } }, 'ov', new Headers()))).toBe(true);
    expect(isRetryableError(new Anthropic.BadRequestError(400, { error: {} }, 'bad', new Headers()))).toBe(false);
    expect(isRetryableError(new Anthropic.AuthenticationError(401, { error: {} }, 'auth', new Headers()))).toBe(false);
    expect(isRetryableError(new Anthropic.APIConnectionError({ message: 'conn' }))).toBe(true);
  });

  it('retries with a fake client and records billed failed attempts as retry', async () => {
    let calls = 0;
    const okMsg = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    const fakeClient = {
      messages: {
        stream: () => {
          calls++;
          const n = calls;
          return {
            // 1st: 429 before any output (not billed); 2nd: died mid-stream after message_start (billed); 3rd: ok
            currentMessage: n === 2 ? { usage: { input_tokens: 10, output_tokens: 1 } } : undefined,
            finalMessage: async () => {
              if (n === 1) throw new Anthropic.RateLimitError(429, { error: {} }, 'rl', new Headers());
              if (n === 2) throw new Anthropic.APIError(undefined, { error: { type: 'overloaded_error' } }, 'Overloaded', undefined);
              return okMsg;
            },
          };
        },
      },
    } as unknown as Pick<Anthropic, 'messages'>;
    const provider = new AnthropicProvider({ client: fakeClient, sleep: async () => {} });
    const tracker = new TokenTracker({ role: 'coding' });
    const res = await tracker.wrap(provider).complete(req());
    expect(calls).toBe(3);
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    const recs = tracker.records();
    expect(recs.map((r) => r.purpose)).toEqual(['retry', 'agent-turn']);
    expect(recs[0]).toMatchObject({ inputTokens: 10, usageEstimated: true });
  });

  it('does not retry non-retryable errors and gives up after maxRetries', async () => {
    let calls = 0;
    const mk = (err: Error) =>
      ({ messages: { stream: () => (calls++, { currentMessage: undefined, finalMessage: async () => Promise.reject(err) }) } }) as unknown as Pick<Anthropic, 'messages'>;
    await expect(new AnthropicProvider({ client: mk(new Anthropic.BadRequestError(400, { error: {} }, 'bad', new Headers())), sleep: async () => {} }).complete(req())).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      new AnthropicProvider({ client: mk(new Anthropic.RateLimitError(429, { error: {} }, 'rl', new Headers())), sleep: async () => {}, maxRetries: 2 }).complete(req()),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('throws a clear error without credentials', async () => {
    const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.ANTHROPIC_API_KEY = '';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      await expect(new AnthropicProvider().complete(req())).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    } finally {
      if (saved.k !== undefined) process.env.ANTHROPIC_API_KEY = saved.k;
      else delete process.env.ANTHROPIC_API_KEY;
      if (saved.t !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    }
  });
});
