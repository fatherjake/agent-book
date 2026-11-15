/**
 * Claude Code (the real `claude` CLI, subscription auth) as an agent backend.
 *
 *  - runClaudeHeadless: host-side `claude -p` (researcher, evaluator browser agent).
 *  - runClaudeCodeInSandbox: the coding agent inside its container (see run.ts, backend 'claude-code').
 *  - streamToTrace / summarizeStream: stream-json → the runner's trace.jsonl schema.
 *
 * Every claude process gets ANTHROPIC_BASE_URL=<gateway> and CLAUDE_CODE_OAUTH_TOKEN=<placeholder>;
 * the gateway (runner/gateway.ts) swaps in the real token upstream. The user's ~/.claude (settings,
 * CLAUDE.md, plugins, hooks, MCP servers, memory, skills) never leaks in: host processes get a fresh
 * temp CLAUDE_CONFIG_DIR and HOME, containers get their own tmpfs home.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentConfig } from './types.js';
import { PLACEHOLDER_OAUTH_TOKEN, type GatewayHandle } from './gateway.js';
import { logger } from './logger.js';

const log = logger('claude-code');

/** Claude Code version baked into the coding image; must match the host CLI. */
export const CLAUDE_CODE_VERSION = '2.1.325';

/** Env vars a config may set through `claudeCode.env` (documented Claude Code knobs only). */
export const CLAUDE_CODE_ENV_ALLOWLIST = [
  'MAX_THINKING_TOKENS',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'MAX_MCP_OUTPUT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
] as const;

/** Settings keys a config may NOT put in `claudeCode.settings` (they would bypass the gateway, env allowlist or model). */
export const CLAUDE_CODE_SETTINGS_DENYLIST = [
  'env',
  'model',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'forceLoginMethod',
  'forceLoginOrgUUID',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'mcpServers',
  'statusLine',
  'availableModels',
  'fallbackModel',
  // permission / sandbox escalation, plugins and managed-policy knobs
  'sandbox',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'pluginConfigs',
  'allowManagedHooksOnly',
  'allowManagedPermissionRulesOnly',
  'skipDangerousModePermissionPrompt',
  'disableBypassPermissionsMode',
  'additionalDirectories',
  'defaultMode',
  'subagentStatusLine',
  'fileSuggestion',
  'awsCredentialExport',
] as const;

/** `claudeCode.settings.permissions` may only carry rule lists (no defaultMode / additionalDirectories). */
export const CLAUDE_CODE_PERMISSIONS_KEYS = ['allow', 'deny', 'ask'] as const;

/** Hook events a config may register in `claudeCode.settings.hooks` (Claude Code 2.1.325). */
export const CLAUDE_CODE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreCompact',
  'Notification',
] as const;

/** Where config bin scripts live in the coding container (root-owned tmpfs, read-only to node). */
export const FRUGAL_OPT_DIR = '/opt/frugal';
export const FRUGAL_BIN_DIR = '/opt/frugal/bin';
export const FRUGAL_LIBEXEC_DIR = '/opt/frugal/libexec';
/** Audit log the bin wrappers append to (inside the container; writable by node, so best-effort). */
export const FRUGAL_AUDIT_LOG = '/tmp/.frugal/bin-audit.jsonl';
/** tmpfs mount for /opt/frugal (only added when the config has bin/ scripts or docs/). todo layout. */
export const FRUGAL_OPT_TMPFS = `${FRUGAL_OPT_DIR}:rw,nosuid,nodev,exec,size=8m,mode=0755`;
/** Config reference docs (docs/<path>): root-owned, read-only, never loaded into context automatically. */
export const FRUGAL_DOCS_DIR = '/opt/frugal/docs';
/**
 * 'single': one tmpfs AT /opt/frugal (todo; the image has no /opt/frugal). 'split': separate tmpfs mounts
 * for /opt/frugal/bin, /opt/frugal/libexec and /opt/frugal/docs, so a task image's own /opt/frugal/task
 * (services hook) stays visible.
 */
export type OptLayout = 'single' | 'split';

