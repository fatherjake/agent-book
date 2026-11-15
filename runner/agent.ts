/**
 * The coding-agent loop. Runs on the host; tools execute in the sandbox.
 *
 * Stops on: end_turn without tool use (completed), limits (limit_exceeded), AbortSignal
 * (interrupted), provider failure after retries (infra_error) or repeated unusable model output
 * (agent_error). Never throws for those cases.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentConfig, ContentBlock, Message, ModelProvider, ModelRequest, ModelResponse, RunStatus, Sandbox, ToolName } from './types.js';
import { TokenTracker } from './token-tracker.js';
import { buildToolSpecs, executeTool, type ToolImage } from './tools.js';
import { logger } from './logger.js';

const log = logger('agent');

export const TASK_PROMPT = `Build the full-stack todo application described in the product specification.

- The starter project is in /workspace (dependencies are already installed; there is no network access, so you cannot install new packages).
- The specification is in /spec (read-only): requirements, API contract, design tokens, fixtures and reference design images.
- When you are finished, /workspace must build with \`npm run build\` and start with \`npm start\`, serving the API under /api and the built frontend at /.`;

export interface SpecFile {
  /** Path relative to the spec dir, e.g. 'requirements.md'. */
  name: string;
  /** Text content (text files) */
  content?: string;
  /** Image content (png/jpeg) */
  image?: ToolImage;
}

export interface AgentRunOptions {
  config: AgentConfig;
  /** Raw (unwrapped) provider; the loop wraps it with the tracker. */
  provider: ModelProvider;
  tracker: TokenTracker;
  sandbox: Sandbox;
  /** Spec files to inline in the first message (already filtered by run.ts). */
  inlineSpec?: SpecFile[];
  /** Reference design image for designDelivery 'inline-image'. */
  designImage?: SpecFile;
  traceFile?: string;
  signal?: AbortSignal;
  taskPrompt?: string;
  /** Workspace size limit enforced with `du` (default 2048 MiB). 0 disables. */
  diskLimitMB?: number;
  /** Check disk every N tool calls (default 10). */
  diskCheckEvery?: number;
  now?: () => number;
}

export interface AgentRunResult {
  status: RunStatus;
  failureReason?: string;
  stopCause: 'end_turn' | 'max_total_tokens' | 'max_model_calls' | 'max_runtime' | 'disk_limit' | 'aborted' | 'provider_error' | 'agent_error';
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  finalText?: string;
  messages: Message[];
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildSystemPrompt(cfg: AgentConfig): string {
  let s = cfg.systemPrompt.trim();
  for (const sk of cfg.skills) s += `\n\n# Skill: ${sk.name}\n\n${sk.content.trim()}`;
  return s;
}

export function buildInitialUserMessage(opts: { taskPrompt?: string; inlineSpec?: SpecFile[]; designImage?: SpecFile }): Message {
  const content: ContentBlock[] = [];
  let text = opts.taskPrompt ?? TASK_PROMPT;
  const files = (opts.inlineSpec ?? []).filter((f) => f.content !== undefined);
  if (files.length) {
    text += '\n\nSpecification files (also available under /spec):';
    for (const f of files) text += `\n\n<file path="/spec/${f.name}">\n${f.content!.replace(/\s+$/, '')}\n</file>`;
  }
  content.push({ type: 'text', text });
  const images = [...(opts.inlineSpec ?? []).filter((f) => f.image), ...(opts.designImage?.image ? [opts.designImage] : [])];
  const seen = new Set<string>();
  for (const img of images) {
    if (seen.has(img.name)) continue;
    seen.add(img.name);
    content.push({ type: 'text', text: `Reference image /spec/${img.name}:` });
    content.push({ type: 'image', mediaType: img.image!.mediaType, dataBase64: img.image!.dataBase64 });
  }
  return { role: 'user', content };
}

// ---------------------------------------------------------------------------
// Context strategies
// ---------------------------------------------------------------------------

export const DROPPED_TOOL_RESULT = '[old tool output removed to save context]';

/** Rough token estimate (chars/4; images ≈ 1600). Used only when no real usage is available. */
export function estimateTokens(system: string, messages: Message[]): number {
  let chars = system.length;
  let images = 0;
  for (const m of messages)
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'tool_result') chars += b.content.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length;
      else images++;
    }
  return Math.ceil(chars / 4) + images * 1600;
}

/**
 * Replace all but the most recent `keep` tool results with a placeholder and drop images from
 * those older turns. Strips providerState everywhere (edited history can't replay thinking
 * blocks). Returns the number of results dropped. Never touches the first user message.
 */
