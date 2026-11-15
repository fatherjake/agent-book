/**
 * Chat pane backend: one continuous Claude Code session per experiment, run on the host as the
 * user (their normal `claude` login), read-only over the repo and the results DB.
 *
 * Each message runs `claude -p`. The first one creates the session with --session-id; later ones
 * use --resume. The experiment's context is captured on the first message and appended to the
 * system prompt of every call, so it stays as it was when the chat started (the prompt tells
 * Claude to re-read before relying on it). A
 * session can be continued in a terminal with `claude --resume <id>`.
 *
 * Isolation from the benchmark: the chat never goes through the benchmark gateway (any
 * ANTHROPIC_BASE_URL is removed from its env) and is never recorded in the results DB, so
 * chatting costs nothing in the measurements.
 *
 * State lives in results/chats/<experimentId>.json (git-ignored, like the rest of results/).
 * Pattern adapted from cv-hub's server/chat.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { ChatInfo, ChatMessage, ExperimentDetail, RunDetail } from '../src/api-types.js';
import type { DashboardData } from './data.js';

interface ChatState {
  sessionId: string;
  started: boolean;
  /** Experiment context captured on the first message and re-sent with every one (`-p` does not
   *  persist an appended system prompt across --resume), so the session's context never shifts. */
  context?: string;
  messages: ChatMessage[];
}

/** Tools the chat can use: read-only over the repo, plus read-only sqlite3 on the results DB. */
export const CHAT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
export const CHAT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(sqlite3 -safe -readonly results/benchmark.db:*)'];
/** Never: writes, the web, or the secrets in .env (the benchmark's subscription token lives there). */
export const CHAT_DENIED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read(./.env)', 'Read(./.env.*)', 'Read(**/.env)', 'Read(**/.env.*)'];
const MAX_MESSAGE_CHARS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;
const PROFILE_MAX_CHARS = 12_000;

export const CHAT_SYSTEM_PROMPT = `You are chatting from a pane in the frugal dashboard, next to one experiment of a token-efficiency benchmark.
The benchmark measures how many tokens a coding agent (Claude Code in a Docker sandbox) needs to implement a task; a research loop proposes config changes (system prompt, tools, skills, limits) as experiments. Each experiment gets 1 quick run, then 5 verification runs if the quick run beat the best; the verified median tokens and pass rate decide promotion, and a holdout run on another task guards against overfitting. docs/ARCHITECTURE.md, docs/TASKS.md and README.md explain the system.
Where things are (paths relative to the repo root, your working directory):
- results/benchmark.db: the append-only SQLite results DB. Query it read-only with: sqlite3 -safe -readonly results/benchmark.db "<SQL>" (exactly that prefix; -safe blocks .shell/.output; tables runs, evaluations, experiments, usage_records, ...; .schema shows them).
- results/runs/<runId>/: per run, profile.md (token profile and waste signals: read this first), trace.jsonl (every model and tool call, with tool durations), claude-stream.jsonl (raw Claude Code stream), usage.jsonl, workspace.patch (the agent's code change), eval/ (the hidden evaluator's report).
- configs/<configId>/: the config itself (config.json, system-prompt.md, skills/).
You can only read: Read, Grep, Glob, and sqlite3 -safe -readonly on results/benchmark.db. You cannot edit files or run anything else; if the user wants a change, describe it precisely (file and content) so they can apply it.
Be concrete and quantitative: cite run ids, token counts and call numbers. Keep replies short; the pane is small.`;

