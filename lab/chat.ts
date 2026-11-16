/**
 * Chat pane backend: one continuous Claude Code session per page of the lab UI (the sessions list, the
 * repo page, a session, a suggestion), run on the host as the user (their normal `claude` login),
 * read-only over the repo, the run artifacts and the lab DB.
 *
 * Each message runs `claude -p`; the first creates the session with --session-id, later ones --resume.
 * The page's context is captured on the first message and appended to the system prompt of every call
 * (`-p` does not persist an appended system prompt across --resume). Continue it in a terminal with
 * `claude --resume <id>`.
 *
 * Isolation: never through the benchmark gateway (ANTHROPIC_BASE_URL and FRUGAL_* removed), never
 * recorded in the lab DB, the user's own settings ignored (--setting-sources ""), and only Read, Grep,
 * Glob and `sqlite3 -safe -readonly results/lab.db` allowed. Requests must come from the page itself
 * on a loopback address. State: results/lab/chats/<key>.json (git-ignored).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { LabDb, RunRow } from './db.js';
import { getRepo } from './repos.js';

export interface ChatPart {
  kind: 'text' | 'tool';
  text?: string;
  label?: string;
}
export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
}
interface ChatState {
  sessionId: string;
  started: boolean;
  context?: string;
  messages: ChatMessage[];
}

export const CHAT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
export const CHAT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(sqlite3 -safe -readonly results/lab.db:*)'];
export const CHAT_DENIED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read(./.env)', 'Read(./.env.*)', 'Read(**/.env)', 'Read(**/.env.*)'];
const MAX_MESSAGE_CHARS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;

export const CHAT_SYSTEM_PROMPT = `You are chatting from a pane in the frugal lab UI, next to the page the user is looking at.
The lab improves a repository's skill files (instructions, playbooks, principles) with evidence: a session runs a coding agent (Claude Code in a Docker sandbox) with the current skills on a suite of tasks, grades each run against acceptance criteria (partial credit), an analyst proposes edits to the skill files (suggestions), and the top suggestions are tested with paired runs (same task and seed as a session run). A human accepts or rejects them. docs/LAB.md explains it.
Where things are (paths relative to the repo root, your working directory):
- results/lab.db: SQLite. Query it read-only with exactly this prefix: sqlite3 -safe -readonly results/lab.db "<SQL>". Tables: repos, profiles (repo profile JSON), tasks, sessions, suggestions (diff, evidence), runs (session_id, suggestion_id, task_id, pair_key, tokens, cost_usd, duration_ms, criteria_met, criteria_detail JSON, skills_fired, error).
- results/runs/<runId>/: profile.md (token profile and waste signals: read this first), trace.jsonl (every model and tool call), claude-stream.jsonl, workspace.patch (the agent's change), eval/dev/report.json (the hidden evaluator's checks).
- results/lab/analysis/<sessionId>/: the analyst's raw suggestions and stream.
- lab/repos.ts: tasks and how each acceptance criterion maps to evaluator checks. results/lab/cache/repos/<repo>/: the repo with its skill files.
You can only read: Read, Grep, Glob, and the sqlite3 command above. You cannot edit files or run anything else; if the user wants a change, describe it precisely (file and content).
Be concrete and quantitative: cite run ids, token counts, criteria and call numbers. Say when a difference is within noise (few paired runs). Keep replies short; the pane is small.`;

const fmtK = (n: number) => `${Math.round(n / 1000)}k`;

function runLine(r: RunRow, total: number): string {
  const missed = Object.entries(r.criteriaDetail)
    .filter(([, d]) => !d.met)
    .map(([id, d]) => `${id} (${d.checks.filter((c) => c.outcome !== 'pass').map((c) => `${c.id}: ${(c.message ?? c.outcome).slice(0, 80)}`).join('; ')})`)
    .join(' · ')
    .replace(/\|/g, '/');
  return `| ${r.id} | ${r.taskId} | ${r.pairKey} | ${r.status} | ${r.status === 'done' ? `${r.criteriaMet.length}/${total}` : '—'} | ${fmtK(r.tokens)} | ${Math.round(r.durationMs / 1000)}s | ${r.skillsFired === null ? '?' : r.skillsFired ? 'yes' : 'no'} | ${missed || r.error || ''} |`;
}

const RUN_HEAD = ['| run | task | pair key | status | criteria | tokens | time | used skills | missed criteria / error |', '|---|---|---|---|---|---|---|---|---|'];