/** tmpfs mounts the coding container needs for the config's bin scripts and docs. */
export function optTmpfsMounts(cfg: Pick<AgentConfig, 'bin' | 'docs'>, layout: OptLayout = 'single'): string[] {
  const bin = !!cfg.bin?.length;
  const docs = !!cfg.docs?.length;
  if (layout === 'single') return bin || docs ? [FRUGAL_OPT_TMPFS] : [];
  const out: string[] = [];
  if (bin) out.push(`${FRUGAL_BIN_DIR}:rw,nosuid,nodev,exec,size=4m,mode=0755`, `${FRUGAL_LIBEXEC_DIR}:rw,nosuid,nodev,exec,size=4m,mode=0755`);
  if (docs) out.push(`${FRUGAL_DOCS_DIR}:rw,nosuid,nodev,noexec,size=2m,mode=0755`);
  return out;
}
/** PATH of the claude process (and therefore of its Bash tool and hooks) in the coding container. */
export const CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Config bin script names (bin/<name>) and hook command syntax. */
export const BIN_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const HOOK_COMMAND_RE = /^\/opt\/frugal\/bin\/([a-z][a-z0-9_-]{0,31})((?: [A-Za-z0-9_.,=:\/+-]{1,64}){0,8})$/;
/** Shebangs a bin script may start with (sh, bash or node). */
export const BIN_SHEBANG_RE = /^#!(?:\/bin\/(?:ba)?sh|\/usr\/bin\/env (?:ba)?sh|\/usr\/bin\/env node|\/usr\/local\/bin\/node)(?:[ \t]+-[A-Za-z]+)*[ \t]*\r?\n/;

/** Env every claude process gets (besides ANTHROPIC_BASE_URL / placeholder token). */
export const CLAUDE_BASE_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_BUG_COMMAND: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '0',
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
};

/** Path of the host `claude` binary ($FRUGAL_CLAUDE_BIN, ~/.local/bin/claude, else `claude` on PATH). */
export function hostClaudeBin(): string {
  if (process.env.FRUGAL_CLAUDE_BIN) return process.env.FRUGAL_CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

// ---------------------------------------------------------------------------
// stream-json parsing
// ---------------------------------------------------------------------------

/** Splits a byte stream into JSON lines; invalid lines are kept as {type:'unparsed', line}. */
export class StreamJsonCollector {
  private buf = '';
  readonly events: any[] = [];
  constructor(private readonly onEvent?: (e: any) => void) {}
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.add(line);
    }
  }
  end(): void {
    const line = this.buf.trim();
    this.buf = '';
    if (line) this.add(line);
  }
  private add(line: string) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      e = { type: 'unparsed', line: line.slice(0, 2000) };
    }
    this.events.push(e);
    try {
      this.onEvent?.(e);
    } catch {
      /* observer errors ignored */
    }
  }
  result(): any | null {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]?.type === 'result') return this.events[i];
    return null;
  }
}

const clip = (v: unknown, max: number): unknown => {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `...[${v.length - max} more chars]` : v;
  if (Array.isArray(v)) return v.map((x) => clip(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, max)]));
  return v;
};

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '[image]' : JSON.stringify(c)))
      .join('\n');
  return content === undefined ? '' : JSON.stringify(content);
}

export interface TraceEntry {
  ts: string;
  type: string;
  turn: number;
  [k: string]: unknown;
}

/**
 * Convert Claude Code stream-json events into the runner's trace.jsonl schema
 * (start / model_call / tool_call / end, each with a numeric `turn`).
 *
 * - One model_call per assistant message id (Claude Code emits one event per content block).
 *   Main-thread messages advance `turn`; subagent (Task) messages keep the parent's turn and carry
 *   `subagent: <parent tool_use id>`.
 * - model_call usage is what the stream reports (may be partial for streamed output); the
 *   authoritative per-call accounting is usage.jsonl from the gateway.
 * - One tool_call per tool_result, joined to its tool_use input.
 */