/** The experiment's context, as it is when the chat starts. Exported for tests. */
export function experimentContext(d: ExperimentDetail, runDetail: (id: string) => RunDetail | null, repoRoot: string): string {
  const e = d.experiment;
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-GB'));
  const min = (ms: number | null) => (ms === null ? '—' : `${(ms / 60_000).toFixed(1)} min`);
  const lines: string[] = [
    `This chat is about experiment ${e.id} (task ${e.taskId}, kind ${e.kind}, status ${e.status}, outcome ${e.outcome ?? 'none yet'}).`,
    `Config ${e.configId}${e.parentConfigId ? `, child of ${e.parentConfigId}` : ''}; model ${e.model} (${e.provider}).`,
    `Pass rate ${e.passRate === null ? '—' : `${Math.round(e.passRate * 100)}%`} (${e.passes}/${e.runs}), median tokens ${fmt(e.medianTokens)}${
      e.improvementVsBestPct === null ? '' : ` (${e.improvementVsBestPct.toFixed(1)}% vs the current best of its task)`
    }.`,
  ];
  if (e.cheating) lines.push(`FLAGGED AS CHEATING by a human: ${e.cheating.reason}${e.cheating.inheritedFrom ? ` (inherited from ${e.cheating.inheritedFrom})` : ''}.`);
  lines.push('', '<hypothesis>', e.hypothesis.trim(), '</hypothesis>');
  if (e.changeSummary) lines.push('', `Change summary: ${e.changeSummary}`);
  if (e.error) lines.push('', `Error: ${e.error}`);
  if (d.configDiff) lines.push('', '<config-diff>', d.configDiff.trim(), '</config-diff>');

  lines.push('', 'Runs (phase is in the DB: quick / verify / holdout):');
  lines.push('| run | status | passed | tokens | tool calls | coding | failure / failed mandatory checks |', '|---|---|---|---|---|---|---|');
  let medianRun: { id: string; tokens: number } | null = null;
  const passedRuns = d.runs.filter((r) => r.passed && r.totalTokens).sort((a, b) => a.totalTokens! - b.totalTokens!);
  if (passedRuns.length) {
    const m = passedRuns[Math.floor((passedRuns.length - 1) / 2)];
    medianRun = { id: m.id, tokens: m.totalTokens! };
  }
  for (const r of d.runs) {
    const detail = runDetail(r.id);
    const failed = (detail?.evaluations ?? [])
      .flatMap((ev) => ev.checks.filter((c) => c.mandatory && c.outcome !== 'pass').map((c) => `${c.id}${c.message ? `: ${c.message.slice(0, 120)}` : ''}`))
      .slice(0, 6);
    const why = [r.failureReason, ...failed].filter(Boolean).join('; ').replace(/\|/g, '/').replace(/\s+/g, ' ');
    lines.push(`| ${r.id} | ${r.status} | ${r.passed === null ? '—' : r.passed ? 'yes' : 'no'} | ${fmt(r.totalTokens)} | ${r.toolCalls ?? '—'} | ${min(r.codingMs)} | ${why || ''} |`);
  }

  if (medianRun) {
    const profile = path.join(repoRoot, 'results', 'runs', medianRun.id, 'profile.md');
    try {
      let text = fs.readFileSync(profile, 'utf8').trim();
      if (text.length > PROFILE_MAX_CHARS) text = `${text.slice(0, PROFILE_MAX_CHARS)}\n… (truncated; read the file for the rest)`;
      lines.push('', `Token profile of the median passing run ${medianRun.id} (${fmt(medianRun.tokens)} tokens), from results/runs/${medianRun.id}/profile.md:`, '<profile>', text, '</profile>');
    } catch {
      /* no profile on disk */
    }
  }
  lines.push('', 'All of this is a snapshot from when the chat started; runs may have finished since. Re-read the DB or files before relying on numbers.');
  return lines.join('\n');
}

type RunHandlers = { onText?: (text: string, newBlock: boolean) => void; onTool?: (label: string) => void };
type RunResult = { error: string | null; stopped: boolean };

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

