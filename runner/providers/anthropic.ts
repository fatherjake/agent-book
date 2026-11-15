/**
 * Anthropic Messages API provider.
 *
 * - Maps neutral ContentBlocks to/from the API (text, tool_use, tool_result, image).
 * - Thinking blocks are never exposed in neutral content; the full native assistant content is
 *   returned as `providerState` and replayed verbatim on the next request (required for preserved
 *   thinking). Callers that edit history must drop providerState (see agent.ts).
 * - Prompt caching: breakpoints on the last tool, the system prompt and the last message block.
 * - Retries 429 / 5xx / overloaded / connection errors itself (SDK retries disabled) so that each
 *   attempt is visible. Failed attempts that were billed (stream died after message_start) are
 *   reported through req.onBilledFailedAttempt and recorded by TokenTracker as 'retry'.
 * - `temperature` is NOT sent: SDK 1.8 uses API version 2026-10-21, which rejects sampling params.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Effort, Message, ModelProvider, ModelRequest, ModelResponse, ProviderState, ToolSpec } from '../types.js';
import { computeCost } from '../token-tracker.js';
import { loadDotEnv } from '../env.js';
import { logger } from '../logger.js';

const log = logger('provider.anthropic');

type ApiMessageParam = Anthropic.MessageParam;
type ApiContentParam = Anthropic.ContentBlockParam;
type ApiParams = Anthropic.MessageCreateParamsNonStreaming;
type Usage = ModelResponse['usage'];

const EPHEMERAL = { type: 'ephemeral' as const };

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

export function toAnthropicTools(tools: ToolSpec[] | undefined, caching: boolean): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t, i) => {
    const tool: Anthropic.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    };
    if (caching && i === tools.length - 1) tool.cache_control = EPHEMERAL;
    return tool;
  });
}

function neutralBlockToApi(b: ContentBlock): ApiContentParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.dataBase64 } };
  }
}

/** True if `state` was produced by this provider/model and can be replayed verbatim. */
function replayable(state: ProviderState | undefined, model: string): state is ProviderState {
  return !!state && state.provider === 'anthropic' && state.model === model && Array.isArray(state.content) && state.content.length > 0;
}

const CACHEABLE = new Set(['text', 'image', 'tool_use', 'tool_result', 'document']);

/**
 * Map neutral messages to API messages. Assistant turns with replayable providerState are sent
 * verbatim (thinking blocks included). With caching on, a rolling breakpoint goes on the last
 * cacheable block of the last message. Inputs are never mutated.
 */
export function toAnthropicMessages(messages: Message[], opts: { model: string; caching: boolean }): ApiMessageParam[] {
  const out: ApiMessageParam[] = messages.map((m) => {
    if (m.role === 'assistant' && replayable(m.providerState, opts.model)) {
      return { role: 'assistant', content: m.providerState.content.map((c) => ({ ...(c as object) })) as ApiContentParam[] };
    }
    return { role: m.role, content: m.content.map(neutralBlockToApi) };
  });
  if (opts.caching && out.length > 0) {
    const last = out[out.length - 1];
    const blocks = last.content as ApiContentParam[];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (CACHEABLE.has(blocks[i].type)) {
        blocks[i] = { ...blocks[i], cache_control: EPHEMERAL } as ApiContentParam;
        break;
      }
    }
  }
  return out;
}

/** Models that still take `thinking: {type:'enabled', budget_tokens}` (pre-adaptive). */
export function usesBudgetThinking(model: string): boolean {
  return !/claude-(fable|mythos|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-[6-9]|haiku-5)/.test(model);
}

/**
 * Map the neutral thinking budget to the API thinking param.
 *  - undefined  → omit (model default; adaptive on current models)
 *  - > 0        → adaptive (budget_tokens on legacy models)
 *  - 0          → thinking off where the model allows it (Sonnet 5.5: between_tools at effort<=high;
 *                 Opus 5 / 4.7 / 4.8 / Sonnet 5: disabled). Models that can't disable thinking
 *                 (Opus 5.5, Fable) omit it.
 */
export function thinkingParam(model: string, budget: number | undefined, effort: Effort | undefined, maxTokens: number): Anthropic.ThinkingConfigParam | undefined {
  if (budget === undefined) return undefined;
  if (usesBudgetThinking(model)) {
    if (budget <= 0) return undefined;
    const b = Math.max(1024, Math.min(budget, maxTokens - 1));
    return b < maxTokens ? { type: 'enabled', budget_tokens: b } : undefined;
  }
  if (budget > 0) return { type: 'adaptive' };
  const highEffort = effort === 'xhigh' || effort === 'max';
  if (/claude-sonnet-5-5/.test(model)) return highEffort ? undefined : { type: 'between_tools' };
  if (/claude-(opus-4-[78]|sonnet-5(?!-5)|opus-5(?!-5))/.test(model)) {
    if (/opus-5(?!-5)/.test(model) && highEffort) return undefined;
    return { type: 'disabled' };
  }
  return undefined;
}

let warnedTemperature = false;