export function streamToTrace(events: any[], opts: { configId?: string; model?: string; limits?: unknown; extraEnd?: Record<string, unknown> } = {}): TraceEntry[] {
  const out: TraceEntry[] = [];
  let turn = 0;
  const msgTurn = new Map<string, number>(); // message id -> turn
  const msgEntry = new Map<string, TraceEntry>();
  const toolUses = new Map<string, { name: string; input: unknown; ts: string; turn: number; subagent?: string }>();
  let lastTs = events.find((e) => typeof e?.timestamp === 'string')?.timestamp ?? new Date().toISOString();
  const tsOf = (e: any) => (typeof e?.timestamp === 'string' ? e.timestamp : lastTs);
  let toolCalls = 0;
  let toolErrors = 0;

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const ts = tsOf(e);
    lastTs = ts;
    if (e.type === 'system' && e.subtype === 'init') {
      out.push({
        ts,
        type: 'start',
        turn: 0,
        backend: 'claude-code',
        configId: opts.configId,
        model: e.model ?? opts.model,
        provider: 'anthropic',
        isMock: false,
        claudeCodeVersion: e.claude_code_version,
        tools: e.tools,
        skills: e.skills,
        permissionMode: e.permissionMode,
        limits: opts.limits,
      });
      continue;
    }
    if (e.type === 'system') {
      out.push({ ts, type: `system_${e.subtype ?? 'event'}`, turn, ...pickSmall(e) });
      continue;
    }
    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      const id = String(m.id ?? e.uuid ?? `anon-${out.length}`);
      const sub = e.parent_tool_use_id ?? undefined;
      let t = msgTurn.get(id);
      if (t === undefined) {
        if (!sub) turn += 1;
        t = sub ? toolUses.get(sub)?.turn ?? turn : turn;
        msgTurn.set(id, t);
      }
      let entry = msgEntry.get(id);
      if (!entry) {
        entry = { ts, type: 'model_call', turn: t, messageId: id, model: m.model, purpose: sub ? 'subagent' : 'agent-turn', text: '', toolUses: [] as unknown[] };
        if (sub) entry.subagent = sub;
        if (e.error) entry.error = e.error;
        msgEntry.set(id, entry);
        out.push(entry);
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'text' && c.text) entry.text = clip(((entry.text as string) ? entry.text + '\n' : '') + c.text, 8000);
        else if (c?.type === 'thinking') entry.thinkingChars = ((entry.thinkingChars as number) ?? 0) + String(c.thinking ?? '').length;
        else if (c?.type === 'tool_use') {
          (entry.toolUses as unknown[]).push({ id: c.id, name: c.name });
          toolUses.set(c.id, { name: c.name, input: c.input, ts, turn: t, subagent: sub });
        }
      }
      if (m.stop_reason) entry.stopReason = m.stop_reason;
      if (m.usage) {
        const u = m.usage;
        entry.usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          source: 'stream',
        };
      }
      continue;
    }
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c?.type !== 'tool_result') continue;
        const tu = toolUses.get(c.tool_use_id);
        const text = toolResultText(c.content);
        toolCalls++;
        if (c.is_error) toolErrors++;
        const entry: TraceEntry = {
          ts,
          type: 'tool_call',
          turn: tu?.turn ?? turn,
          id: c.tool_use_id,
          tool: tu?.name ?? 'unknown',
          input: clip(tu?.input ?? null, 20_000),
          isError: c.is_error === true,
          durationMs: tu ? Math.max(0, Date.parse(ts) - Date.parse(tu.ts)) || undefined : undefined,
          returnedChars: text.length,
          output: clip(text, 4000),
          images: Array.isArray(c.content) ? c.content.filter((x: any) => x?.type === 'image').length : 0,
        };
        if (tu?.subagent) entry.subagent = tu.subagent;
        out.push(entry);
      }
      continue;
    }
    if (e.type === 'result') {
      out.push({
        ts,
        type: 'end',
        turn,
        status: e.is_error ? 'error' : 'completed',
        subtype: e.subtype,
        terminalReason: e.terminal_reason,
        stopReason: e.stop_reason,
        numTurns: e.num_turns,
        durationMs: e.duration_ms,
        durationApiMs: e.duration_api_ms,
        result: clip(e.result, 4000),
        modelCalls: msgEntry.size,
        toolCalls,
        toolErrors,
        streamUsage: e.usage,
        modelUsage: e.modelUsage,
        totalCostUsdReportedByClaudeCode: e.total_cost_usd,
        ...(opts.extraEnd ?? {}),
      });
      continue;
    }
    if (e.type === 'unparsed') out.push({ ts, type: 'unparsed', turn, line: e.line });
    // rate_limit_event, stream_event, etc. are skipped (they have no trace meaning).
  }
  if (!events.some((e) => e?.type === 'result')) {
    out.push({ ts: lastTs, type: 'end', turn, status: 'no_result', modelCalls: msgEntry.size, toolCalls, toolErrors, ...(opts.extraEnd ?? {}) });
  }
  return out;
}

function pickSmall(e: any): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'type' || k === 'session_id' || k === 'uuid') continue;
    o[k] = clip(v, 500);
  }
  return o;
}

/** Reset time (ISO) when a stream event reports a rejected subscription rate limit, else null. */
export function streamUsageLimit(e: any): string | null {
  if (e?.type !== 'rate_limit_event') return null;
  const info = e.rate_limit_info ?? {};
  if (info.status !== 'rejected') return null;
  const r = Number(info.resetsAt);
  return Number.isFinite(r) && r > 0 ? new Date(r < 1e12 ? r * 1000 : r).toISOString() : new Date(Date.now() + 3600_000).toISOString();
}

/** Number of tool_use blocks in the stream (main thread + subagents). */
export function countToolUses(events: any[]): number {
  const ids = new Set<string>();
  for (const e of events) {
    if (e?.type !== 'assistant') continue;
    for (const c of e.message?.content ?? []) if (c?.type === 'tool_use' && c.id) ids.add(c.id);
  }
  return ids.size;
}