/** Run `claude -p` and turn its stream-json output into text deltas and one-line tool labels. */
function runClaude(spawnFn: SpawnFn, bin: string, cwd: string, args: string[], prompt: string, handlers: RunHandlers): { proc: ChildProcess; done: Promise<RunResult> } {
  const env = { ...process.env };
  // Never route the chat through the benchmark gateway, and never use benchmark-only settings.
  delete env.ANTHROPIC_BASE_URL;
  for (const k of Object.keys(env)) if (k.startsWith('FRUGAL_')) delete env[k];
  const proc = spawnFn(bin, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...args], { cwd, env });
  proc.stdin?.end(prompt);

  let buffer = '';
  let stderr = '';
  let resultError: string | null = null;
  let freshBlock = true;
  const toolLabel = (name: string, input: Record<string, unknown>) => {
    const target = input.file_path ?? input.path ?? input.command ?? input.pattern;
    if (typeof target !== 'string') return name;
    const shown = target.startsWith(cwd) ? path.relative(cwd, target) : target;
    return `${name} ${shown.length > 100 ? `${shown.slice(0, 97)}…` : shown}`;
  };
  const handle = (line: string) => {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'stream_event' && !event.parent_tool_use_id) {
      const inner = event.event;
      if (inner?.type === 'content_block_start' && inner.content_block?.type === 'text') freshBlock = true;
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        handlers.onText?.(inner.delta.text, freshBlock);
        freshBlock = false;
      }
    } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        handlers.onTool?.(toolLabel(block.name, block.input ?? {}));
        freshBlock = true;
      }
    } else if (event.type === 'result' && event.is_error) {
      resultError = (typeof event.result === 'string' && event.result) || 'Claude reported an error';
    }
  };
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<RunResult>((resolve) => {
    proc.on('error', (err) => resolve({ error: `Could not start claude: ${err.message}`, stopped: false }));
    proc.on('close', (code, signal) => {
      if (buffer.trim()) handle(buffer);
      if (signal) return resolve({ error: null, stopped: true });
      if (resultError) return resolve({ error: resultError, stopped: false });
      if (code !== 0) return resolve({ error: stderr.trim().split('\n').filter(Boolean).at(-1) ?? `claude exited with code ${code}`, stopped: false });
      resolve({ error: null, stopped: false });
    });
  });
  return { proc, done };
}

