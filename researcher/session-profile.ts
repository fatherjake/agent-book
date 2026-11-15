/**
 * Session token profiles: WHERE a coding session's tokens went, not just the totals.
 *
 *   buildSessionProfile(runDir)      → SessionProfile (written as profile.json in the run dir)
 *   renderProfileMarkdown(profile)   → compact, evidence-first Markdown for the research agent
 *
 * Sources (all read from the run dir, never invented):
 *  - usage.jsonl          gateway / TokenTracker UsageRecords: AUTHORITATIVE token counts per model call.
 *  - claude-stream.jsonl  raw Claude Code stream-json (claude-code backend): tool calls, tool outputs, text.
 *  - trace.jsonl          the runner's trace; used for the api backend (no stream).
 *  - run.json, config/    status, backend, config snapshot (for the user-prompt size estimate).
 *
 * Join: each stream assistant message carries the request-side usage (input, cache read, cache write),
 * which equals the gateway record's. Messages are matched to records by that signature, then by
 * order among whatever is left. Output tokens always come from the gateway record (the stream's
 * per-message output count is a partial value from message_start).
 *
 * Anything not reported by the provider is an ESTIMATE and is labelled so: tool output tokens
 * (chars / 4), image tokens (width × height / 750), the user-prompt size and the fixed overhead.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { UsageRecord } from '../runner/types.js';
import { buildClaudeCodePrompt } from '../runner/claude-code.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SESSION_PROFILE_VERSION = 1;

export interface TokenKinds {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Thinking tokens as reported by the provider (already inside outputTokens for Anthropic). */
  thinkingTokens: number;
  totalTokens: number;
}

export interface PurposeTotals extends TokenKinds {
  calls: number;
}

export interface CallProfile extends TokenKinds {
  /** 1-based, in usage.jsonl order (count-tokens records excluded). */
  index: number;
  ts: string;
  model: string;
  /** 'agent-turn' | 'subagent' | 'background' | 'compaction' | 'summarize-tool-output' | 'retry' | ... */
  purpose: string;
  /** 'main', a subagent's parent tool_use id, or 'background'. Context deltas are per thread. */
  thread: string;
  messageId?: string;
  /** input + cacheRead + cacheWrite: the prompt the model saw on this call. */
  contextTokens: number;
  /** contextTokens minus the previous call's contextTokens in the same thread (null for the first). */
  contextDelta: number | null;
  /** Tool calls this turn issued (names, in order) and their ids. */
  tools: string[];
  toolUseIds: string[];
  /** Assistant text chars in this turn (visible text, not thinking). */
  textChars: number;
  stopReason?: string;
  /** True when a stream/trace message was joined to this usage record. */
  joined: boolean;
  usageEstimated: boolean;
}

export interface ToolCallProfile {
  id: string;
  /** Index of the model call that issued it (null if its message could not be joined to a record). */
  callIndex: number | null;
  thread: string;
  name: string;
  inputSummary: string;
  inputChars: number;
  /** Text chars of the tool result as sent back to the model. */
  outputChars: number;
  images: number;
  /** ESTIMATED tokens the result adds to context: ceil(chars/4) + images (w×h/750, when dimensions are known). */
  outputTokensEst: number;
  isError: boolean;
  /** Later model calls in the same thread that carry this output in their context. */
  remainingCalls: number;
  /** ESTIMATED: outputTokensEst × remainingCalls. */
  carriedTokensEst: number;
  /** Paths this call read / wrote (best effort, parsed from Read/Write/Edit inputs and shell commands). */
  reads: string[];
  writes: string[];
  /** Whole-file write (Write tool or shell redirect/heredoc) vs targeted Edit. */
  writeKind?: 'whole-file' | 'edit';
  isBuild: boolean;
  /**
   * A post-tool hook trimmed this output and reported its sizes (frugal: orig_chars/new_chars), paired with this
   * result by stream order. savedTokensEst = (orig − new)/4; savedCarriedTokensEst = that × remainingCalls.
   */
  hookTrim?: { origChars: number; newChars: number; savedTokensEst: number; savedCarriedTokensEst: number };
  outputHead?: string;
}

export interface OverheadEstimate {
  /** Context size of the first main-thread call (exact, from the gateway). */
  firstCallContextTokens: number | null;
  /** Cache read on the first call: prefix already cached by an earlier session (exact). */
  firstCallCacheReadTokens: number | null;
  /** ESTIMATED size of the task prompt (chars / 4), null if it could not be rebuilt. */
  userPromptTokensEst: number | null;
  userPromptChars: number | null;
  /** ESTIMATED system prompt + tool definitions (+ skills listing): first context minus user prompt. */
  fixedOverheadTokensEst: number | null;
  /** ESTIMATED: fixed overhead × (main calls − 1), i.e. re-read from cache on every later call. */
  overheadReReadTokensEst: number | null;
  /** ESTIMATED: fixed overhead × main calls / total tokens. */
  overheadShareOfTotal: number | null;
  method: string;
}

export type WasteKind =
  | 'repeated-read'
  | 'error-retry'
  | 'large-output'
  | 'repeated-build'
  | 'whole-file-rewrite'
  | 'subagent'
  | 'thinking'
  | 'final-summary'
  | 'no-tool-turn'
  | 'unused-tools'
  | 'background-calls'
  | 'image-read'
  | 'hook-output';

export interface WasteSignal {
  kind: WasteKind;
  severity: 'info' | 'low' | 'medium' | 'high';
  /** One-line description. */
  title: string;
  /** Concrete evidence lines (call indices, commands, paths, sizes). */
  evidence: string[];
  /** Tokens attributable to the signal; `tokensEstimated` says whether that figure is an estimate. */
  tokens: number;
  tokensEstimated: boolean;
}

export interface ToolNameStats {
  name: string;
  count: number;
  errors: number;
  outputChars: number;
  outputTokensEst: number;
  carriedTokensEst: number;
}

/**
 * What a hook's output did, classified from hook_response.stdout (JSON) and exit_code:
 *  - injectedChars: text the model reads in addition to the transcript: hookSpecificOutput.additionalContext,
 *    `reason` with decision "block", permissionDecisionReason with permissionDecision "deny", stderr on exit code 2.
 *  - replacementChars: hookSpecificOutput.updatedToolOutput / updatedInput. They REPLACE the tool result / input, so
 *    they are not extra context; the tool_result in the stream is already the replaced output.
 *  - systemMessageChars: `systemMessage` (shown to the user, not counted as injected).
 *  - plainStdoutChars: non-JSON stdout on exit 0 (transcript/verbose only, not injected).
 *  - measured*: replacing hooks report sizes with a stderr line `frugal: orig_chars=<N> new_chars=<M>[ tool_use_id=<id>]`
 *    (stderr on a non-2 exit never reaches the model). With the id the trim is paired exactly with its tool_result,
 *    otherwise by stream order. Replacements without the line have an unknown saving.
 */
export interface HookStats {
  name: string;
  runs: number;
  injectedChars: number;
  replacements: number;
  replacementChars: number;
  systemMessageChars: number;
  plainStdoutChars: number;
  blockingExits: number;
  measuredReplacements: number;
  origChars: number;
  newChars: number;
}

/** `frugal: orig_chars=<N> new_chars=<M>[ tool_use_id=<id>]` (the id pairs the trim exactly with its tool_result). */
export const HOOK_SIZE_LINE = /^frugal: orig_chars=(\d+) new_chars=(\d+)(?: tool_use_id=(\S*))?$/m;