/** Token totals the stream's final result reports (for the cross-check against the gateway). */
export function streamResultTotals(result: any): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | null {
  if (!result) return null;
  // modelUsage covers every model (incl. background/subagent calls); usage may cover only the main loop.
  const mu = result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage as Record<string, any>) : [];
  let t;
  if (mu.length) {
    t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const m of mu) {
      t.inputTokens += m?.inputTokens ?? 0;
      t.outputTokens += m?.outputTokens ?? 0;
      t.cacheReadTokens += m?.cacheReadInputTokens ?? 0;
      t.cacheWriteTokens += m?.cacheCreationInputTokens ?? 0;
    }
  } else if (result.usage) {
    const u = result.usage;
    t = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
  } else return null;
  return { ...t, totalTokens: t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens };
}

// ---------------------------------------------------------------------------
// Host-side headless runner
// ---------------------------------------------------------------------------

export interface HeadlessResult {
  exitCode: number | null;
  timedOut: boolean;
  result: any | null;
  events: any[];
}

/**
 * Spawn host `claude -p` through the gateway, isolated from the user's ~/.claude.
 *
 * Always added: -p --output-format stream-json --verbose --no-session-persistence --strict-mcp-config
 * --setting-sources "" (only `--settings` passed in `args` apply). `args` carries the caller's flags
 * (--model, --system-prompt, --tools, --json-schema, ...). The prompt is sent on stdin.
 * `env` is merged over the minimal env (e.g. PATH or HOME overrides); ANTHROPIC_* and
 * CLAUDE_CODE_OAUTH_TOKEN in `env` are ignored.
 */
export async function runClaudeHeadless(opts: {
  cwd: string;
  prompt: string;
  gateway: GatewayHandle;
  args: string[];
  env?: Record<string, string>;
  timeoutSec: number;
  streamFile: string;
  signal?: AbortSignal;
}): Promise<HeadlessResult> {
  const bin = hostClaudeBin();
  const home = mkdtempSync(join(tmpdir(), 'frugal-cc-home-'));
  const configDir = join(home, '.claude');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dirname(opts.streamFile), { recursive: true });

  const callerEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (/^ANTHROPIC_/.test(k) || k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'CLAUDE_CONFIG_DIR') continue;
    callerEnv[k] = v;
  }
  const binDir = bin.includes('/') ? dirname(bin) : '';
  const env: Record<string, string> = {
    PATH: [binDir, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: 'en_US.UTF-8',
    ...CLAUDE_BASE_ENV,
    ...callerEnv,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: opts.gateway.hostUrl,
    CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_OAUTH_TOKEN,
  };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', ...opts.args];

  const out = createWriteStream(opts.streamFile);
  const collector = new StreamJsonCollector();
  let timedOut = false;
  let stderr = '';
  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const killTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      let killTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), 5000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        log.warn('claude headless timed out; killing process tree', { timeoutSec: opts.timeoutSec });
        stop();
      }, opts.timeoutSec * 1000);
      const onAbort = () => stop();
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (c: Buffer) => {
        out.write(c);
        collector.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        if (stderr.length < 20_000) stderr += c.toString('utf8');
      });
      child.on('error', (e) => {
        stderr += String(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        killTree('SIGKILL'); // reap any leftover children in the group
        resolve(code);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(opts.prompt);
    });
    collector.end();
    if (exitCode !== 0) log.warn('claude headless exited non-zero', { exitCode, timedOut, stderr: stderr.slice(0, 500) });
    return { exitCode, timedOut, result: collector.result(), events: collector.events };
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Coding agent in the sandbox
// ---------------------------------------------------------------------------

export const CONTAINER_HOME = '/home/node';
export const CONTAINER_CONFIG_DIR = '/home/node/.claude';

export const CLAUDE_CODE_TASK_PROMPT = `Build the full-stack todo application described in the product specification.

- The starter project is in /workspace (dependencies are already installed; there is no network access, so you cannot install new packages).
- The specification is in /spec (read-only): requirements.md, api-contract.yaml, design-tokens.md, fixtures and the reference design images /spec/design.png (desktop) and /spec/design-mobile.png (mobile). Use the Read tool to view images.
- When you are finished, /workspace must build with \`npm run build\` and start with \`npm start\`, serving the API under /api and the built frontend at /.`;

/** Task prompt text for Claude Code (spec files inlined per config; images referenced by path). */
export function buildClaudeCodePrompt(cfg: Pick<AgentConfig, 'designDelivery' | 'inlineSpecFiles'>, inline: { name: string; content?: string }[]): string {
  let text = CLAUDE_CODE_TASK_PROMPT;
  if (cfg.designDelivery === 'inline-image') text += `\n\nStart by viewing the reference design /spec/design.png with the Read tool.`;
  const files = inline.filter((f) => f.content !== undefined);
  if (files.length) {
    text += '\n\nSpecification files (also available under /spec):';
    for (const f of files) text += `\n\n<file path="/spec/${f.name}">\n${f.content!.replace(/\s+$/, '')}\n</file>`;
  }
  const images = cfg.inlineSpecFiles.filter((n) => /\.(png|jpe?g)$/i.test(n) && n !== 'design.png');
  for (const img of images) text += `\n\nAlso view the reference image /spec/${img} with the Read tool.`;
  return text;
}

/**
 * Task prompt for a non-todo task: prompt.md, then the config's inline spec files that exist in the task's
 * spec dir (others are skipped), then the images it asks to view.
 */
export function buildTaskPrompt(taskPrompt: string, cfg: Pick<AgentConfig, 'designDelivery' | 'inlineSpecFiles'>, inline: { name: string; content?: string }[]): string {
  let text = taskPrompt.replace(/\s+$/, '');
  const names = new Set(inline.map((f) => f.name));
  if (cfg.designDelivery === 'inline-image' && names.has('design.png')) text += `\n\nStart by viewing the reference design /spec/design.png with the Read tool.`;
  const files = inline.filter((f) => f.content !== undefined);
  if (files.length) {
    text += '\n\nSpecification files (also available under /spec):';
    for (const f of files) text += `\n\n<file path="/spec/${f.name}">\n${f.content!.replace(/\s+$/, '')}\n</file>`;
  }
  for (const img of inline.filter((f) => f.content === undefined && f.name !== 'design.png')) text += `\n\nAlso view the reference image /spec/${img.name} with the Read tool.`;
  return text;
}

/** Add YAML frontmatter (name, description) to a skill file that lacks it. */
export function skillMarkdown(name: string, content: string): string {
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(content) && /^---[\s\S]*?\bdescription\s*:/m.test(content)) return content;
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const firstLine =
    body
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0) ?? name;
  const desc = `${firstLine.slice(0, 200)} (use this skill for the benchmark task)`.replace(/"/g, "'");
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  return `---\nname: ${safeName}\ndescription: "${desc}"\n---\n\n${body.replace(/^\s+/, '')}`;
}