/** Context for a page key: 'sessions', 'repo', '<sessionId>', '<suggestionId>'. Null when unknown. */
export function pageContext(db: LabDb, repoId: string, key: string): { title: string; text: string } | null {
  const repo = getRepo(repoId);
  const total = (taskId: string) => repo.tasks.find((t) => t.id === taskId)?.criteria.length ?? 0;
  if (key === 'sessions') {
    const lines = [`This chat is about the sessions list of repo ${repoId}.`, '', '| session | status | skills | runs done | avg tokens | criteria met | suggestions |', '|---|---|---|---|---|---|---|'];
    for (const s of db.listSessions(repoId)) {
      const runs = db.sessionRuns(s.id).filter((r) => r.status === 'done');
      const met = runs.reduce((n, r) => n + r.criteriaMet.length, 0);
      const tot = runs.reduce((n, r) => n + total(r.taskId), 0);
      const avg = runs.length ? fmtK(runs.reduce((n, r) => n + r.tokens, 0) / runs.length) : '—';
      const sug = db.listSuggestions(s.id).map((g) => `${g.id} ${g.status}`).join(', ');
      lines.push(`| ${s.id} | ${s.status} | ${s.skillsVersion} | ${runs.length} | ${avg} | ${tot ? `${met}/${tot}` : '—'} | ${sug} |`);
    }
    return { title: 'the sessions', text: lines.join('\n') };
  }
  if (key === 'repo') {
    const p = db.latestProfile(repoId);
    const lines = [`This chat is about the repo page of ${repoId} (${repo.skills.url} @ ${repo.skills.commit.slice(0, 7)}): setup, skill activation and the task suite.`];
    if (p) lines.push('', `Latest repo profile (v${p.version}, ${p.evaluatedAt}):`, '```json', JSON.stringify({ setup: p.setup, commands: p.commands, activation: p.activation, surfaces: p.surfaces, conflicts: p.conflicts }, null, 1).slice(0, 12_000), '```');
    else lines.push('', 'Setup has not run yet.');
    lines.push('', 'Tasks:', ...db.listTasks(repoId).map((t) => `- ${t.id} (${t.kind}${t.heldOut ? ', held out' : ''}${t.approved ? ', approved' : ''}): ${t.title}; criteria: ${t.criteria.map((c) => c.id).join(', ')}`));
    return { title: 'the repo', text: lines.join('\n') };
  }
  const s = db.getSession(key);
  if (s) {
    const lines = [`This chat is about session ${s.id} (status ${s.status}, skills ${s.skillsVersion}, profile v${s.profileVersion}).`, '', 'Session runs (the current skills):', ...RUN_HEAD];
    for (const r of db.sessionRuns(s.id)) lines.push(runLine(r, total(r.taskId)));
    lines.push('', 'Suggestions (rank order):');
    for (const g of db.listSuggestions(s.id)) {
      const runs = db.suggestionRuns(g.id).filter((r) => r.status === 'done');
      const avg = runs.length ? fmtK(runs.reduce((n, r) => n + r.tokens, 0) / runs.length) : '—';
      lines.push(`- ${g.id} [${g.status}] ${g.title}: ${runs.length} runs, avg ${avg} tokens, criteria ${runs.reduce((n, r) => n + r.criteriaMet.length, 0)}/${runs.reduce((n, r) => n + total(r.taskId), 0)}. ${g.description}`);
    }
    return { title: s.id, text: lines.join('\n') };
  }
  const g = db.getSuggestion(key);
  if (g) {
    const lines = [
      `This chat is about suggestion ${g.id} (status ${g.status}, rank ${g.rank}) from session ${g.sessionId}: "${g.title}".`,
      '',
      g.description,
      '',
      '<evidence>',
      g.evidence,
      '</evidence>',
      '',
      '<diff>',
      g.diff.trim().slice(0, 10_000),
      '</diff>',
      '',
      'Its runs (paired with the session runs of the same pair key):',
      ...RUN_HEAD,
      ...db.suggestionRuns(g.id).map((r) => runLine(r, total(r.taskId))),
      '',
      'The session runs they are compared with:',
      ...RUN_HEAD,
      ...db.sessionRuns(g.sessionId).map((r) => runLine(r, total(r.taskId))),
    ];
    return { title: g.id, text: lines.join('\n') };
  }
  return null;
}

type RunHandlers = { onText?: (text: string, newBlock: boolean) => void; onTool?: (label: string) => void };
type RunResult = { error: string | null; stopped: boolean };
export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