export interface SessionProfile {
  version: number;
  runId: string;
  backend: 'claude-code' | 'api' | 'unknown';
  configId: string | null;
  model: string | null;
  status: string | null;
  usedMockProvider: boolean;
  generatedAt: string;
  sources: {
    usage: boolean;
    stream: boolean;
    trace: boolean;
    joined: number;
    unjoinedUsageRecords: number;
    unjoinedMessages: number;
    /** Records excluded from calls (purpose count-tokens; 0 tokens). */
    countTokensRecords: number;
  };
  environment: { toolsAvailable: string[]; skillsAvailable: string[]; claudeCodeVersion: string | null };
  /** Hook runs from stream system hook_response events, per "<event>:<matcher>". See HookStats. */
  hooks: HookStats[];
  /** ESTIMATED savings from output-replacing hooks that reported sizes; unmeasured replacements have unknown savings. */
  hookSavings: { measured: number; unmeasuredReplacements: number; savedChars: number; savedTokensEst: number; savedCarriedTokensEst: number };
  /** run.json configAudit summary (bin/hook audit by runner/config-guard), when present. */
  configAudit: { flagged: boolean; reasons: string[] } | null;
  totals: TokenKinds & { modelCalls: number; costUsd: number; anyEstimated: boolean };
  byPurpose: Record<string, PurposeTotals>;
  overhead: OverheadEstimate;
  calls: CallProfile[];
  tools: ToolCallProfile[];
  toolStats: ToolNameStats[];
  waste: WasteSignal[];
  finalSummary: { chars: number; outputTokens: number | null; head: string } | null;
  timeline: string[];
  notes: string[];
}

export interface BuildProfileOptions {
  /** Tool outputs above this many chars are flagged as large (default 6000). */
  largeOutputChars?: number;
  /** Spec dir used to rebuild the task prompt for the overhead estimate (default benchmark/spec). */
  specDir?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const estTokens = (chars: number) => Math.ceil(chars / 4);

function readJsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  const out: any[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

export function fmtK(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (a >= 10_000) return (n / 1000).toFixed(1) + 'k';
  if (a >= 1000) return (n / 1000).toFixed(2) + 'k';
  return String(Math.round(n));
}

const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : (x * 100).toFixed(0) + '%');

/** PNG width/height from base64 data (IHDR), or null. */
export function pngDimensions(b64: string): { width: number; height: number } | null {
  try {
    const head = Buffer.from(b64.slice(0, 64), 'base64');
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** Anthropic's documented approximation for image input tokens. */
export const imageTokensEst = (w: number, h: number) => Math.ceil((w * h) / 750);

function emptyKinds(): TokenKinds {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, totalTokens: 0 };
}

function addKinds(a: TokenKinds, b: TokenKinds) {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
  a.thinkingTokens += b.thinkingTokens;
  a.totalTokens += b.totalTokens;
}

function thinkingOf(r: UsageRecord): number {
  const raw = r.raw as any;
  const fromRaw = raw?.output_tokens_details?.thinking_tokens;
  if (typeof fromRaw === 'number') return fromRaw;
  return r.reasoningTokens ?? 0;
}

// ---------------------------------------------------------------------------
// Normalised session (common to the claude-code stream and the api trace)
// ---------------------------------------------------------------------------

interface NormToolUse {
  id: string;
  name: string;
  input: any;
}

interface NormMessage {
  id: string;
  model?: string;
  thread: string; // 'main' or subagent parent tool_use id
  sig: { input: number; cacheRead: number; cacheWrite: number } | null;
  toolUses: NormToolUse[];
  text: string;
  stopReason?: string;
  purpose?: string;
}

interface NormResult {
  chars: number;
  images: number;
  imageTokensEst: number;
  imageDimsKnown: boolean;
  isError: boolean;
  head: string;
  hookTrim?: { origChars: number; newChars: number };
}

interface NormSession {
  messages: NormMessage[];
  results: Map<string, NormResult>;
  tools: string[];
  skills: string[];
  claudeCodeVersion: string | null;
  finalResultText: string | null;
  hooks: Map<string, HookStats>;
}

const emptyHook = (name: string): HookStats => ({ name, runs: 0, injectedChars: 0, replacements: 0, replacementChars: 0, systemMessageChars: 0, plainStdoutChars: 0, blockingExits: 0, measuredReplacements: 0, origChars: 0, newChars: 0 });

const strLen = (v: unknown) => (v === undefined || v === null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);

/** Adds one hook_response event to `h` (see HookStats for the rules). Returns the reported sizes, if any. */
export function classifyHookResponse(e: any, h: HookStats): { origChars: number; newChars: number; toolUseId?: string } | null {
  h.runs++;
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  if (Number(e.exit_code) === 2) {
    h.blockingExits++;
    h.injectedChars += stderr.length;
    return null;
  }
  const m = HOOK_SIZE_LINE.exec(stderr);
  const sizes = m ? { origChars: Number(m[1]), newChars: Number(m[2]), ...(m[3] ? { toolUseId: m[3] } : {}) } : null;
  if (sizes) {
    h.measuredReplacements++;
    h.origChars += sizes.origChars;
    h.newChars += sizes.newChars;
  }
  const t = stdout.trim();
  if (!t) return sizes;
  let j: any = null;
  if (t.startsWith('{')) {
    try {
      j = JSON.parse(t);
    } catch {
      j = null;
    }
  }
  if (!j || typeof j !== 'object') {
    h.plainStdoutChars += stdout.length;
    return sizes;
  }
  const hs = j.hookSpecificOutput ?? {};
  h.injectedChars += strLen(hs.additionalContext);
  if (j.decision === 'block') h.injectedChars += strLen(j.reason);
  if (hs.permissionDecision === 'deny') h.injectedChars += strLen(hs.permissionDecisionReason);
  h.systemMessageChars += strLen(j.systemMessage);
  for (const k of ['updatedToolOutput', 'updatedInput']) {
    if (hs[k] !== undefined) {
      h.replacements++;
      h.replacementChars += strLen(hs[k]);
    }
  }
  return sizes;
}

function toolResultText(content: unknown): { text: string; images: { w: number; h: number }[]; unknownImages: number } {
  if (typeof content === 'string') return { text: content, images: [], unknownImages: 0 };
  const images: { w: number; h: number }[] = [];
  let unknownImages = 0;
  let text = '';
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') text += (text ? '\n' : '') + String(b.text ?? '');
      else if (b?.type === 'image') {
        const d = typeof b?.source?.data === 'string' ? pngDimensions(b.source.data) : null;
        if (d) images.push({ w: d.width, h: d.height });
        else unknownImages++;
      }
    }
  }
  return { text, images, unknownImages };
}