/** Add YAML frontmatter (name, description) to a subagent file that lacks it (Claude Code requires both). */
export function agentMarkdown(name: string, content: string): string {
  return skillMarkdown(name, content).replace(' (use this skill for the benchmark task)', '');
}

/** Files placed under the container's user-level config dir (never inside /workspace). */
export function claudeHomeFiles(cfg: AgentConfig): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  for (const s of cfg.skills) {
    const dirName = s.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
    files.push({ path: `${CONTAINER_CONFIG_DIR}/skills/${dirName}/SKILL.md`, content: skillMarkdown(dirName, s.content) });
  }
  for (const a of cfg.agents ?? []) files.push({ path: `${CONTAINER_CONFIG_DIR}/agents/${a.name}.md`, content: agentMarkdown(a.name, a.content) });
  for (const c of cfg.commands ?? []) files.push({ path: `${CONTAINER_CONFIG_DIR}/commands/${c.name}.md`, content: c.content });
  if (cfg.claudeCode?.claudeMd && cfg.claudeMdContent) files.push({ path: `${CONTAINER_CONFIG_DIR}/CLAUDE.md`, content: cfg.claudeMdContent });
  if (cfg.claudeCode?.settings) files.push({ path: `${CONTAINER_CONFIG_DIR}/frugal-settings.json`, content: JSON.stringify(cfg.claudeCode.settings, null, 2) + '\n' });
  return files;
}