/** Run `claude -p` and turn its stream-json output into text deltas and one-line tool labels. */
function runClaude(spawnFn: SpawnFn, bin: string, cwd: string, args: string[], prompt: string, handlers: RunHandlers): { proc: ChildProcess; done: Promise<RunResult> } {
  const env = { ...process.env };
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

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** Requests that can start Claude must come from the page itself on a loopback host, as JSON. */
export function requestAllowed(req: http.IncomingMessage): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOOPBACK_HOSTS.has(hostname) && !hostname.startsWith('127.')) return 'chat is only available on a loopback address';
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return 'cross-origin chat requests are refused';
  if (req.method === 'POST' && !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return 'chat requests must be application/json';
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
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

export interface ChatOptions {
  db: LabDb;
  repoId: string;
  repoRoot: string;
  stateDir: string;
  enabled: boolean;
  claudeBin?: string;
  spawnFn?: SpawnFn;
}

export function createChatHandler(opts: ChatOptions) {
  const spawnFn: SpawnFn = opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'] }));
  const bin = opts.claudeBin ?? process.env.FRUGAL_CHAT_CLAUDE_BIN ?? 'claude';
  const running = new Map<string, ChildProcess>();
  const file = (key: string) => path.join(opts.stateDir, `${key}.json`);
  const save = (key: string, s: ChatState) => {
    fs.mkdirSync(opts.stateDir, { recursive: true });
    fs.writeFileSync(file(key), JSON.stringify(s, null, 2));
  };
  const load = (key: string): ChatState => {
    try {
      return JSON.parse(fs.readFileSync(file(key), 'utf8')) as ChatState;
    } catch {
      return { sessionId: randomUUID(), started: false, messages: [] };
    }
  };

  async function send(key: string, ctx: { title: string; text: string }, req: http.IncomingMessage, res: http.ServerResponse) {
    if (running.has(key)) return sendJson(res, 409, { error: 'Claude is still answering the last message.' });
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return sendJson(res, 400, { error: 'Empty message' });
    if (message.length > MAX_MESSAGE_CHARS) return sendJson(res, 400, { error: 'Message too long' });
    const state = load(key);
    state.context ??= `${ctx.text}\n\nAll of this is a snapshot from when the chat started; runs may have finished since. Re-read the DB or files before relying on numbers.`;
    const args = [
      '--setting-sources', '',
      '--permission-mode', 'default',
      '--tools', CHAT_TOOLS.join(','),
      '--allowedTools', CHAT_ALLOWED_TOOLS.join(','),
      '--disallowedTools', CHAT_DENIED_TOOLS.join(','),
      '--append-system-prompt', `${CHAT_SYSTEM_PROMPT}\n\n${state.context}`,
      ...(state.started ? ['--resume', state.sessionId] : ['--session-id', state.sessionId, '--name', `frugal lab - ${key}`]),
    ];
    const reply: ChatMessage = { role: 'assistant', parts: [] };
    state.messages.push({ role: 'user', parts: [{ kind: 'text', text: message }] });
    save(key, state);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const emit = (ev: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    const { proc, done } = runClaude(spawnFn, bin, opts.repoRoot, args, message, {
      onText(text, newBlock) {
        const last = reply.parts.at(-1);
        if (newBlock && last?.kind === 'text' && last.text) text = `\n\n${text}`;
        if (last?.kind === 'text') last.text = (last.text ?? '') + text;
        else reply.parts.push({ kind: 'text', text });
        emit({ type: 'text', text });
      },
      onTool(label) {
        reply.parts.push({ kind: 'tool', label });
        emit({ type: 'tool', label });
      },
    });
    running.set(key, proc);
    const { error } = await done;
    running.delete(key);
    const latest = load(key);
    if (!error || reply.parts.length > 0) latest.started = true;
    if (error) reply.parts.push({ kind: 'tool', label: `Error: ${error}` });
    if (reply.parts.length > 0) latest.messages.push(reply);
    save(key, latest);
    emit(error ? { type: 'error', message: error } : { type: 'done' });
    res.end();
  }

  /** /api/chat/<key>[/stop]: GET history, POST a message (streams ndjson), POST stop. */
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, seg: string[]): Promise<void> {
    const key = seg[0] ?? '';
    if (!KEY_RE.test(key) || seg.length > 2 || (seg.length === 2 && seg[1] !== 'stop')) return sendJson(res, 404, { error: 'Unknown chat endpoint' });
    const ctx = pageContext(opts.db, opts.repoId, key);
    if (!ctx) {
      req.resume();
      return sendJson(res, 404, { error: `Nothing to chat about: ${key}` });
    }
    if (req.method === 'GET' && seg.length === 1) {
      req.resume();
      const s = load(key);
      return sendJson(res, 200, { enabled: opts.enabled, sessionId: s.sessionId, started: s.started, messages: s.messages, busy: running.has(key), title: ctx.title });
    }
    if (req.method !== 'POST') {
      req.resume();
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    if (!opts.enabled) {
      req.resume();
      return sendJson(res, 403, { error: 'Chat is disabled: the lab server is not bound to a loopback address.' });
    }
    const refused = requestAllowed(req);
    if (refused) {
      req.resume();
      return sendJson(res, 403, { error: refused });
    }
    if (seg.length === 2) {
      req.resume();
      running.get(key)?.kill('SIGINT');
      return sendJson(res, 200, { ok: true });
    }
    return send(key, ctx, req, res);
  };
}