/** Parse Claude Code stream-json events. */
export function normalizeStream(events: any[]): NormSession {
  const messages: NormMessage[] = [];
  const byId = new Map<string, NormMessage>();
  const results = new Map<string, NormResult>();
  let tools: string[] = [];
  let skills: string[] = [];
  let ccv: string | null = null;
  let finalResultText: string | null = null;
  const hooks = new Map<string, HookStats>();
  const pendingTrims: { origChars: number; newChars: number }[] = []; // no id: pair by stream order
  const trimsById = new Map<string, { origChars: number; newChars: number }>();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'system' && e.subtype === 'hook_response') {
      const key = String(e.hook_name ?? `${e.hook_event ?? '?'}:?`);
      const h = hooks.get(key) ?? emptyHook(key);
      const sizes = classifyHookResponse(e, h);
      // Post-tool hooks run just before their tool_result is emitted: pair by stream order.
      if (sizes?.toolUseId) trimsById.set(sizes.toolUseId, { origChars: sizes.origChars, newChars: sizes.newChars });
      else if (sizes && /^PostToolUse/.test(String(e.hook_event ?? key))) pendingTrims.push({ origChars: sizes.origChars, newChars: sizes.newChars });
      hooks.set(key, h);
      continue;
    }
    if (e.type === 'system' && e.subtype === 'init') {
      tools = Array.isArray(e.tools) ? e.tools.map(String) : [];
      skills = Array.isArray(e.skills) ? e.skills.map(String) : [];
      ccv = e.claude_code_version ?? null;
      continue;
    }
    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      const id = String(m.id ?? e.uuid ?? `anon-${messages.length}`);
      let msg = byId.get(id);
      if (!msg) {
        const u = m.usage;
        msg = {
          id,
          model: m.model,
          thread: e.parent_tool_use_id ? String(e.parent_tool_use_id) : 'main',
          sig: u ? { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } : null,
          toolUses: [],
          text: '',
        };
        byId.set(id, msg);
        messages.push(msg);
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'text' && c.text) msg.text += (msg.text ? '\n' : '') + c.text;
        else if (c?.type === 'tool_use' && !msg.toolUses.some((t) => t.id === c.id)) msg.toolUses.push({ id: String(c.id), name: String(c.name), input: c.input ?? {} });
      }
      if (m.stop_reason) msg.stopReason = m.stop_reason;
      continue;
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      const tur = e.tool_use_result;
      for (const c of e.message.content) {
        if (c?.type !== 'tool_result') continue;
        const { text, images, unknownImages } = toolResultText(c.content);
        let imgTok = images.reduce((a, i) => a + imageTokensEst(i.w, i.h), 0);
        let known = unknownImages === 0;
        // Claude Code's tool_use_result carries the displayed dimensions for Read on images.
        const dims = tur?.file?.dimensions;
        if (unknownImages > 0 && dims && (dims.displayWidth || dims.originalWidth)) {
          imgTok += imageTokensEst(dims.displayWidth ?? dims.originalWidth, dims.displayHeight ?? dims.originalHeight) * unknownImages;
          known = true;
        }
        results.set(String(c.tool_use_id), {
          chars: text.length,
          images: images.length + unknownImages,
          imageTokensEst: imgTok,
          imageDimsKnown: known,
          isError: c.is_error === true,
          head: oneLine(text, 160),
          ...(() => {
            const id = String(c.tool_use_id);
            const exact = trimsById.get(id);
            if (exact) {
              trimsById.delete(id);
              return { hookTrim: exact };
            }
            return pendingTrims.length ? { hookTrim: pendingTrims.shift()! } : {};
          })(),
        });
      }
      continue;
    }
    if (e.type === 'result' && typeof e.result === 'string') finalResultText = e.result;
  }
  return { messages, results, tools, skills, claudeCodeVersion: ccv, finalResultText, hooks };
}

/** Parse the runner's trace.jsonl (api backend). */
export function normalizeTrace(entries: any[]): NormSession {
  const messages: NormMessage[] = [];
  const results = new Map<string, NormResult>();
  const toolInput = new Map<string, any>();
  let tools: string[] = [];
  let finalResultText: string | null = null;
  for (const t of entries) if (t?.type === 'tool_call' && t.id) toolInput.set(String(t.id), t.input);
  let n = 0;
  for (const t of entries) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'start') tools = Array.isArray(t.tools) ? t.tools.map(String) : [];
    else if (t.type === 'model_call') {
      const u = t.usage ?? {};
      const msg: NormMessage = {
        id: String(t.messageId ?? `trace-${++n}`),
        model: t.model,
        thread: t.subagent ? String(t.subagent) : 'main',
        sig: t.usage ? { input: u.inputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: u.cacheWriteTokens ?? 0 } : null,
        toolUses: (Array.isArray(t.toolUses) ? t.toolUses : []).map((x: any) => ({ id: String(x.id), name: String(x.name), input: toolInput.get(String(x.id)) ?? {} })),
        text: typeof t.text === 'string' ? t.text : '',
        stopReason: t.stopReason,
        purpose: t.purpose,
      };
      messages.push(msg);
      if (msg.thread === 'main' && msg.text) finalResultText = msg.text;
    } else if (t.type === 'tool_call' && t.id && !results.has(String(t.id))) {
      const chars = typeof t.returnedChars === 'number' ? t.returnedChars : typeof t.output === 'string' ? t.output.length : 0;
      results.set(String(t.id), {
        chars,
        images: Number(t.images) || 0,
        imageTokensEst: 0,
        imageDimsKnown: !(Number(t.images) > 0),
        isError: t.isError === true,
        head: oneLine(typeof t.output === 'string' ? t.output : '', 160),
      });
    }
  }
  return { messages, results, tools, skills: [], claudeCodeVersion: null, finalResultText, hooks: new Map() };
}

// ---------------------------------------------------------------------------
// Tool-input analysis
// ---------------------------------------------------------------------------

const BUILD_RE = /\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\bvite\s+build\b|\btsc\b(?!-)/;

function splitShell(cmd: string): string[] {
  // Drop heredoc bodies so their contents are not parsed as commands.
  const lines = cmd.split('\n');
  const kept: string[] = [];
  let until: string | null = null;
  for (const l of lines) {
    if (until !== null) {
      if (l.trim() === until) until = null;
      continue;
    }
    kept.push(l);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(l);
    if (m) until = m[1];
  }
  return kept
    .join('\n')
    .split(/\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolvePath(p: string, cwd: string | null): string {
  if (p.startsWith('/') || !cwd) return posix.normalize(p);
  return posix.normalize(posix.join(cwd, p));
}

/** Files a shell command reads (cat/head/tail/less/sed -n … file) and writes (> file, tee file). */
export function shellFileOps(cmd: string): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  let cwd: string | null = null;
  for (const seg of splitShell(cmd)) {
    const words = seg.split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]|['"]$/g, ''));
    if (!words.length) continue;
    if (words[0] === 'cd' && words[1]) {
      cwd = resolvePath(words[1], cwd);
      continue;
    }
    // Redirect targets: "> file" or ">file" / ">> file".
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const m = /^(\d?>>?)(.*)$/.exec(w);
      if (!m || m[1].startsWith('2')) continue;
      const target = m[2] || words[i + 1];
      if (target && !target.startsWith('&') && target !== '/dev/null' && !target.startsWith('<')) writes.push(resolvePath(target, cwd));
    }
    if (words[0] === 'tee') for (const w of words.slice(1)) if (!w.startsWith('-')) writes.push(resolvePath(w, cwd));
    if (['cat', 'head', 'tail', 'less', 'more', 'nl', 'sed', 'wc'].includes(words[0])) {
      const args = words.slice(1);
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (/^\d?>/.test(a) || a.startsWith('<')) break; // redirect: stop
        if (a.startsWith('-')) {
          if (words[0] !== 'sed' && /^-(n|c)$/.test(a)) i++; // head -n 50
          continue;
        }
        if (words[0] === 'sed' && /^\d|^s[/|]|^'/.test(a)) continue; // sed script
        if (/^\d+$/.test(a)) continue;
        reads.push(resolvePath(a, cwd));
      }
    }
  }
  return { reads: [...new Set(reads)], writes: [...new Set(writes)] };
}