/** Config-driven `claude` flags (model, effort, system prompt, tools, settings). */
export function buildClaudeArgs(cfg: AgentConfig): string[] {
  const cc = cfg.claudeCode ?? { systemPromptMode: 'append' as const };
  const args = ['--model', cfg.model];
  if (cfg.effort) args.push('--effort', cfg.effort);
  const sp = cfg.systemPrompt.trim();
  if (sp) args.push(cc.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt', sp);
  if (cc.tools) args.push('--tools', cc.tools.length ? cc.tools.join(',') : '');
  if (cc.disallowedTools?.length) args.push('--disallowedTools', cc.disallowedTools.join(','));
  if (cc.settings) args.push('--settings', `${CONTAINER_CONFIG_DIR}/frugal-settings.json`);
  // Hook lifecycle events in the stream make hook runs auditable (trace + configAudit.hookCounts).
  if (hasHooks(cfg)) args.push('--include-hook-events');
  return args;
}

/** True when the config registers Claude Code hooks. */
export function hasHooks(cfg: AgentConfig): boolean {
  const h = cfg.claudeCode?.settings?.hooks;
  return !!h && typeof h === 'object' && Object.keys(h).length > 0;
}

/**
 * Audit wrapper installed as /opt/frugal/bin/<name>; the real script is /opt/frugal/libexec/<name>.
 * It passes stdin/stdout/stderr and the exit code through untouched and appends one JSON line per run
 * to FRUGAL_AUDIT_LOG: script, args, exit code, duration and the files under /workspace (excluding
 * node_modules, dist, .git, .vite) that were created or modified while the script ran.
 */
export function binWrapper(name: string): string {
  if (!BIN_NAME_RE.test(name)) throw new Error(`invalid bin name ${name}`);
  const esc = `sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/^/"/; s/$/"/' | paste -sd, -`;
  return `#!/bin/sh
# frugal audit wrapper (generated). Real script: ${FRUGAL_LIBEXEC_DIR}/${name}
d=/tmp/.frugal
mkdir -p "$d" 2>/dev/null
m=$(mktemp "$d/m.XXXXXX" 2>/dev/null) || m=""
s=$(date +%s%3N)
${FRUGAL_LIBEXEC_DIR}/${name} "$@"
rc=$?
e=$(date +%s%3N)
ch=""
if [ -n "$m" ]; then
  ch=$(find /workspace \\( -name node_modules -o -name dist -o -name .git -o -name .vite \\) -prune -o -type f -newer "$m" -print 2>/dev/null | head -n 200 | tr -d '\\t\\r' | ${esc})
  rm -f "$m"
fi
a=$(for x in "$@"; do printf '%s\\n' "$x"; done | head -n 20 | cut -c1-200 | tr -d '\\t\\r' | ${esc})
printf '{"ts":%s,"script":"${name}","args":[%s],"exitCode":%d,"durationMs":%s,"changedFiles":[%s]}\\n' "$s" "$a" "$rc" "$((e - s))" "$ch" >> "$d/bin-audit.jsonl" 2>/dev/null
exit $rc
`;
}

/** Install the config's docs/ files read-only at /opt/frugal/docs (call before installBinScripts). */
export async function installDocs(sandbox: ClaudeSandbox, cfg: AgentConfig, layout: OptLayout = 'single'): Promise<void> {
  const docs = cfg.docs ?? [];
  if (!docs.length) return;
  if (!sandbox.exec) throw new Error('sandbox cannot exec: docs cannot be installed');
  for (const d of docs) {
    if (!DOC_PATH_RE.test(d.path)) throw new Error(`invalid docs path ${d.path}`);
    await sandbox.writeFileBuffer(`${FRUGAL_DOCS_DIR}/${d.path}`, Buffer.from(d.content, 'utf8'), { user: 'root' });
  }
  // Without bin scripts the single layout's /opt/frugal is not locked by installBinScripts; lock it here.
  const lockOpt = layout === 'single' && !cfg.bin?.length ? ` ${FRUGAL_OPT_DIR}` : '';
  const r = await sandbox.exec(`find ${FRUGAL_DOCS_DIR} -type f -exec chmod 0444 {} + && find ${FRUGAL_DOCS_DIR} -type d -exec chmod 0555 {} +${lockOpt ? ` && chmod 0555${lockOpt}` : ''}`, {
    user: 'root',
    timeoutSec: 30,
  });
  if (r.exitCode !== 0) throw new Error(`installing docs failed: ${r.stderr.trim().slice(0, 300)}`);
}

/** docs/<path> inside a config: up to 3 directory levels, plain names. */
export const DOC_PATH_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,3}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Install the config's bin scripts (root-owned, read-only to node) behind audit wrappers. */
export async function installBinScripts(sandbox: ClaudeSandbox, cfg: AgentConfig, layout: OptLayout = 'single'): Promise<void> {
  const bin = cfg.bin ?? [];
  if (!bin.length) return;
  if (!sandbox.exec) throw new Error('sandbox cannot exec: bin scripts cannot be installed');
  for (const b of bin) {
    if (!BIN_NAME_RE.test(b.name)) throw new Error(`invalid bin name ${b.name}`);
    await sandbox.writeFileBuffer(`${FRUGAL_LIBEXEC_DIR}/${b.name}`, Buffer.from(b.content, 'utf8'), { user: 'root' });
    await sandbox.writeFileBuffer(`${FRUGAL_BIN_DIR}/${b.name}`, Buffer.from(binWrapper(b.name), 'utf8'), { user: 'root' });
  }
  // Files were written by root (the container runs with --cap-drop ALL, so no chown is needed or possible).
  // split layout: /opt/frugal itself belongs to the (read-only) image, only the mounts are locked.
  const r = await sandbox.exec(`chmod 0755 ${FRUGAL_BIN_DIR}/* ${FRUGAL_LIBEXEC_DIR}/* && chmod 0555 ${FRUGAL_BIN_DIR} ${FRUGAL_LIBEXEC_DIR}${layout === 'single' ? ` ${FRUGAL_OPT_DIR}` : ''}`, {
    user: 'root',
    timeoutSec: 30,
  });
  if (r.exitCode !== 0) throw new Error(`installing bin scripts failed: ${r.stderr.trim().slice(0, 300)}`);
  const l = await sandbox.exec('mkdir -p /tmp/.frugal', { user: 'node', timeoutSec: 30 });
  if (l.exitCode !== 0) throw new Error(`creating the bin audit dir failed: ${l.stderr.trim().slice(0, 300)}`);
}