/** Build the full Messages API request body for a neutral request. */
export function buildAnthropicRequest(req: ModelRequest): ApiParams {
  const caching = req.promptCaching === true;
  const params: ApiParams = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    messages: toAnthropicMessages(req.messages, { model: req.model, caching }),
  };
  if (req.system) {
    params.system = caching ? [{ type: 'text', text: req.system, cache_control: EPHEMERAL }] : req.system;
  }
  const tools = toAnthropicTools(req.tools, caching);
  if (tools) params.tools = tools;
  const thinking = thinkingParam(req.model, req.thinkingBudget, req.effort, req.maxOutputTokens);
  if (thinking) params.thinking = thinking;
  if (req.effort && !usesBudgetThinking(req.model)) params.output_config = { effort: req.effort };
  if (req.temperature !== undefined && !warnedTemperature) {
    warnedTemperature = true;
    log.warn('temperature is ignored: API version 2026-10-21 rejects sampling parameters', { temperature: req.temperature });
  }
  return params;
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/** Map API usage → neutral usage. Thinking tokens are reported inside output_tokens. */
export function mapAnthropicUsage(u: Partial<Anthropic.Usage> | undefined | null, model: string, estimated = false): Usage {
  const inputTokens = u?.input_tokens ?? 0;
  const outputTokens = u?.output_tokens ?? 0;
  const cacheReadTokens = u?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
  const reasoningTokens = u?.output_tokens_details?.thinking_tokens ?? 0;
  const counts = { inputTokens, outputTokens, reasoningTokens, reasoningIncludedInOutput: true, cacheReadTokens, cacheWriteTokens };
  const cost = computeCost(model, counts);
  return {
    provider: 'anthropic',
    model,
    ...counts,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: cost.costUsd,
    costEstimated: true,
    usageEstimated: estimated || !u,
    raw: u ?? null,
  };
}

export function mapStopReason(r: string | null | undefined): ModelResponse['stopReason'] {
  switch (r) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return r;
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/** Strip response-only fields so blocks can be sent back as params. */
function responseBlockToParam(b: Anthropic.ContentBlock): ApiContentParam | null {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'thinking':
      return { type: 'thinking', thinking: b.thinking, signature: b.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: b.data };
    default:
      return null; // server-tool blocks are never requested by this runner
  }
}

export function fromAnthropicResponse(msg: Anthropic.Message, model: string): ModelResponse {
  const content: ContentBlock[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {};
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
  }
  const native = msg.content.map(responseBlockToParam).filter((x): x is ApiContentParam => x !== null);
  return {
    content,
    stopReason: mapStopReason(msg.stop_reason),
    usage: mapAnthropicUsage(msg.usage, model),
    providerState: { provider: 'anthropic', model, content: native, rawStopReason: msg.stop_reason ?? undefined },
  };
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 408 || status === 409 || status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;
    const t = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
    if (t === 'overloaded_error' || t === 'api_error' || t === 'rate_limit_error') return true;
    return status === undefined && /overloaded|internal|ECONNRESET|socket/i.test(err.message);
  }
  return err instanceof Error && /ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(err.message);
}

/** Exponential backoff with jitter; honours retry-after (seconds) when present. */
export function retryDelayMs(attempt: number, err?: unknown, base = 2000, cap = 60_000): number {
  const headers = (err as { headers?: Headers } | undefined)?.headers;
  const ra = headers && typeof headers.get === 'function' ? Number(headers.get('retry-after')) : NaN;
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 120_000);
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AnthropicProviderOptions {
  apiKey?: string;
  maxRetries?: number;
  /** Per-attempt timeout in ms (default 15 min). */
  timeoutMs?: number;
  /** Injected client for tests. */
  client?: Pick<Anthropic, 'messages'>;
  /** Override sleep (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function hasAnthropicCredentials(): boolean {
  loadDotEnv();
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly isMock = false;
  private client?: Pick<Anthropic, 'messages'>;
  private readonly maxRetries: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: AnthropicProviderOptions = {}) {
    this.client = opts.client;
    this.maxRetries = opts.maxRetries ?? 6;
    this.sleepFn = opts.sleep ?? sleep;
  }

  private getClient(): Pick<Anthropic, 'messages'> {
    if (this.client) return this.client;
    loadDotEnv();
    const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error('ANTHROPIC_API_KEY is not set (add it to .env in the repo root or the environment)');
    }
    this.client = new Anthropic({ apiKey: apiKey || undefined, maxRetries: 0, timeout: this.opts.timeoutMs ?? 15 * 60_000 });
    return this.client;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const client = this.getClient();
    const params = buildAnthropicRequest(req);
    let attempt = 0;
    for (;;) {
      let stream: ReturnType<Anthropic['messages']['stream']> | undefined;
      try {
        stream = client.messages.stream(params, { signal: req.signal });
        const msg = await stream.finalMessage();
        return fromAnthropicResponse(msg, req.model);
      } catch (err) {
        // A stream that failed after message_start was billed for its input (at least).
        const partial = stream?.currentMessage?.usage;
        if (partial) {
          try {
            req.onBilledFailedAttempt?.(mapAnthropicUsage(partial, req.model, true));
          } catch {
            /* accounting hook must not break the retry loop */
          }
        }
        if (req.signal?.aborted || !isRetryableError(err) || attempt >= this.maxRetries) throw err;
        const delay = retryDelayMs(attempt, err);
        log.warn('retrying Anthropic call', { attempt: attempt + 1, delayMs: delay, error: String((err as Error)?.message ?? err) });
        attempt++;
        await this.sleepFn(delay, req.signal);
      }
    }
  }
}