function summarizeInput(name: string, input: any, maxLen = 110): string {
  if (!input || typeof input !== 'object') return '';
  const n = name.toLowerCase();
  if (n === 'bash' || n === 'run_command') {
    const cmd = String(input.command ?? input.cmd ?? '');
    const heredoc = /^(.*?<<-?\s*['"]?\w+['"]?)/m.exec(cmd);
    if (heredoc && cmd.length > heredoc[1].length + 40) {
      const before = cmd.slice(0, heredoc.index + heredoc[1].length);
      return oneLine(`${before} … [${cmd.length} chars]`, maxLen);
    }
    return oneLine(cmd, maxLen);
  }
  if (n === 'read' || n === 'read_file' || n === 'view_image') {
    const p = String(input.file_path ?? input.path ?? '');
    const range = input.offset || input.limit ? ` [${input.offset ?? 0}+${input.limit ?? '…'}]` : '';
    return oneLine(p + range, maxLen);
  }
  if (n === 'write' || n === 'write_file') return oneLine(`${input.file_path ?? input.path ?? ''} (${String(input.content ?? '').length} chars)`, maxLen);
  if (n === 'edit' || n === 'edit_file') {
    const o = String(input.old_string ?? input.old ?? input.oldText ?? '').length;
    const nw = String(input.new_string ?? input.new ?? input.newText ?? '').length;
    return oneLine(`${input.file_path ?? input.path ?? ''} (−${o}/+${nw} chars${input.replace_all ? ', all' : ''})`, maxLen);
  }
  if (n === 'task' || n === 'agent') return oneLine(`${input.subagent_type ?? 'agent'}: ${input.description ?? ''} (prompt ${String(input.prompt ?? '').length} chars)`, maxLen);
  if (n === 'list_dir' || n === 'glob' || n === 'grep') return oneLine(String(input.path ?? input.pattern ?? JSON.stringify(input)), maxLen);
  return oneLine(JSON.stringify(input), maxLen);
}

function fileOps(name: string, input: any): { reads: string[]; writes: string[]; writeKind?: 'whole-file' | 'edit'; isBuild: boolean } {
  const n = name.toLowerCase();
  const p = String(input?.file_path ?? input?.path ?? '');
  if (n === 'read' || n === 'read_file' || n === 'view_image') return { reads: p ? [posix.normalize(p)] : [], writes: [], isBuild: false };
  if (n === 'write' || n === 'write_file') return { reads: [], writes: p ? [posix.normalize(p)] : [], writeKind: 'whole-file', isBuild: false };
  if (n === 'edit' || n === 'edit_file' || n === 'notebookedit') return { reads: [], writes: p ? [posix.normalize(p)] : [], writeKind: 'edit', isBuild: false };
  if (n === 'bash' || n === 'run_command') {
    const cmd = String(input?.command ?? input?.cmd ?? '');
    const ops = shellFileOps(cmd);
    return { ...ops, writeKind: ops.writes.length ? 'whole-file' : undefined, isBuild: BUILD_RE.test(splitShell(cmd).join('\n')) };
  }
  return { reads: [], writes: [], isBuild: false };
}

// ---------------------------------------------------------------------------
// Join + build
// ---------------------------------------------------------------------------

/** Match messages to usage records: exact request-side signature first, then order among leftovers. */
export function joinMessages(messages: NormMessage[], records: UsageRecord[]): Map<number, NormMessage> {
  const out = new Map<number, NormMessage>(); // record index -> message
  const used = new Set<number>();
  const pending: NormMessage[] = [];
  for (const m of messages) {
    let hit = -1;
    if (m.sig) {
      for (let i = 0; i < records.length; i++) {
        if (used.has(i) || records[i].purpose === 'background') continue;
        const r = records[i];
        if (r.inputTokens === m.sig.input && r.cacheReadTokens === m.sig.cacheRead && r.cacheWriteTokens === m.sig.cacheWrite) {
          hit = i;
          break;
        }
      }
    }
    if (hit >= 0) {
      used.add(hit);
      out.set(hit, m);
    } else pending.push(m);
  }
  // Order fallback: leftovers in sequence, skipping background records.
  let cursor = 0;
  for (const m of pending) {
    while (cursor < records.length && (used.has(cursor) || records[cursor].purpose === 'background')) cursor++;
    if (cursor >= records.length) break;
    used.add(cursor);
    out.set(cursor, m);
  }
  return out;
}

function rebuildPromptChars(runDir: string, specDir: string): number | null {
  const cfg = readJson(join(runDir, 'config', 'resolved.json')) ?? readJson(join(runDir, 'config', 'config.json'));
  if (!cfg) return null;
  const names: string[] = Array.isArray(cfg.inlineSpecFiles) ? cfg.inlineSpecFiles : [];
  const inline: { name: string; content?: string }[] = [];
  for (const name of names) {
    if (/\.(png|jpe?g)$/i.test(name)) {
      inline.push({ name });
      continue;
    }
    const p = join(specDir, name);
    if (!existsSync(p)) return null;
    inline.push({ name, content: readFileSync(p, 'utf8') });
  }
  try {
    return buildClaudeCodePrompt({ designDelivery: cfg.designDelivery ?? 'file-only', inlineSpecFiles: names }, inline).length;
  } catch {
    return null;
  }
}

export function buildSessionProfile(runDir: string, opts: BuildProfileOptions = {}): SessionProfile {
  const largeChars = opts.largeOutputChars ?? 6000;
  const specDir = opts.specDir ?? join(runDir, '..', '..', '..', 'benchmark', 'spec');
  const run = readJson(join(runDir, 'run.json'));
  const usageAll = readJsonl(join(runDir, 'usage.jsonl')) as UsageRecord[];
  const streamEvents = readJsonl(join(runDir, 'claude-stream.jsonl'));
  const traceEntries = readJsonl(join(runDir, 'trace.jsonl'));
  const notes: string[] = [];

  const records = usageAll.filter((r) => r.purpose !== 'count-tokens');
  const hasStream = streamEvents.length > 0;
  const traceStart = traceEntries.find((t) => t?.type === 'start');
  const backend: SessionProfile['backend'] = hasStream || run?.backend === 'claude-code' || traceStart?.backend === 'claude-code' ? 'claude-code' : traceEntries.length || run ? 'api' : 'unknown';
  const sess = hasStream ? normalizeStream(streamEvents) : normalizeTrace(traceEntries);
  if (!hasStream && backend === 'claude-code')
    notes.push(traceEntries.length ? 'claude-stream.jsonl missing: tool data comes from trace.jsonl (outputs clipped).' : 'No claude-stream.jsonl or trace.jsonl: no tool data.');
  if (run?.failureReason) notes.push(`Run failure: ${oneLine(String(run.failureReason), 300)}`);
  if (!records.length) notes.push('usage.jsonl has no records: token figures are empty (nothing is inferred from the stream).');

  const join_ = joinMessages(sess.messages, records);
  const joinedMsgIds = new Set([...join_.values()].map((m) => m.id));
  const unjoinedMessages = sess.messages.filter((m) => !joinedMsgIds.has(m.id));

  // --- per-call ---
  const calls: CallProfile[] = [];
  const lastCtx = new Map<string, number>();
  const msgCallIndex = new Map<string, number>();
  records.forEach((r, i) => {
    const m = join_.get(i);
    const purpose = m && m.thread !== 'main' ? 'subagent' : r.purpose || 'agent-turn';
    const thread = r.purpose === 'background' ? 'background' : m ? m.thread : purpose === 'agent-turn' ? 'main' : purpose;
    const ctx = (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    const prev = lastCtx.get(thread);
    lastCtx.set(thread, ctx);
    const c: CallProfile = {
      index: i + 1,
      ts: r.timestamp,
      model: r.model,
      purpose,
      thread,
      ...(m ? { messageId: m.id } : {}),
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
      thinkingTokens: thinkingOf(r),
      totalTokens: r.totalTokens ?? 0,
      contextTokens: ctx,
      contextDelta: prev === undefined ? null : ctx - prev,
      tools: m ? m.toolUses.map((t) => t.name) : [],
      toolUseIds: m ? m.toolUses.map((t) => t.id) : [],
      textChars: m ? m.text.length : 0,
      ...(m?.stopReason ? { stopReason: m.stopReason } : {}),
      joined: !!m,
      usageEstimated: !!r.usageEstimated,
    };
    calls.push(c);
    if (m) msgCallIndex.set(m.id, c.index);
  });
  const unjoinedUsageRecords = calls.filter((c) => !c.joined && c.purpose !== 'background').length;
  if (unjoinedUsageRecords) notes.push(`${unjoinedUsageRecords} usage record(s) have no matching stream message (e.g. a subagent turn the stream does not echo); their tokens are counted, their tools are unknown.`);
  if (unjoinedMessages.length) notes.push(`${unjoinedMessages.length} stream message(s) had no usage record; their tool calls are listed with callIndex null.`);

  // --- totals ---
  const totals = { ...emptyKinds(), modelCalls: calls.length, costUsd: 0, anyEstimated: false };
  const byPurpose: Record<string, PurposeTotals> = {};
  for (const [i, c] of calls.entries()) {
    addKinds(totals, c);
    totals.costUsd += records[i].costUsd ?? 0;
    totals.anyEstimated ||= !!records[i].usageEstimated;
    const b = (byPurpose[c.purpose] ??= { ...emptyKinds(), calls: 0 });
    addKinds(b, c);
    b.calls++;
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;

  // --- tool calls ---
  const callsByThread = new Map<string, number[]>();
  for (const c of calls) {
    const arr = callsByThread.get(c.thread) ?? [];
    arr.push(c.index);
    callsByThread.set(c.thread, arr);
  }
  const tools: ToolCallProfile[] = [];
  for (const m of sess.messages) {
    const ci = msgCallIndex.get(m.id) ?? null;
    for (const tu of m.toolUses) {
      const res = sess.results.get(tu.id);
      const chars = res?.chars ?? 0;
      const outTok = estTokens(chars) + (res?.imageTokensEst ?? 0);
      const threadCalls = callsByThread.get(m.thread) ?? [];
      const remaining = ci === null ? 0 : threadCalls.filter((x) => x > ci).length;
      const ops = fileOps(tu.name, tu.input);
      tools.push({
        id: tu.id,
        callIndex: ci,
        thread: m.thread,
        name: tu.name,
        inputSummary: summarizeInput(tu.name, tu.input),
        inputChars: JSON.stringify(tu.input ?? {}).length,
        outputChars: chars,
        images: res?.images ?? 0,
        outputTokensEst: outTok,
        isError: res?.isError ?? false,
        remainingCalls: remaining,
        carriedTokensEst: outTok * remaining,
        reads: ops.reads,
        writes: ops.writes,
        ...(ops.writeKind ? { writeKind: ops.writeKind } : {}),
        isBuild: ops.isBuild,
        ...(res?.head ? { outputHead: res.head } : {}),
        ...(res?.hookTrim
          ? (() => {
              const saved = estTokens(Math.max(0, res.hookTrim.origChars - res.hookTrim.newChars));
              return { hookTrim: { ...res.hookTrim, savedTokensEst: saved, savedCarriedTokensEst: saved * remaining } };
            })()
          : {}),
      });
      if (res && res.images > 0 && !res.imageDimsKnown) notes.push(`Tool ${tu.id} returned ${res.images} image(s) of unknown size: their tokens are not in outputTokensEst.`);
    }
  }

  const statMap = new Map<string, ToolNameStats>();
  for (const t of tools) {
    const s = statMap.get(t.name) ?? { name: t.name, count: 0, errors: 0, outputChars: 0, outputTokensEst: 0, carriedTokensEst: 0 };
    s.count++;
    if (t.isError) s.errors++;
    s.outputChars += t.outputChars;
    s.outputTokensEst += t.outputTokensEst;
    s.carriedTokensEst += t.carriedTokensEst;
    statMap.set(t.name, s);
  }
  const toolStats = [...statMap.values()].sort((a, b) => b.carriedTokensEst - a.carriedTokensEst || b.count - a.count);

  // --- overhead ---
  const mainCalls = calls.filter((c) => c.thread === 'main');
  const first = mainCalls[0] ?? null;
  let overhead: OverheadEstimate;
  if (backend === 'claude-code') {
    const promptChars = rebuildPromptChars(runDir, specDir);
    const promptTok = promptChars === null ? null : estTokens(promptChars);
    const fixed = first && promptTok !== null ? Math.max(0, first.contextTokens - promptTok) : null;
    overhead = {
      firstCallContextTokens: first?.contextTokens ?? null,
      firstCallCacheReadTokens: first?.cacheReadTokens ?? null,
      userPromptTokensEst: promptTok,
      userPromptChars: promptChars,
      fixedOverheadTokensEst: fixed,
      overheadReReadTokensEst: fixed === null ? null : fixed * Math.max(0, mainCalls.length - 1),
      overheadShareOfTotal: fixed === null || !totals.totalTokens ? null : (fixed * mainCalls.length) / totals.totalTokens,
      method:
        'first main call context − task prompt (rebuilt from the config snapshot + spec files with the current prompt builder, chars/4). Covers the Claude Code system prompt, tool definitions, skills listing, appended system prompt and CLAUDE.md.',
    };
  } else {
    const sysChars = typeof traceStart?.systemChars === 'number' ? traceStart.systemChars : null;
    const fixed = sysChars !== null && first ? estTokens(sysChars) : null;
    overhead = {
      firstCallContextTokens: first?.contextTokens ?? null,
      firstCallCacheReadTokens: first?.cacheReadTokens ?? null,
      userPromptTokensEst: null,
      userPromptChars: null,
      fixedOverheadTokensEst: fixed,
      overheadReReadTokensEst: fixed === null ? null : fixed * Math.max(0, mainCalls.length - 1),
      overheadShareOfTotal: fixed === null || !totals.totalTokens ? null : (fixed * mainCalls.length) / totals.totalTokens,
      method: sysChars !== null ? 'api backend: system prompt chars/4 from the trace start entry (tool definitions not included).' : 'api backend: no system prompt size in the trace.',
    };
  }

  // --- final summary ---
  const lastMain = [...mainCalls].reverse().find((c) => c.joined);
  const lastMsg = lastMain ? sess.messages.find((m) => m.id === lastMain.messageId) : undefined;
  const finalText = lastMsg && lastMsg.toolUses.length === 0 ? lastMsg.text : (sess.finalResultText ?? '');
  const finalSummary = finalText ? { chars: finalText.length, outputTokens: lastMain && lastMsg?.toolUses.length === 0 ? lastMain.outputTokens : null, head: oneLine(finalText, 200) } : null;

  const waste = detectWaste({ calls, tools, sess, totals, finalSummary, largeChars });

  const profile: SessionProfile = {
    version: SESSION_PROFILE_VERSION,
    runId: run?.runId ?? basename(runDir),
    backend,
    configId: run?.configId ?? traceStart?.configId ?? null,
    model: records.find((r) => r.purpose !== 'background')?.model ?? traceStart?.model ?? null,
    status: run?.status ?? null,
    usedMockProvider: !!run?.usedMockProvider,
    generatedAt: new Date().toISOString(),
    sources: {
      usage: usageAll.length > 0,
      stream: hasStream,
      trace: traceEntries.length > 0,
      joined: join_.size,
      unjoinedUsageRecords,
      unjoinedMessages: unjoinedMessages.length,
      countTokensRecords: usageAll.length - records.length,
    },
    environment: { toolsAvailable: sess.tools, skillsAvailable: sess.skills, claudeCodeVersion: sess.claudeCodeVersion },
    hooks: hookList(sess.hooks),
    hookSavings: (() => {
      const hl = hookList(sess.hooks);
      const trims = tools.filter((t) => t.hookTrim);
      const measured = hl.reduce((a, h) => a + h.measuredReplacements, 0);
      return {
        measured,
        unmeasuredReplacements: Math.max(0, hl.reduce((a, h) => a + h.replacements, 0) - measured),
        savedChars: hl.reduce((a, h) => a + Math.max(0, h.origChars - h.newChars), 0),
        savedTokensEst: trims.reduce((a, t) => a + t.hookTrim!.savedTokensEst, 0),
        savedCarriedTokensEst: trims.reduce((a, t) => a + t.hookTrim!.savedCarriedTokensEst, 0),
      };
    })(),
    configAudit: run?.configAudit ? { flagged: !!run.configAudit.flagged, reasons: Array.isArray(run.configAudit.reasons) ? run.configAudit.reasons.map(String) : [] } : null,
    totals,
    byPurpose,
    overhead,
    calls,
    tools,
    toolStats,
    waste,
    finalSummary,
    timeline: [],
    notes: [...new Set(notes)],
  };
  profile.timeline = buildTimeline(profile);
  return profile;
}

// ---------------------------------------------------------------------------
// Waste detectors (exported individually for tests)
// ---------------------------------------------------------------------------

interface DetectCtx {
  calls: CallProfile[];
  tools: ToolCallProfile[];
  sess: Pick<NormSession, 'tools' | 'skills' | 'hooks'>;
  totals: TokenKinds;
  finalSummary: SessionProfile['finalSummary'];
  largeChars: number;
}

const callRef = (t: ToolCallProfile) => (t.callIndex === null ? '#?' : `#${t.callIndex}`);

export function detectRepeatedReads(tools: ToolCallProfile[]): WasteSignal[] {
  const seen = new Map<string, ToolCallProfile[]>();
  const writtenAt = new Map<string, number[]>(); // path -> tool positions that wrote it
  tools.forEach((t, i) => {
    for (const p of t.writes) writtenAt.set(p, [...(writtenAt.get(p) ?? []), i]);
    for (const p of t.reads) {
      if (p.includes('*')) continue;
      seen.set(p, [...(seen.get(p) ?? []), t]);
    }
  });
  const out: WasteSignal[] = [];
  for (const [p, ts] of seen) {
    if (ts.length < 2) continue;
    const tokens = ts.slice(1).reduce((a, t) => a + Math.round(t.outputTokensEst / Math.max(1, t.reads.length)), 0);
    out.push({
      kind: 'repeated-read',
      severity: ts.length >= 3 ? 'medium' : 'low',
      title: `${p} read ${ts.length}×`,
      evidence: ts.map((t) => `${callRef(t)} ${t.name}: ${t.inputSummary}`),
      tokens,
      tokensEstimated: true,
    });
  }
  return out;
}

export function detectErrorRetries(tools: ToolCallProfile[], calls: CallProfile[]): WasteSignal[] {
  const out: WasteSignal[] = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (!t.isError) continue;
    const next = tools.slice(i + 1, i + 4).find((x) => x.name === t.name && x.thread === t.thread);
    // Tokens: the model call(s) spent reacting up to and including the one that issued the retry
    // (exact, gateway). Without a later retry call, the failed output's carried cost (estimate).
    const reactCalls = next && t.callIndex !== null && next.callIndex !== null ? calls.filter((c) => c.index > t.callIndex! && c.index <= next.callIndex! && c.thread === t.thread) : [];
    const turnTokens = reactCalls.reduce((a, c) => a + c.totalTokens, 0);
    out.push({
      kind: 'error-retry',
      severity: reactCalls.length ? 'medium' : 'low',
      title: next ? `${t.name} failed then retried (${callRef(t)} → ${callRef(next)})${reactCalls.length ? `: ${reactCalls.length} extra turn(s)` : ''}` : `${t.name} failed (${callRef(t)}), no retry seen`,
      evidence: [
        `fail ${callRef(t)}: ${t.inputSummary}`,
        `error: ${t.outputHead ?? ''}`.slice(0, 180),
        ...(next ? [`retry ${callRef(next)}: ${next.inputSummary}`] : []),
        ...(reactCalls.length ? [`retry turn(s) ${reactCalls.map((c) => '#' + c.index).join(',')} cost ${fmtK(turnTokens)} tok (exact); failed output carried ≈${fmtK(t.carriedTokensEst)} tok`] : []),
      ],
      tokens: reactCalls.length ? turnTokens : t.carriedTokensEst,
      tokensEstimated: !reactCalls.length,
    });
  }
  return out;
}

export function detectLargeOutputs(tools: ToolCallProfile[], largeChars: number): WasteSignal[] {
  return tools
    .filter((t) => t.outputChars > largeChars || t.outputTokensEst > estTokens(largeChars))
    .map((t) => ({
      kind: (t.images > 0 ? 'image-read' : 'large-output') as WasteKind,
      severity: (t.carriedTokensEst > 20_000 ? 'high' : t.carriedTokensEst > 5000 ? 'medium' : 'low') as WasteSignal['severity'],
      title: `${t.name} ${callRef(t)} returned ${t.images > 0 ? `${t.images} image(s) ≈${fmtK(t.outputTokensEst)} tok` : `${fmtK(t.outputChars)} chars ≈${fmtK(t.outputTokensEst)} tok`}, carried ${t.remainingCalls} calls`,
      evidence: [`${t.inputSummary}`, ...(t.outputHead ? [`head: ${t.outputHead.slice(0, 120)}`] : [])],
      tokens: t.carriedTokensEst,
      tokensEstimated: true,
    }));
}

export function detectRepeatedBuilds(tools: ToolCallProfile[]): WasteSignal[] {
  const builds = tools.filter((t) => t.isBuild);
  if (builds.length < 2) return [];
  return [
    {
      kind: 'repeated-build',
      severity: builds.length >= 4 ? 'medium' : 'low',
      title: `build run ${builds.length}×`,
      evidence: builds.map((t) => `${callRef(t)}${t.isError ? ' (failed)' : ''}: ${t.inputSummary}`),
      tokens: builds.slice(1).reduce((a, t) => a + t.carriedTokensEst, 0),
      tokensEstimated: true,
    },
  ];
}

export function detectRewrites(tools: ToolCallProfile[]): WasteSignal[] {
  const whole = new Map<string, ToolCallProfile[]>();
  for (const t of tools) if (t.writeKind === 'whole-file') for (const p of t.writes) whole.set(p, [...(whole.get(p) ?? []), t]);
  const out: WasteSignal[] = [];
  for (const [p, ts] of whole) {
    if (ts.length < 2) continue;
    out.push({
      kind: 'whole-file-rewrite',
      severity: 'medium',
      title: `${p} written whole ${ts.length}× (an Edit would resend less)`,
      evidence: ts.map((t) => `${callRef(t)} ${t.name}: ${t.inputSummary} (input ${t.inputChars} chars)`),
      // Rewrites cost output tokens; the input chars of the later writes are the estimate.
      tokens: ts.slice(1).reduce((a, t) => a + estTokens(t.inputChars), 0),
      tokensEstimated: true,
    });
  }
  const edits = tools.filter((t) => t.writeKind === 'edit').length;
  const wholeCount = tools.filter((t) => t.writeKind === 'whole-file').length;
  if (wholeCount && !out.length && edits === 0 && wholeCount >= 1) {
    const big = tools.filter((t) => t.writeKind === 'whole-file').sort((a, b) => b.inputChars - a.inputChars);
    out.push({
      kind: 'whole-file-rewrite',
      severity: 'info',
      title: `all ${wholeCount} write(s) were whole-file (no Edit); largest ${fmtK(big[0].inputChars)} chars`,
      evidence: big.slice(0, 4).map((t) => `${callRef(t)} ${t.name}: ${t.inputSummary}`),
      tokens: 0,
      tokensEstimated: false,
    });
  }
  return out;
}

export function detectSubagents(tools: ToolCallProfile[], calls: CallProfile[]): WasteSignal[] {
  const spawns = tools.filter((t) => /^(task|agent)$/i.test(t.name));
  return spawns.map((t) => {
    const sub = calls.filter((c) => c.thread === t.id);
    const tokens = sub.reduce((a, c) => a + c.totalTokens, 0);
    return {
      kind: 'subagent' as const,
      severity: (tokens > 50_000 ? 'high' : tokens > 10_000 ? 'medium' : 'low') as WasteSignal['severity'],
      title: `subagent ${callRef(t)}: ${sub.length} joined call(s), ${fmtK(tokens)} tok`,
      evidence: [t.inputSummary, `result returned to parent: ${t.outputChars} chars`, ...(sub.length ? [`first subagent call context ${fmtK(sub[0].contextTokens)} (cache write ${fmtK(sub[0].cacheWriteTokens)})`] : [])],
      tokens,
      tokensEstimated: false,
    };
  });
}

export function detectThinking(calls: CallProfile[], totals: TokenKinds): WasteSignal[] {
  const th = calls.reduce((a, c) => a + c.thinkingTokens, 0);
  if (!th) return [];
  const top = [...calls].sort((a, b) => b.thinkingTokens - a.thinkingTokens).filter((c) => c.thinkingTokens > 0).slice(0, 3);
  const share = totals.outputTokens ? th / totals.outputTokens : 0;
  return [
    {
      kind: 'thinking',
      severity: share > 0.4 ? 'medium' : share > 0.15 ? 'low' : 'info',
      title: `thinking ${fmtK(th)} tok = ${pct(share)} of output`,
      evidence: top.map((c) => `#${c.index}: ${fmtK(c.thinkingTokens)} thinking of ${fmtK(c.outputTokens)} output`),
      tokens: th,
      tokensEstimated: false,
    },
  ];
}

export function detectFinalSummary(fs: SessionProfile['finalSummary'], threshold = 800): WasteSignal[] {
  if (!fs) return [];
  return [
    {
      kind: 'final-summary',
      severity: fs.chars > threshold * 2 ? 'low' : 'info',
      title: `final summary ${fs.chars} chars${fs.outputTokens !== null ? ` (last call output ${fs.outputTokens} tok)` : ''}`,
      evidence: [fs.head],
      tokens: fs.outputTokens ?? estTokens(fs.chars),
      tokensEstimated: fs.outputTokens === null,
    },
  ];
}

export function detectNoToolTurns(calls: CallProfile[]): WasteSignal[] {
  const main = calls.filter((c) => c.thread === 'main' && c.joined);
  const last = main[main.length - 1];
  const idle = main.filter((c) => c.tools.length === 0 && c !== last);
  if (!idle.length) return [];
  return [
    {
      kind: 'no-tool-turn',
      severity: idle.length >= 3 ? 'medium' : 'low',
      title: `${idle.length} non-final turn(s) issued no tool call`,
      evidence: idle.map((c) => `#${c.index}: ctx ${fmtK(c.contextTokens)}, out ${c.outputTokens}, text ${c.textChars} chars, stop ${c.stopReason ?? '?'}`),
      tokens: idle.reduce((a, c) => a + c.totalTokens, 0),
      tokensEstimated: false,
    },
  ];
}

export function detectUnusedTools(available: string[], tools: ToolCallProfile[], skills: string[] = []): WasteSignal[] {
  if (!available.length) return [];
  const used = new Set(tools.map((t) => t.name));
  const unused = available.filter((t) => !used.has(t));
  if (unused.length < 3) return [];
  return [
    {
      kind: 'unused-tools',
      severity: unused.length >= 10 ? 'medium' : 'low',
      title: `${unused.length}/${available.length} tool definitions loaded but never used${skills.length ? `; ${skills.length} skills listed` : ''}`,
      evidence: [`used: ${[...used].join(', ') || 'none'}`, `unused: ${unused.join(', ')}`, ...(skills.length ? [`skills: ${skills.join(', ')}`] : [])],
      tokens: 0,
      tokensEstimated: true,
    },
  ];
}

export function detectBackground(calls: CallProfile[]): WasteSignal[] {
  const bg = calls.filter((c) => c.purpose === 'background');
  if (!bg.length) return [];
  return [
    {
      kind: 'background-calls',
      severity: 'info',
      title: `${bg.length} background call(s) on another model: ${fmtK(bg.reduce((a, c) => a + c.totalTokens, 0))} tok`,
      evidence: bg.slice(0, 4).map((c) => `#${c.index} ${c.model}: ${fmtK(c.totalTokens)} tok`),
      tokens: bg.reduce((a, c) => a + c.totalTokens, 0),
      tokensEstimated: false,
    },
  ];
}

/** Only text hooks INJECT counts (additionalContext, block reasons, exit-2 stderr); replacements are not waste. */
export function detectHookOutput(hooks: SessionProfile['hooks']): WasteSignal[] {
  const loud = hooks.filter((h) => h.injectedChars > 0);
  if (!loud.length) return [];
  const chars = loud.reduce((a, h) => a + h.injectedChars, 0);
  return [
    {
      kind: 'hook-output',
      severity: chars > 8000 ? 'medium' : 'low',
      title: `hooks injected ${fmtK(chars)} chars into context (additionalContext / block reasons / exit-2 stderr)`,
      evidence: loud.map((h) => `${h.name}: ${h.runs} runs, injected ${h.injectedChars} chars${h.blockingExits ? `, ${h.blockingExits} exit-2` : ''}`),
      tokens: estTokens(chars),
      tokensEstimated: true,
    },
  ];
}

const SEV = { high: 3, medium: 2, low: 1, info: 0 } as const;

const hookList = (m: Map<string, HookStats>) => [...m.values()].sort((a, b) => b.runs - a.runs);

function detectWaste(ctx: DetectCtx): WasteSignal[] {
  const all = [
    ...detectLargeOutputs(ctx.tools, ctx.largeChars),
    ...detectRepeatedReads(ctx.tools),
    ...detectErrorRetries(ctx.tools, ctx.calls),
    ...detectRepeatedBuilds(ctx.tools),
    ...detectRewrites(ctx.tools),
    ...detectSubagents(ctx.tools, ctx.calls),
    ...detectThinking(ctx.calls, ctx.totals),
    ...detectNoToolTurns(ctx.calls),
    ...detectBackground(ctx.calls),
    ...detectUnusedTools(ctx.sess.tools, ctx.tools, ctx.sess.skills),
    ...detectHookOutput(hookList(ctx.sess.hooks)),
    ...detectFinalSummary(ctx.finalSummary),
  ];
  return all.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.tokens - a.tokens);
}

// ---------------------------------------------------------------------------
// Timeline + Markdown
// ---------------------------------------------------------------------------

function buildTimeline(p: SessionProfile): string[] {
  const byCall = new Map<number, ToolCallProfile[]>();
  for (const t of p.tools) if (t.callIndex !== null) byCall.set(t.callIndex, [...(byCall.get(t.callIndex) ?? []), t]);
  return p.calls.map((c) => {
    const d = c.contextDelta === null ? '' : ` (${c.contextDelta >= 0 ? '+' : ''}${fmtK(c.contextDelta)})`;
    const who = c.thread === 'main' ? '' : c.purpose === 'background' ? ` [bg ${c.model}]` : ` [sub]`;
    const th = c.thinkingTokens ? ` th${fmtK(c.thinkingTokens)}` : '';
    const ts = byCall.get(c.index) ?? [];
    const what = ts.length
      ? ts.map((t) => `${t.name}${t.isError ? '!ERR' : ''} ${oneLine(t.inputSummary, 60)} →${fmtK(t.outputTokensEst)}t`).join(' ; ')
      : c.textChars
        ? `text ${c.textChars} chars`
        : c.joined
          ? '(no tool, no text)'
          : '(not in stream)';
    return `#${c.index}${who} ctx ${fmtK(c.contextTokens)}${d} cr${fmtK(c.cacheReadTokens)} cw${fmtK(c.cacheWriteTokens)} in${fmtK(c.inputTokens)} out${fmtK(c.outputTokens)}${th} | ${what}`;
  });
}

interface RenderLimits {
  calls: number;
  tools: number;
  waste: number;
  evidence: number;
  timeline: boolean;
}

function renderWith(p: SessionProfile, L: RenderLimits): string {
  const t = p.totals;
  const lines: string[] = [];
  const share = (n: number) => (t.totalTokens ? pct(n / t.totalTokens) : '—');
  lines.push(`## Session token profile: ${p.runId}`);
  lines.push(
    `${p.backend} · ${p.model ?? '?'} · config ${p.configId ?? '?'} · status ${p.status ?? '?'}${p.usedMockProvider ? ' · MOCK (synthetic tokens)' : ''} · ${t.modelCalls} calls · ${p.tools.length} tool calls`,
  );
  lines.push(
    `**Total ${fmtK(t.totalTokens)}** = cache read ${fmtK(t.cacheReadTokens)} (${share(t.cacheReadTokens)}) + cache write ${fmtK(t.cacheWriteTokens)} (${share(t.cacheWriteTokens)}) + output ${fmtK(t.outputTokens)} (${share(t.outputTokens)}) + input ${fmtK(t.inputTokens)} (${share(t.inputTokens)}); thinking ${fmtK(t.thinkingTokens)} (inside output)${t.anyEstimated ? ' · SOME USAGE ESTIMATED' : ''}`,
  );
  if (p.hooks.length)
    lines.push(
      `Hooks: ${p.hooks
        .map((h) => {
          const parts = [h.injectedChars ? `injected ${h.injectedChars} chars` : '', h.replacements ? `${h.replacements} replacement(s), ${h.replacementChars} chars` : '', h.blockingExits ? `${h.blockingExits} exit-2` : '']
            .filter(Boolean)
            .join(', ');
          return `${h.name} ×${h.runs}${parts ? ` (${parts})` : ''}`;
        })
        .join(' · ')} (replacements replace tool output/input; the tool_result sizes above are post-hook)`,
    );
  const hs = p.hookSavings;
  if (hs.measured || hs.unmeasuredReplacements)
    lines.push(
      `Hook trims (est.): ${[
        hs.measured ? `${hs.measured} measured, saved ${fmtK(hs.savedChars)} chars ≈${fmtK(hs.savedTokensEst)} tok, ≈${fmtK(hs.savedCarriedTokensEst)} tok carried over later calls` : '',
        hs.unmeasuredReplacements ? `${hs.unmeasuredReplacements} replacement(s) without a size line (saving unknown)` : '',
      ]
        .filter(Boolean)
        .join('; ')}`,
    );
  if (p.configAudit?.flagged) lines.push(`CONFIG AUDIT FLAGGED: ${p.configAudit.reasons.join('; ')}`);
  const purposes = Object.entries(p.byPurpose).map(([k, v]) => `${k} ${v.calls} calls/${fmtK(v.totalTokens)}`);
  if (purposes.length) lines.push(`By purpose: ${purposes.join(' · ')}`);
  const o = p.overhead;
  if (o.firstCallContextTokens !== null) {
    lines.push(
      `Overhead (est.): first-call context ${fmtK(o.firstCallContextTokens)} (cache-read from earlier sessions ${fmtK(o.firstCallCacheReadTokens)}) − task prompt ≈${fmtK(o.userPromptTokensEst)} ⇒ fixed system+tools ≈${fmtK(o.fixedOverheadTokensEst)}/call; re-read over later calls ≈${fmtK(o.overheadReReadTokensEst)}; fixed overhead ≈${pct(o.overheadShareOfTotal)} of total.`,
    );
  }
  const main = p.calls.filter((c) => c.thread === 'main');
  if (main.length > 1) {
    const lastCtx = main[main.length - 1].contextTokens;
    const last = main[main.length - 1];
    lines.push(
      `Context growth (main): ${fmtK(main[0].contextTokens)} → ${fmtK(lastCtx)} over ${main.length} calls; sum of per-call context = ${fmtK(main.reduce((a, c) => a + c.contextTokens, 0))} (every call re-sends the whole prefix, so one more turn now costs ≥${fmtK(lastCtx)}). Final turn #${last.index}: ${fmtK(last.totalTokens)} tok = ${share(last.totalTokens)} of total.`,
    );
  }

  if (p.waste.length) {
    lines.push('', `### Waste signals (${p.waste.length})`);
    for (const w of p.waste.slice(0, L.waste)) {
      lines.push(`- [${w.severity}] ${w.kind}: ${w.title}${w.tokens ? ` — ${w.tokensEstimated ? '≈' : ''}${fmtK(w.tokens)} tok` : ''}`);
      for (const e of w.evidence.slice(0, L.evidence)) lines.push(`  - ${oneLine(e, 150)}`);
    }
    if (p.waste.length > L.waste) lines.push(`- … ${p.waste.length - L.waste} more`);
  }

  const costly = [...p.tools].sort((a, b) => b.carriedTokensEst - a.carriedTokensEst || b.outputTokensEst - a.outputTokensEst);
  if (costly.length && L.tools > 0) {
    lines.push('', `### Costliest tool outputs (est. tok = chars/4; carried = est × later calls)`);
    lines.push('| call | tool | input | out chars | est tok | carried | err |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const x of costly.slice(0, L.tools))
      lines.push(`| ${callRef(x)} | ${x.name} | ${oneLine(x.inputSummary, 70).replace(/\|/g, '\\|')} | ${x.outputChars}${x.images ? `+${x.images}img` : ''} | ${fmtK(x.outputTokensEst)} | ${fmtK(x.carriedTokensEst)} | ${x.isError ? 'Y' : ''} |`);
    if (p.toolStats.length) lines.push(`By tool: ${p.toolStats.map((s) => `${s.name} ×${s.count}${s.errors ? ` (${s.errors} err)` : ''} out≈${fmtK(s.outputTokensEst)} carried≈${fmtK(s.carriedTokensEst)}`).join(' · ')}`);
  }

  if (L.calls > 0) {
    lines.push('', '### Per call (exact, gateway)');
    lines.push('| # | ctx | Δctx | cache r | cache w | out | think | tools |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const shown = p.calls.length <= L.calls ? p.calls : [...p.calls].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, L.calls).sort((a, b) => a.index - b.index);
    for (const c of shown)
      lines.push(
        `| ${c.index}${c.thread === 'main' ? '' : c.purpose === 'background' ? ' bg' : ' sub'} | ${fmtK(c.contextTokens)} | ${c.contextDelta === null ? '' : fmtK(c.contextDelta)} | ${fmtK(c.cacheReadTokens)} | ${fmtK(c.cacheWriteTokens)} | ${fmtK(c.outputTokens)} | ${c.thinkingTokens ? fmtK(c.thinkingTokens) : ''} | ${c.tools.join(',') || (c.textChars ? 'text' : '')} |`,
      );
    if (shown.length < p.calls.length) lines.push(`(${p.calls.length - shown.length} smaller calls omitted)`);
  }

  if (L.timeline && p.timeline.length) {
    lines.push('', '### Timeline');
    lines.push('```', ...p.timeline, '```');
  }
  if (p.notes.length) lines.push('', `Notes: ${p.notes.join(' ')}`);
  return lines.join('\n');
}

/** Compact Markdown for an LLM researcher (default ≤ 6000 chars, hard-capped at opts.maxChars). */
export function renderProfileMarkdown(p: SessionProfile, opts: { maxChars?: number } = {}): string {
  const max = Math.max(300, opts.maxChars ?? 6000);
  const ladder: RenderLimits[] = [
    { calls: 40, tools: 8, waste: 10, evidence: 4, timeline: true },
    { calls: 25, tools: 6, waste: 8, evidence: 3, timeline: true },
    { calls: 15, tools: 6, waste: 8, evidence: 3, timeline: false },
    { calls: 10, tools: 5, waste: 6, evidence: 2, timeline: false },
    { calls: 6, tools: 4, waste: 5, evidence: 2, timeline: false },
    { calls: 0, tools: 3, waste: 4, evidence: 1, timeline: false },
    { calls: 0, tools: 0, waste: 3, evidence: 1, timeline: false },
  ];
  // Avoid duplicating the per-call table and the timeline: once both fit, prefer the timeline only for short sessions.
  for (const L of ladder) {
    const lim = p.calls.length <= 20 && L.timeline ? { ...L, calls: 0 } : L;
    const s = renderWith(p, lim);
    if (s.length <= max) return s;
  }
  const s = renderWith(p, ladder[ladder.length - 1]);
  return s.slice(0, max - 20) + '\n…[truncated]';
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Build and write profile.json + profile.md into the run dir. Returns the profile. */
export function writeSessionProfile(runDir: string, opts: BuildProfileOptions & { maxChars?: number } = {}): SessionProfile {
  const p = buildSessionProfile(runDir, opts);
  writeFileSync(join(runDir, 'profile.json'), JSON.stringify(p, null, 2) + '\n');
  writeFileSync(join(runDir, 'profile.md'), renderProfileMarkdown(p, { maxChars: opts.maxChars }) + '\n');
  return p;
}

/** Run dirs under resultsDir/runs that have something to profile. */
export function listProfilableRuns(resultsRoot: string): string[] {
  const runs = join(resultsRoot, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(runs, d.name))
    .filter((d) => ['usage.jsonl', 'claude-stream.jsonl', 'trace.jsonl', 'run.json'].some((f) => existsSync(join(d, f))))
    .sort();
}