export function dropOldToolResults(messages: Message[], keep: number): number {
  const positions: [number, number][] = [];
  messages.forEach((m, i) => m.content.forEach((b, j) => b.type === 'tool_result' && positions.push([i, j])));
  const toDrop = positions.slice(0, Math.max(0, positions.length - keep));
  let dropped = 0;
  const touched = new Set<number>();
  for (const [i, j] of toDrop) {
    const b = messages[i].content[j];
    if (b.type === 'tool_result' && b.content !== DROPPED_TOOL_RESULT) {
      messages[i].content[j] = { ...b, content: DROPPED_TOOL_RESULT };
      dropped++;
      touched.add(i);
    }
  }
  for (const i of touched) {
    if (i === 0) continue;
    messages[i].content = messages[i].content.filter((b) => b.type !== 'image');
  }
  if (dropped) for (const m of messages) delete m.providerState;
  return dropped;
}

const COMPACTION_INSTRUCTION = `CONTEXT COMPACTION: Do not call any tools now. Write a concise progress summary that will replace the conversation so far. Include: what has been implemented (files and their purpose), the current state of the build/tests, known problems, and the exact next steps. Be specific (file paths, commands); omit file contents that can be re-read from disk.`;

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

function clip(v: unknown, max = 4000): unknown {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `...[${v.length - max} more chars]` : v;
  if (Array.isArray(v)) return v.map((x) => clip(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, max)]));
  return v;
}

