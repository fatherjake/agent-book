/**
 * Chat pane backend (dashboard/server/chat.ts): request guards, context building, and a full
 * POST round trip against a fake `claude` that emits stream-json. No real Claude is started.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevDb } from '../../dashboard/dev-seed.js';
import { CHAT_ALLOWED_TOOLS, createChatHandler, experimentContext, isLoopback, requestAllowed, type SpawnFn } from '../../dashboard/server/chat.js';
import { createDashboardData, type DashboardData } from '../../dashboard/server/data.js';
import { createDashboardServer } from '../../dashboard/server/http.js';
import type { ChatInfo } from '../../dashboard/src/api-types.js';

let tmp: string;
let data: DashboardData;
let server: http.Server;
let disabledServer: http.Server;
let port: number;
let disabledPort: number;
let expId: string;
const calls: { args: string[]; env: NodeJS.ProcessEnv; stdin: string }[] = [];

/** A fake `claude -p` process: records its args/stdin and replies with one tool call and some text. */
const fakeSpawn: SpawnFn = (_cmd, args, opts) => {
  const proc = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdin = '';
  const stdinStream = new PassThrough();
  stdinStream.on('data', (c) => (stdin += c));
  stdinStream.on('end', () => {
    calls.push({ args, env: opts.env, stdin });
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sqlite3 -readonly results/benchmark.db "select 1"' } }] } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Run 2 used ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'more calls.' } } },
      { type: 'result', is_error: false, result: 'Run 2 used more calls.' },
    ];
    stdout.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    setImmediate(() => proc.emit('close', 0, null));
  });
  Object.assign(proc, { stdout, stderr, stdin: stdinStream, kill: () => true });
  return proc;
};