/** Parse the in-container audit log (one JSON object per line; malformed lines are reported, not fatal). */
export function parseBinAuditLog(text: string): { invocations: import('./types.js').BinInvocation[]; malformed: number } {
  const invocations: import('./types.js').BinInvocation[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      invocations.push({
        ts: new Date(Number(o.ts)).toISOString(),
        script: String(o.script),
        args: Array.isArray(o.args) ? o.args.map(String) : [],
        exitCode: Number(o.exitCode),
        durationMs: Number(o.durationMs),
        changedFiles: Array.isArray(o.changedFiles) ? o.changedFiles.map(String) : [],
      });
    } catch {
      malformed++;
    }
  }
  return { invocations, malformed };
}

/**
 * Hook runs per hook name ("<event>:<matcher>") from stream-json events (needs --include-hook-events, which emits
 * system events with subtype hook_started / hook_progress / hook_response). Counts completed runs.
 */
export function hookEventCounts(events: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e?.type !== 'system' || e.subtype !== 'hook_response') continue;
    // hook_name is "<event>:<matcher>" (e.g. "PostToolUse:Bash").
    const key = String(e.hook_name ?? `${e.hook_event ?? '?'}:?`);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Read and parse the bin audit log from the container (before it is destroyed). */
export async function readBinAuditLog(sandbox: ClaudeSandbox, cfg: AgentConfig): Promise<{ invocations: import('./types.js').BinInvocation[]; malformedLogLines: number; logMissing: boolean }> {
  if (!cfg.bin?.length || !sandbox.exec) return { invocations: [], malformedLogLines: 0, logMissing: false };
  const r = await sandbox.exec(`cat ${FRUGAL_AUDIT_LOG} 2>/dev/null | head -c 2000000`, { user: 'root', timeoutSec: 30 });
  const text = r.stdout ?? '';
  const { invocations, malformed } = parseBinAuditLog(text);
  return { invocations, malformedLogLines: malformed, logMissing: !text.trim() };
}

/** Env for the in-container claude process. */
/**
 * `basePath`: the image's own PATH (non-todo task images put tools such as /opt/frugal/task on it); bin scripts
 * are prepended to it. Default CONTAINER_PATH (todo, unchanged).
 */
export function buildClaudeEnv(cfg: AgentConfig, gatewayUrl: string, basePath: string = CONTAINER_PATH): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.thinkingBudget !== undefined) env.MAX_THINKING_TOKENS = String(cfg.thinkingBudget);
  if (cfg.maxOutputTokensPerCall > 0) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(cfg.maxOutputTokensPerCall);
  Object.assign(env, cfg.claudeCode?.env ?? {});
  return {
    ...env,
    ...CLAUDE_BASE_ENV,
    ...(cfg.bin?.length ? { PATH: `${FRUGAL_BIN_DIR}:${basePath}` } : {}),
    HOME: CONTAINER_HOME,
    CLAUDE_CONFIG_DIR: CONTAINER_CONFIG_DIR,
    ANTHROPIC_BASE_URL: gatewayUrl,
    CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_OAUTH_TOKEN,
  };
}