/** Every entry: { ts, type, turn, ...data }. `turn` defaults to the current turn (0 before the first model call). */
function makeTracer(file: string | undefined, currentTurn: () => number) {
  if (file) mkdirSync(dirname(file), { recursive: true });
  return (type: string, data: Record<string, unknown>) => {
    if (!file) return;
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), type, turn: currentTurn(), ...data }) + '\n');
    } catch {
      /* tracing must never crash the run */
    }
  };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { config: cfg, tracker, sandbox } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  let currentTurn = 0;
  const trace = makeTracer(opts.traceFile, () => currentTurn);
  const provider = tracker.wrap(opts.provider, 'agent-turn');
  const system = buildSystemPrompt(cfg);
  const tools = buildToolSpecs(cfg.tools);
  const messages: Message[] = [buildInitialUserMessage({ taskPrompt: opts.taskPrompt, inlineSpec: opts.inlineSpec, designImage: opts.designImage })];
  const limits = cfg.limits;
  const diskLimit = opts.diskLimitMB ?? 2048;
  const diskEvery = opts.diskCheckEvery ?? 10;

  let modelCalls = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let compactions = 0;
  let consecutiveMaxTokens = 0;
  let lastContextTokens = 0;
  let finalText: string | undefined;

  // Runtime limit + external abort → one controller passed to provider calls.
  const ctrl = new AbortController();
  let runtimeExceeded = false;
  const runtimeTimer = setTimeout(() => {
    runtimeExceeded = true;
    ctrl.abort(new Error('maxRuntimeSec exceeded'));
  }, limits.maxRuntimeSec * 1000);
  const onAbort = () => ctrl.abort(opts.signal?.reason ?? new Error('aborted'));
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const baseReq = (): Omit<ModelRequest, 'messages'> => ({
    model: cfg.model,
    system,
    tools,
    maxOutputTokens: cfg.maxOutputTokensPerCall,
    temperature: cfg.temperature,
    promptCaching: cfg.promptCaching,
    thinkingBudget: cfg.thinkingBudget,
    effort: cfg.effort,
    signal: ctrl.signal,
  });

  const summarizeToolOutput = async (text: string, tool: ToolName, input: Record<string, unknown>): Promise<string> => {
    modelCalls++;
    const res = await provider.complete({
      model: cfg.model,
      system: 'You condense tool output for a coding agent. Keep every error message, failing test, file path, line number and command result verbatim where relevant. Drop repetitive noise. Reply with the condensed output only.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `Tool: ${tool}\nInput: ${JSON.stringify(clip(input, 500))}\n\nOutput:\n${text.slice(0, 400_000)}` }] }],
      maxOutputTokens: 2048,
      promptCaching: false,
      purpose: 'summarize-tool-output',
      signal: ctrl.signal,
    });
    trace('summarize_tool_output', { tool, inputChars: text.length, usage: res.usage.totalTokens });
    return res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() || '(empty summary)';
  };

  const checkLimits = (): Pick<AgentRunResult, 'status' | 'failureReason' | 'stopCause'> | null => {
    if (opts.signal?.aborted) return { status: 'interrupted', stopCause: 'aborted', failureReason: 'run aborted by signal' };
    if (runtimeExceeded || now() - started >= limits.maxRuntimeSec * 1000)
      return { status: 'limit_exceeded', stopCause: 'max_runtime', failureReason: `maxRuntimeSec (${limits.maxRuntimeSec}) exceeded` };
    const total = tracker.totals().totalTokens;
    if (total >= limits.maxTotalTokens)
      return { status: 'limit_exceeded', stopCause: 'max_total_tokens', failureReason: `maxTotalTokens (${limits.maxTotalTokens}) reached: ${total}` };
    if (modelCalls >= limits.maxModelCalls)
      return { status: 'limit_exceeded', stopCause: 'max_model_calls', failureReason: `maxModelCalls (${limits.maxModelCalls}) reached` };
    return null;
  };

  const maybeCompact = async () => {
    const strat = cfg.context.strategy;
    if (strat === 'none' || !cfg.context.compactAtTokens) return;
    const ctxTokens = lastContextTokens || estimateTokens(system, messages);
    if (ctxTokens < cfg.context.compactAtTokens) return;
    if (strat === 'drop-old-tool-results') {
      const n = dropOldToolResults(messages, cfg.context.keepRecentToolResults ?? 4);
      if (n > 0) {
        compactions++;
        lastContextTokens = 0;
        trace('compaction', { strategy: strat, droppedToolResults: n, contextTokensBefore: ctxTokens });
      }
      return;
    }
    // summarize: same prefix (cache-friendly) + an instruction appended to the last user turn.
    if (messages.length < 3) return;
    const last = messages[messages.length - 1];
    const reqMessages: Message[] = [...messages.slice(0, -1), { role: last.role, content: [...last.content, { type: 'text', text: COMPACTION_INSTRUCTION }] }];
    modelCalls++;
    const res = await provider.complete({ ...baseReq(), messages: reqMessages, purpose: 'compaction' });
    const summary = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    if (!summary) {
      trace('compaction', { strategy: strat, skipped: 'empty summary' });
      return;
    }
    const first = messages[0];
    messages.length = 0;
    messages.push({
      role: 'user',
      content: [...first.content, { type: 'text', text: `<progress_summary>\n${summary}\n</progress_summary>\nThe conversation so far was compacted into the summary above. Continue the task from where it left off.` }],
    });
    compactions++;
    lastContextTokens = 0;
    trace('compaction', { strategy: strat, contextTokensBefore: ctxTokens, summaryChars: summary.length, usage: res.usage.totalTokens });
  };

  trace('start', { configId: cfg.id, model: cfg.model, provider: opts.provider.name, isMock: opts.provider.isMock, tools: tools.map((t) => t.name), systemChars: system.length, limits });

  const finish = (r: Pick<AgentRunResult, 'status' | 'failureReason' | 'stopCause'>): AgentRunResult => {
    clearTimeout(runtimeTimer);
    opts.signal?.removeEventListener('abort', onAbort);
    const result: AgentRunResult = { ...r, modelCalls, toolCalls, toolErrors, compactions, finalText, messages };
    trace('end', { status: r.status, stopCause: r.stopCause, failureReason: r.failureReason, modelCalls, toolCalls, toolErrors, compactions, totals: tracker.totals() });
    return result;
  };

  try {
    for (let turn = 1; ; turn++) {
      currentTurn = turn;
      const lim = checkLimits();
      if (lim) return finish(lim);

      try {
        await maybeCompact();
      } catch (e) {
        if (ctrl.signal.aborted) return finish(checkLimits() ?? { status: 'interrupted', stopCause: 'aborted', failureReason: 'aborted during compaction' });
        trace('compaction_error', { error: String((e as Error)?.message ?? e) });
        log.warn('compaction failed; continuing without it', { error: String(e) });
      }
      const lim2 = checkLimits();
      if (lim2) return finish(lim2);

      let res: ModelResponse;
      const t0 = now();
      try {
        modelCalls++;
        res = await provider.complete({ ...baseReq(), messages, purpose: 'agent-turn' });
      } catch (e) {
        const lim3 = checkLimits();
        if (ctrl.signal.aborted && lim3) return finish(lim3);
        const msg = String((e as Error)?.message ?? e);
        trace('model_error', { turn, error: msg });
        return finish({ status: 'infra_error', stopCause: 'provider_error', failureReason: `model call failed: ${msg}` });
      }
      lastContextTokens = res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens + res.usage.outputTokens;

      const toolUses = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      if (text) finalText = text;
      trace('model_call', {
        turn,
        stopReason: res.stopReason,
        durationMs: now() - t0,
        purpose: 'agent-turn',
        usage: {
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          reasoningTokens: res.usage.reasoningTokens,
          cacheReadTokens: res.usage.cacheReadTokens,
          cacheWriteTokens: res.usage.cacheWriteTokens,
          totalTokens: res.usage.totalTokens,
          costUsd: res.usage.costUsd,
          usageEstimated: res.usage.usageEstimated,
        },
        text: clip(text, 8000),
        toolUses: toolUses.map((t) => ({ id: t.id, name: t.name })),
      });

      // An assistant message must not be empty.
      const assistantContent = res.content.length ? res.content : [{ type: 'text' as const, text: '(no output)' }];
      messages.push({ role: 'assistant', content: assistantContent, ...(res.providerState ? { providerState: res.providerState } : {}) });

      if (toolUses.length === 0) {
        if (res.stopReason === 'max_tokens') {
          consecutiveMaxTokens++;
          if (consecutiveMaxTokens >= 3) return finish({ status: 'agent_error', stopCause: 'agent_error', failureReason: 'model output repeatedly truncated at max_tokens' });
          messages.push({ role: 'user', content: [{ type: 'text', text: 'Your previous response was cut off by the output token limit. Continue, working in smaller steps (e.g. write large files in parts).' }] });
          continue;
        }
        if (res.stopReason === 'other') {
          const raw = res.providerState?.rawStopReason ?? 'unknown';
          return finish({ status: 'agent_error', stopCause: 'agent_error', failureReason: `model stopped with stop reason '${raw}'` });
        }
        return finish({ status: 'completed', stopCause: 'end_turn' });
      }

      // Execute tools. With max_tokens, the LAST tool_use may have truncated input: don't run it.
      const truncatedLast = res.stopReason === 'max_tokens';
      consecutiveMaxTokens = truncatedLast ? consecutiveMaxTokens + 1 : 0;
      if (consecutiveMaxTokens >= 3) return finish({ status: 'agent_error', stopCause: 'agent_error', failureReason: 'model output repeatedly truncated at max_tokens' });
      const results: ContentBlock[] = [];
      const images: ContentBlock[] = [];
      let aborted = false;
      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];
        if (aborted || (truncatedLast && i === toolUses.length - 1)) {
          const why = aborted
            ? 'Not executed: the run is stopping.'
            : 'Not executed: your response was cut off by the output token limit, so this tool call may be incomplete. Retry with smaller content (e.g. split large files).';
          results.push({ type: 'tool_result', toolUseId: tu.id, content: why, isError: true });
          continue;
        }
        const t1 = now();
        toolCalls++;
        const r = await executeTool(tu.name, tu.input, cfg.tools, { sandbox, summarize: summarizeToolOutput });
        if (r.isError) toolErrors++;
        results.push({ type: 'tool_result', toolUseId: tu.id, content: r.content || '(no output)', isError: r.isError || undefined });
        for (const img of r.images ?? []) images.push({ type: 'image', mediaType: img.mediaType, dataBase64: img.dataBase64 });
        trace('tool_call', {
          turn,
          id: tu.id,
          tool: tu.name,
          input: clip(tu.input, 20_000),
          isError: r.isError,
          durationMs: now() - t1,
          rawChars: r.rawChars,
          returnedChars: r.content.length,
          truncated: r.truncated,
          summarized: r.summarized,
          output: clip(r.content, 4000),
          images: r.images?.length ?? 0,
        });
        if (opts.signal?.aborted || runtimeExceeded) aborted = true;
      }
      messages.push({ role: 'user', content: [...results, ...images] });

      if (diskLimit > 0 && toolCalls > 0 && Math.floor(toolCalls / diskEvery) !== Math.floor((toolCalls - toolUses.length) / diskEvery)) {
        const du = await sandbox.exec('du -sk /workspace 2>/dev/null | cut -f1', { timeoutSec: 60 }).catch(() => null);
        const mb = du ? parseInt(du.stdout, 10) / 1024 : NaN;
        if (Number.isFinite(mb)) {
          trace('disk_check', { workspaceMB: Math.round(mb) });
          if (mb > diskLimit) return finish({ status: 'limit_exceeded', stopCause: 'disk_limit', failureReason: `workspace uses ${Math.round(mb)} MiB > limit ${diskLimit} MiB` });
        }
      }
    }
  } catch (e) {
    // Programmer errors or unexpected sandbox failures: record, don't throw.
    const msg = String((e as Error)?.stack ?? e);
    trace('agent_exception', { error: msg });
    return finish({ status: 'agent_error', stopCause: 'agent_error', failureReason: `agent loop exception: ${String((e as Error)?.message ?? e)}` });
  }
}