function request(p: number, method: string, rawPath: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string | number> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-length'] = Buffer.byteLength(opts.body);
    const req = http.request({ host: '127.0.0.1', port: p, method, path: rawPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const post = (p: number, rawPath: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  request(p, 'POST', rawPath, { body: JSON.stringify(body), headers });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-chat-'));
  const resultsDir = path.join(tmp, 'results');
  const dbPath = path.join(resultsDir, 'test.db');
  seedDevDb({ dbPath, artifactsDir: path.join(resultsDir, 'dev'), rootDir: tmp });
  data = createDashboardData({ dbPath, repoRoot: tmp, resultsDir });
  expId = data.experiments().find((e) => e.runs > 0)!.id;
  const distDir = path.join(tmp, 'dist');
  const stateDir = path.join(resultsDir, 'chats');
  const chat = createChatHandler({ data, repoRoot: tmp, stateDir, enabled: true, spawnFn: fakeSpawn });
  server = createDashboardServer({ data, resultsDir, distDir, chat });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const off = createChatHandler({ data, repoRoot: tmp, stateDir, enabled: false, spawnFn: fakeSpawn });
  disabledServer = createDashboardServer({ data, resultsDir, distDir, chat: off });
  await new Promise<void>((r) => disabledServer.listen(0, '127.0.0.1', r));
  disabledPort = (disabledServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await new Promise((r) => disabledServer?.close(r));
  data?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('guards', () => {
  it('isLoopback accepts only loopback binds', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.5')).toBe(false);
  });

  it('requestAllowed refuses foreign Host (DNS rebinding), cross-origin and non-JSON POSTs', () => {
    const req = (headers: Record<string, string>, method = 'POST') => ({ method, headers }) as unknown as http.IncomingMessage;
    expect(requestAllowed(req({ host: '127.0.0.1:4173', 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }))).toBeNull();
    expect(requestAllowed(req({ host: 'localhost:4173', 'content-type': 'application/json' }))).toBeNull();
    expect(requestAllowed(req({ host: 'evil.example:4173', 'content-type': 'application/json' }))).toMatch(/loopback/);
    expect(requestAllowed(req({ host: '127.0.0.1:4173', 'content-type': 'application/json', origin: 'http://evil.example' }))).toMatch(/cross-origin/);
    expect(requestAllowed(req({ host: '127.0.0.1:4173', 'content-type': 'text/plain' }))).toMatch(/json/);
  });

  it('read-only tools only: Bash is limited to sqlite3 -readonly', () => {
    expect(CHAT_ALLOWED_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'Bash(sqlite3 -safe -readonly results/benchmark.db:*)']);
  });

  it('refuses every POST when chat is disabled (non-loopback bind)', async () => {
    const res = await post(disabledPort, `/api/chat/${expId}`, { message: 'hi' });
    expect(res.status).toBe(403);
    const info = JSON.parse((await request(disabledPort, 'GET', `/api/chat/${expId}`)).body) as ChatInfo;
    expect(info.enabled).toBe(false);
  });

  it('refuses a cross-origin POST and a text/plain POST', async () => {
    expect((await post(port, `/api/chat/${expId}`, { message: 'hi' }, { 'content-type': 'application/json', origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(port, `/api/chat/${expId}`, { message: 'hi' }, { 'content-type': 'text/plain' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('404s an unknown experiment and rejects odd paths', async () => {
    expect((await request(port, 'GET', '/api/chat/exp-nope')).status).toBe(404);
    expect((await post(port, '/api/chat/exp-nope', { message: 'hi' })).status).toBe(404);
    expect((await request(port, 'GET', `/api/chat/${expId}/other`)).status).toBe(404);
  });
});

describe('context', () => {
  it('includes the hypothesis, every run, and the session framing', () => {
    const d = data.experiment(expId)!;
    const ctx = experimentContext(d, (id) => data.run(id), tmp);
    expect(ctx).toContain(`experiment ${expId}`);
    expect(ctx).toContain(d.experiment.hypothesis.trim().slice(0, 40));
    for (const r of d.runs) expect(ctx).toContain(r.id);
    expect(ctx).toMatch(/snapshot from when the chat started/);
  });
});

describe('round trip', () => {
  it('streams tool + text events, saves the session, and resumes it with the same context', async () => {
    const first = await post(port, `/api/chat/${expId}`, { message: 'Why was run 2 expensive?' });
    expect(first.status).toBe(200);
    const events = first.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(events[0]).toEqual({ type: 'tool', label: expect.stringContaining('sqlite3 -readonly') });
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Run 2 used more calls.');
    expect(events.at(-1)).toEqual({ type: 'done' });

    const c1 = calls[0];
    expect(c1.stdin).toBe('Why was run 2 expensive?');
    expect(c1.args).toContain('--session-id');
    expect(c1.args).not.toContain('--resume');
    expect(c1.args).toContain('--disallowedTools');
    expect(c1.args.slice(c1.args.indexOf('--permission-mode'), c1.args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'default']);
    expect(c1.args.slice(c1.args.indexOf('--setting-sources'), c1.args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', '']);
    expect(c1.env.ANTHROPIC_BASE_URL).toBeUndefined();
    const sp1 = c1.args[c1.args.indexOf('--append-system-prompt') + 1];
    expect(sp1).toContain(`experiment ${expId}`);

    const info = JSON.parse((await request(port, 'GET', `/api/chat/${expId}`)).body) as ChatInfo;
    expect(info.started).toBe(true);
    expect(info.busy).toBe(false);
    expect(info.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(info.messages[1].parts).toEqual([
      { kind: 'tool', label: expect.stringContaining('sqlite3') },
      { kind: 'text', text: 'Run 2 used more calls.' },
    ]);

    await post(port, `/api/chat/${expId}`, { message: 'And run 3?' });
    const c2 = calls[1];
    expect(c2.args.slice(c2.args.indexOf('--resume'), c2.args.indexOf('--resume') + 2)).toEqual(['--resume', info.sessionId]);
    expect(c2.args[c2.args.indexOf('--append-system-prompt') + 1]).toBe(sp1);
  });

  it('rejects an empty message', async () => {
    expect((await post(port, `/api/chat/${expId}`, { message: '   ' })).status).toBe(400);
  });
});