/** Minimal sandbox surface needed by runClaudeCodeInSandbox (DockerSandbox implements it). */
export interface ClaudeSandbox {
  readonly containerId: string;
  writeFileBuffer(path: string, content: Buffer, opts?: { user?: string }): Promise<void>;
  /** Needed for bin scripts (install as root) and the post-run audit. */
  exec?(command: string, opts?: { timeoutSec?: number; user?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface SandboxRunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the run was stopped because of a gateway limit or usage limit. */
  stoppedBy?: 'gateway_limit' | 'usage_limit';
  /** Reset time from a stream `rate_limit_event` with status 'rejected' (backup to the gateway's 429 detection). */
  streamUsageLimitResetAt?: string;
  result: any | null;
  events: any[];
  stderr: string;
}

/**
 * Run `claude -p` inside the coding container (cwd /workspace, user node), streaming stdout to
 * `streamFile`. The prompt goes over stdin. maxRuntimeSec is enforced in the container with
 * `timeout` (whole process group) plus a host backstop. Abort, gateway limits and usage limits kill
 * the in-container process group. Never throws for process failures.
 */
export async function runClaudeCodeInSandbox(opts: {
  sandbox: ClaudeSandbox;
  config: AgentConfig;
  prompt: string;
  gateway: GatewayHandle;
  /** URL of the gateway as seen from inside the container (forwarder). */
  gatewayUrl: string;
  timeoutSec: number;
  streamFile: string;
  signal?: AbortSignal;
  /** Called with each stream event as it arrives. */
  onEvent?: (e: any) => void;
  /** /opt/frugal layout (must match the mounts from optTmpfsMounts). Default 'single' (todo). */
  optLayout?: OptLayout;
  /** The image's PATH (non-todo tasks); bin scripts are prepended to it. Default CONTAINER_PATH. */
  basePath?: string;
}): Promise<SandboxRunResult> {
  const { sandbox, config } = opts;
  for (const f of claudeHomeFiles(config)) await sandbox.writeFileBuffer(f.path, Buffer.from(f.content, 'utf8'), { user: 'node' });
  await installDocs(sandbox, config, opts.optLayout);
  await installBinScripts(sandbox, config, opts.optLayout);
  const env = buildClaudeEnv(config, opts.gatewayUrl, opts.basePath);
  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--strict-mcp-config',
    ...buildClaudeArgs(config),
  ];
  const t = Math.max(10, Math.round(opts.timeoutSec));
  const dockerArgs = ['exec', '-i', '-u', 'node', '-w', '/workspace'];
  for (const [k, v] of Object.entries(env)) dockerArgs.push('-e', `${k}=${v}`);
  // `exec timeout` keeps the pid == process group id, so the whole tree can be signalled later.
  dockerArgs.push(sandbox.containerId, 'sh', '-c', 'echo $$ > /tmp/.claude.pid; exec timeout -k 10 "$0" claude "$@"', `${t}s`, ...claudeArgs);

  mkdirSync(dirname(opts.streamFile), { recursive: true });
  const out = createWriteStream(opts.streamFile);
  let stoppedBy: SandboxRunResult['stoppedBy'];
  let streamUsageLimitResetAt: string | undefined;
  const collector = new StreamJsonCollector((e) => {
    const ul = streamUsageLimit(e);
    if (ul && !streamUsageLimitResetAt) {
      streamUsageLimitResetAt = ul;
      log.warn('stream reports a rejected subscription rate limit', { resetAt: ul });
    }
    opts.onEvent?.(e);
  });
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  const start = Date.now();

  const killInContainer = async (sig: 'TERM' | 'KILL') => {
    await new Promise<void>((resolve) => {
      const k = spawn('docker', ['exec', '-u', 'node', sandbox.containerId, 'sh', '-c', `p=$(cat /tmp/.claude.pid 2>/dev/null) && kill -${sig} -- -$p 2>/dev/null; true`], { stdio: 'ignore' });
      k.on('close', () => resolve());
      k.on('error', () => resolve());
      setTimeout(resolve, 15_000).unref();
    });
  };

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stopping = false;
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      log.info('stopping in-container claude', { why });
      void killInContainer('TERM').then(() =>
        setTimeout(() => {
          void killInContainer('KILL');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, 5000).unref(),
      );
    };
    const poll = setInterval(() => {
      if (!stoppedBy && (opts.gateway.usageLimitResetAt() || streamUsageLimitResetAt)) {
        stoppedBy = 'usage_limit';
        stop('subscription usage limit');
      } else if (!stoppedBy && opts.gateway.limitExceeded?.()) {
        stoppedBy = 'gateway_limit';
        stop('gateway limit');
      }
      if (Date.now() - start > (t + 30) * 1000) {
        timedOut = true;
        stop('host backstop timeout');
      }
    }, 1000);
    const onAbort = () => {
      aborted = true;
      stop('abort signal');
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      out.write(c);
      collector.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 50_000) stderr += c.toString('utf8');
    });
    child.on('error', (e) => (stderr += String(e)));
    child.on('close', (code) => {
      clearInterval(poll);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(code);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.prompt);
  });
  collector.end();
  await new Promise<void>((r) => out.end(() => r()));
  // `timeout` exits 124 when it had to stop the command.
  if (exitCode === 124 || (exitCode === 137 && Date.now() - start >= t * 1000 - 500)) timedOut = true;
  return { exitCode, timedOut, aborted, stoppedBy, streamUsageLimitResetAt, result: collector.result(), events: collector.events, stderr };
}