export interface ChatOptions {
  data: DashboardData;
  repoRoot: string;
  /** Where chat state is kept (results/chats). */
  stateDir: string;
  /** Chat only works when the server listens on loopback; otherwise every chat request is refused. */
  enabled: boolean;
  claudeBin?: string;
  spawnFn?: SpawnFn;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True when the address the server binds to is loopback-only. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

/**
 * Requests that can start Claude must come from the dashboard page itself: Host must be a loopback
 * name (blocks DNS rebinding), a present Origin must be that same origin, and POSTs must be JSON
 * (a cross-site form or no-cors fetch can't send application/json without a CORS preflight, which
 * this server never grants).
 */
export function requestAllowed(req: http.IncomingMessage): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOOPBACK_HOSTS.has(hostname) && !hostname.startsWith('127.')) return 'chat is only available on a loopback address';
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return 'cross-origin chat requests are refused';
  if (req.method === 'POST' && !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return 'chat requests must be application/json';
  return null;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error('request body too large');
  }
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function createChatHandler(opts: ChatOptions) {
  const { data, repoRoot, stateDir } = opts;
  const spawnFn: SpawnFn = opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'] }));
  const bin = opts.claudeBin ?? process.env.FRUGAL_CHAT_CLAUDE_BIN ?? 'claude';
  const running = new Map<string, ChildProcess>();

  const file = (id: string) => path.join(stateDir, `${id}.json`);
  const save = (id: string, s: ChatState) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file(id), JSON.stringify(s, null, 2));
  };
  const load = (id: string): ChatState => {
    try {
      return JSON.parse(fs.readFileSync(file(id), 'utf8')) as ChatState;
    } catch {
      return { sessionId: randomUUID(), started: false, messages: [] };
    }
  };
  const info = (id: string): ChatInfo => {
    const s = load(id);
    return { enabled: opts.enabled, sessionId: s.sessionId, started: s.started, messages: s.messages, busy: running.has(id) };
  };

  async function send(id: string, detail: ExperimentDetail, req: http.IncomingMessage, res: http.ServerResponse) {
    if (running.has(id)) return sendJson(res, 409, { error: 'Claude is still answering the last message.' });
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return sendJson(res, 400, { error: 'Empty message' });
    if (message.length > MAX_MESSAGE_CHARS) return sendJson(res, 400, { error: 'Message too long' });

    const state = load(id);
    state.context ??= experimentContext(detail, (rid) => data.run(rid), repoRoot);
    const args = [
      // The user's own settings may auto-approve tools (defaultMode "auto", broad Bash allows);
      // ignore them and use plain permission checks, so anything outside the allowlist is denied
      // (in -p mode there is nobody to ask). Same isolation as the benchmark runner.
      '--setting-sources', '',
      '--permission-mode', 'default',
      '--tools', CHAT_TOOLS.join(','),
      '--allowedTools', CHAT_ALLOWED_TOOLS.join(','),
      '--disallowedTools', CHAT_DENIED_TOOLS.join(','),
      '--append-system-prompt', `${CHAT_SYSTEM_PROMPT}\n\n${state.context}`,
      ...(state.started ? ['--resume', state.sessionId] : ['--session-id', state.sessionId, '--name', `frugal - ${id}`]),
    ];

    const reply: ChatMessage = { role: 'assistant', parts: [] };
    state.messages.push({ role: 'user', parts: [{ kind: 'text', text: message }] });
    save(id, state);

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const emit = (ev: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    const { proc, done } = runClaude(spawnFn, bin, repoRoot, args, message, {
      onText(text, newBlock) {
        const last = reply.parts.at(-1);
        if (newBlock && last?.kind === 'text' && last.text) text = `\n\n${text}`;
        if (last?.kind === 'text') last.text += text;
        else reply.parts.push({ kind: 'text', text });
        emit({ type: 'text', text });
      },
      onTool(label) {
        reply.parts.push({ kind: 'tool', label });
        emit({ type: 'tool', label });
      },
    });
    running.set(id, proc);
    const { error } = await done;
    running.delete(id);
    const latest = load(id);
    // Only mark the session started once Claude actually created it.
    if (!error || reply.parts.length > 0) latest.started = true;
    if (error) reply.parts.push({ kind: 'tool', label: `Error: ${error}` });
    if (reply.parts.length > 0) latest.messages.push(reply);
    save(id, latest);
    emit(error ? { type: 'error', message: error } : { type: 'done' });
    res.end();
  }

  /** Handles /api/chat/<experimentId>[/stop]. `seg` is the path after /api/chat. */
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, seg: string[]): Promise<void> {
    const id = seg[0] ?? '';
    if (!ID_RE.test(id) || seg.length > 2 || (seg.length === 2 && seg[1] !== 'stop')) return sendJson(res, 404, { error: 'Unknown chat endpoint' });
    const method = req.method ?? 'GET';
    if (method === 'GET' && seg.length === 1) {
      req.resume();
      if (!data.experiment(id)) return sendJson(res, 404, { error: `Experiment not found: ${id}` });
      return sendJson(res, 200, info(id));
    }
    if (method !== 'POST') {
      req.resume();
      res.setHeader('allow', seg.length === 1 ? 'GET, POST' : 'POST');
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    if (!opts.enabled) {
      req.resume();
      return sendJson(res, 403, { error: 'Chat is disabled: the dashboard is not bound to a loopback address.' });
    }
    const refused = requestAllowed(req);
    if (refused) {
      req.resume();
      return sendJson(res, 403, { error: refused });
    }
    if (seg.length === 2) {
      req.resume();
      running.get(id)?.kill('SIGINT');
      return sendJson(res, 200, { ok: true });
    }
    const detail = data.experiment(id);
    if (!detail) {
      req.resume();
      return sendJson(res, 404, { error: `Experiment not found: ${id}` });
    }
    return send(id, detail, req, res);
  };
}

export type ChatHandler = ReturnType<typeof createChatHandler>;
