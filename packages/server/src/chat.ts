/**
 * The page chat's backend, the same design as CV Hub's chat pane. There is one continuous Claude Code
 * session per session page (plus "general" when none is open). Each message runs `claude -p`: the first
 * creates the session with --session-id and the page's context in its system prompt (context.ts), later
 * ones use --resume. Every message is prefixed with what the user is looking at (tab and selection). A
 * chat can be continued in the terminal with `claude --resume <id>`.
 *
 * The chat is read-only: it can read files and run `sqlite3` against the telemetry store, nothing else.
 *
 *   GET  /api/chat?session=<id>        {sessionId, messages, busy}
 *   POST /api/chat?session=<id>        {message, view} → NDJSON stream: {type: text|tool|error|done}
 *   POST /api/chat/stop?session=<id>   stop the running reply
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { markBusy, markIdle } from './activity.js';
import { json, readBody, runClaude } from './claude.js';
import { loadChat, saveChat, type ChatMessage, type ChatState } from './chats.js';
import { chatContext } from './context.js';
import { TELEMETRY_DB_PATH, TelemetryDb } from './store.js';

const GENERAL = 'general';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The view note sent with each message is cut to this length. */
const MAX_VIEW = 12_000;

const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export function createChat(root: string) {
  const running = new Map<string, ChildProcess>();

  const load = (key: string): ChatState => {
    const s = loadChat(key);
    if (s) return s;
    const fresh: ChatState = { sessionId: randomUUID(), started: false, messages: [] };
    saveChat(key, fresh);
    return fresh;
  };

  async function send(key: string, req: IncomingMessage, res: ServerResponse) {
    if (running.has(key)) return json(res, 409, { error: 'Claude is still answering the last message.' });
    const body = await readBody(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return json(res, 400, { error: 'Empty message' });
    const view = typeof body.view === 'string' ? body.view.slice(0, MAX_VIEW) : '';

    const state = load(key);
    const prompt = view ? `[In Agent Book the user is looking at:\n${view}]\n\n${message}` : message;

    // Built only for the first message: the session keeps it from then on.
    let sessionArgs: string[];
    if (state.started) sessionArgs = ['--resume', state.sessionId];
    else {
      const db = TelemetryDb.openReadonly();
      if (!db) return json(res, 503, { error: 'Nothing has been collected yet.' });
      let ctx: ReturnType<typeof chatContext>;
      try {
        ctx = chatContext(db, key === GENERAL ? null : key);
      } finally {
        db.close();
      }
      const dirs = [dirname(TELEMETRY_DB_PATH()), join(homedir(), '.claude', 'projects'), ctx.folder ? expand(ctx.folder) : null].filter((d): d is string => !!d && existsSync(d));
      sessionArgs = ['--session-id', state.sessionId, '--name', `Agent Book - ${ctx.name}`, '--append-system-prompt', ctx.prompt, ...dirs.flatMap((d) => ['--add-dir', d])];
    }
    const args = [
      // Explicit, so a user-wide default (auto, acceptEdits) doesn't apply to the chat.
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read,Grep,Glob,Bash(sqlite3:*)',
      '--disallowedTools',
      'Edit,Write,MultiEdit,NotebookEdit',
      ...sessionArgs,
    ];

    const reply: ChatMessage = { role: 'assistant', parts: [] };
    state.messages.push({ role: 'user', parts: [{ kind: 'text', text: message }], view });
    saveChat(key, state);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const emit = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };

    const { proc, done } = runClaude(root, args, prompt, {
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
    running.set(key, proc);
    markBusy(`chat:${key}`);

    const { error } = await done;
    running.delete(key);
    markIdle(`chat:${key}`);
    const latest = load(key);
    // Only mark the session started once Claude has actually created it.
    if (!error || reply.parts.length > 0) latest.started = true;
    if (error) reply.parts.push({ kind: 'tool', label: `Error: ${error}` });
    if (reply.parts.length > 0) latest.messages.push(reply);
    saveChat(key, latest);
    emit(error ? { type: 'error', message: error } : { type: 'done' });
    res.end();
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = url.searchParams.get('session') ?? GENERAL;
    try {
      if (key !== GENERAL && !SESSION_ID.test(key)) return json(res, 400, { error: 'Bad session id' });
      if (req.method === 'GET' && url.pathname === '/') {
        const state = loadChat(key);
        return json(res, 200, { sessionId: state?.sessionId ?? null, messages: state?.messages ?? [], busy: running.has(key) });
      }
      if (req.method === 'POST' && url.pathname === '/') return await send(key, req, res);
      if (req.method === 'POST' && url.pathname === '/stop') {
        running.get(key)?.kill('SIGINT');
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : 'Chat failed' });
    }
  };
}
