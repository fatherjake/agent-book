/**
 * Gateway tests against a fake loopback upstream (no real model, no network).
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_OAUTH_TOKEN,
  SETUP_TOKEN_HELP,
  SseUsageParser,
  buildUpstreamHeaders,
  detectUsageLimit,
  startGateway,
  type GatewayHandle,
} from '../../runner/gateway.js';
import { FAKE_USAGE_DELTA, FAKE_USAGE_START, sseBody, startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

const REAL = 'sk-ant-oat01-REAL-SECRET-TEST-TOKEN-1234567890';
const logDir = process.env.FRUGAL_LOG_DIR;

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { hostname: u.hostname, port: u.port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${PLACEHOLDER_OAUTH_TOKEN}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** Send a raw HTTP request line (to test absolute-form / scheme-relative targets). */
function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.end(`${requestLine}\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
  });
}

describe('gateway', () => {
  let fake: FakeAnthropic;
  let gw: GatewayHandle | undefined;
  let dir: string;
  beforeEach(async () => {
    fake = await startFakeAnthropic({ replyText: 'hello', chunkDelayMs: 5 });
    dir = mkdtempSync(join(tmpdir(), 'gw-'));
  });
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
    await fake.close();
  });

  it('refuses non-anthropic upstreams and a test token with the real upstream', async () => {
    await expect(startGateway({ role: 'coding', upstreamUrl: 'https://evil.example.com', token: 'x' })).rejects.toThrow(/upstream must be https:\/\/api\.anthropic\.com/);
    await expect(startGateway({ role: 'coding', upstreamUrl: 'http://10.0.0.1:80', token: 'x' })).rejects.toThrow(/refusing/);
    await expect(startGateway({ role: 'coding', upstreamUrl: 'https://api.anthropic.com', token: 'x' })).rejects.toThrow(/only allowed with a loopback/);
  });

  it('fails fast with setup instructions when no subscription token exists', async () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = PLACEHOLDER_OAUTH_TOKEN; // treated as "no token"; also blocks .env loading
    try {
      await expect(startGateway({ role: 'coding' })).rejects.toThrow(SETUP_TOKEN_HELP);
      expect(SETUP_TOKEN_HELP).toMatch(/claude setup-token/);
      expect(SETUP_TOKEN_HELP).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  });

  it('streams SSE through byte-identically, swaps the token and records usage', async () => {
    const usageFile = join(dir, 'usage.jsonl');
    gw = await startGateway({ role: 'coding', runId: 'r1', usageFile, upstreamUrl: fake.url, token: REAL, mainModel: 'claude-sonnet-5-5' });
    expect(gw.hostUrl).toBe(`http://127.0.0.1:${gw.port}`);
    const res = await post(gw.hostUrl, '/v1/messages?beta=true', { model: 'claude-sonnet-5-5', stream: true, messages: [] }, { 'x-api-key': 'should-be-stripped', cookie: 'a=b' });
    expect(res.status).toBe(200);
    expect(res.raw.toString('utf8')).toBe(sseBody('claude-sonnet-5-5', 'hello'));
    const up = fake.requests[0];
    expect(up.path).toBe('/v1/messages?beta=true');
    expect(up.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(up.headers['x-api-key']).toBeUndefined();
    expect(up.headers.cookie).toBeUndefined();
    expect(up.headers['accept-encoding']).toBe('identity');
    const recs = gw.tracker.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      role: 'coding',
      runId: 'r1',
      purpose: 'agent-turn',
      model: 'claude-sonnet-5-5',
      inputTokens: FAKE_USAGE_START.input_tokens,
      outputTokens: FAKE_USAGE_DELTA.output_tokens,
      reasoningTokens: 3,
      reasoningIncludedInOutput: true,
      cacheReadTokens: FAKE_USAGE_START.cache_read_input_tokens,
      cacheWriteTokens: FAKE_USAGE_START.cache_creation_input_tokens,
      totalTokens: 12 + 7 + 200 + 100,
      costEstimated: true,
      usageEstimated: false,
    });
    expect((recs[0].raw as any).output_tokens_details.thinking_tokens).toBe(3);
    expect(readFileSync(usageFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('parses non-streaming JSON usage, classifies background and count_tokens calls', async () => {
    gw = await startGateway({ role: 'evaluator', upstreamUrl: fake.url, token: REAL, mainModel: 'claude-sonnet-5-5' });
    const r1 = await post(gw.hostUrl, '/v1/messages', { model: 'claude-haiku-5-5', messages: [] });
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.raw.toString()).content[0].text).toBe('hello');
    const r2 = await post(gw.hostUrl, '/v1/messages/count_tokens?beta=true', { model: 'claude-sonnet-5-5', messages: [] });
    expect(JSON.parse(r2.raw.toString())).toEqual({ input_tokens: 4242 });
    const recs = gw.tracker.records();
    expect(recs.map((r) => r.purpose)).toEqual(['background', 'count-tokens']);
    expect(recs[0]).toMatchObject({ role: 'evaluator', model: 'claude-haiku-5-5', inputTokens: 12, outputTokens: 7, cacheReadTokens: 200, cacheWriteTokens: 100 });
    expect(recs[1]).toMatchObject({ totalTokens: 0, raw: { input_tokens: 4242 } });
  });

  it('forwards other paths and methods, but never steers to another host', async () => {
    gw = await startGateway({ role: 'coding', upstreamUrl: fake.url, token: REAL });
    const head = await new Promise<number>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port: gw!.port, path: '/api/hello', method: 'HEAD' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(head).toBe(200);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'HEAD', path: '/api/hello' });
    const before = fake.requests.length;
    const abs = await rawRequest(gw.port, 'GET http://example.com/steal HTTP/1.1');
    expect(abs).toMatch(/^HTTP\/1\.1 400/);
    const rel = await rawRequest(gw.port, 'GET //example.com/steal HTTP/1.1');
    expect(rel).toMatch(/^HTTP\/1\.1 400/);
    expect(fake.requests.length).toBe(before);
    expect(gw.tracker.records()).toHaveLength(0);
  });

  it('drops non-placeholder credentials instead of forwarding them', () => {
    const { headers, auth } = buildUpstreamHeaders({ authorization: 'Bearer someone-elses-token', 'x-api-key': 'k', 'anthropic-beta': 'oauth-2025-04-20', 'x-goog-api-key': 'g' }, REAL);
    expect(auth).toBe('stripped');
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-goog-api-key']).toBeUndefined();
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('enforces maxModelCalls and maxTotalTokens with a clear 400', async () => {
    const reasons: string[] = [];
    gw = await startGateway({ role: 'coding', upstreamUrl: fake.url, token: REAL, limits: { maxModelCalls: 2 }, onLimitExceeded: (r) => reasons.push(r) });
    for (let i = 0; i < 2; i++) expect((await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true })).status).toBe(200);
    // count_tokens doesn't count as a model call and is never blocked
    expect((await post(gw.hostUrl, '/v1/messages/count_tokens', { model: 'claude-sonnet-5-5' })).status).toBe(200);
    const blocked = await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true });
    expect(blocked.status).toBe(400);
    const err = JSON.parse(blocked.raw.toString());
    expect(err.error.type).toBe('invalid_request_error');
    expect(err.error.message).toMatch(/maxModelCalls \(2\) reached/);
    expect(gw.limitExceeded()).toMatch(/maxModelCalls/);
    expect(reasons).toHaveLength(1);
    expect(fake.requests.filter((r) => r.path === '/v1/messages')).toHaveLength(2);
    await gw.stop();

    gw = await startGateway({ role: 'coding', upstreamUrl: fake.url, token: REAL, limits: { maxTotalTokens: 500 } });
    expect((await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true })).status).toBe(200); // 319 tokens
    expect((await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true })).status).toBe(200); // 638 >= 500 afterwards
    const b2 = await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true });
    expect(b2.status).toBe(400);
    expect(gw.limitExceeded()).toMatch(/maxTotalTokens \(500\) reached: 638/);
  });

  it('detects subscription usage limits from 429 responses', async () => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const seen: string[] = [];
    gw = await startGateway({ role: 'coding', upstreamUrl: fake.url, token: REAL, onUsageLimit: (r) => seen.push(r) });
    fake.handler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset), 'retry-after': '7200' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }));
      return true;
    };
    expect(gw.usageLimitResetAt()).toBeNull();
    const r = await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true });
    expect(r.status).toBe(429);
    expect(gw.usageLimitResetAt()).toBe(new Date(reset * 1000).toISOString());
    expect(seen).toHaveLength(1);
    expect(gw.tracker.records()).toHaveLength(0); // error responses carry no usage
  });

  it('detectUsageLimit: unified headers, long retry-after, ignores short rate limits and non-429', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(detectUsageLimit(429, { 'anthropic-ratelimit-unified-reset': '1794790800' }, now)).toBe(new Date(1794790800 * 1000).toISOString());
    expect(detectUsageLimit(429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': '1794790800' }, now)).toBe(
      new Date(1794790800 * 1000).toISOString(),
    );
    expect(detectUsageLimit(429, { 'retry-after': '3600' }, now)).toBe(new Date(now + 3600_000).toISOString());
    expect(detectUsageLimit(429, { 'retry-after': '5' }, now)).toBeNull();
    expect(detectUsageLimit(200, { 'anthropic-ratelimit-unified-reset': '1794790800' }, now)).toBeNull();
    // Real header shape captured from a subscription response (healthy 200: overage 'rejected' must not trigger).
    const real = {
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-reset': '1794988800',
      'anthropic-ratelimit-unified-7d-reset': '1794988800',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
      'anthropic-ratelimit-unified-status': 'allowed',
    };
    expect(detectUsageLimit(200, real, now)).toBeNull();
    // Same shape at the limit: the rejected window's reset wins over the representative unified-reset.
    const limited = { ...real, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': '1794740000' };
    expect(detectUsageLimit(429, limited, now)).toBe(new Date(1794740000 * 1000).toISOString());
  });

  it('never logs the token, headers or bodies', async () => {
    gw = await startGateway({ role: 'coding', upstreamUrl: fake.url, token: REAL });
    await post(gw.hostUrl, '/v1/messages', { model: 'claude-sonnet-5-5', stream: true, secretBody: 'BODY-MARKER' });
    await post(gw.hostUrl, '/v1/messages', { model: 'x' }, { authorization: 'Bearer OTHER-TOKEN-MARKER' });
    fake.handler = (_r, res) => {
      res.writeHead(500);
      res.end('ERR-BODY-MARKER');
      return true;
    };
    await post(gw.hostUrl, '/v1/messages', { model: 'x' });
    await gw.stop();
    gw = undefined;
    const dirs = [logDir, join(process.cwd(), 'results', 'logs')].filter((d): d is string => !!d && existsSync(d));
    for (const d of dirs) {
      for (const f of readdirSync(d)) {
        const txt = readFileSync(join(d, f), 'utf8');
        expect(txt).not.toContain(REAL);
        expect(txt).not.toContain(PLACEHOLDER_OAUTH_TOKEN);
        expect(txt).not.toContain('OTHER-TOKEN-MARKER');
        expect(txt).not.toContain('BODY-MARKER');
      }
    }
  });

  it('SseUsageParser handles split chunks and CRLF framing', () => {
    const body = sseBody('m', 'x');
    const p = new SseUsageParser();
    for (let i = 0; i < body.length; i += 7) p.push(body.slice(i, i + 7));
    p.end();
    expect(p.usage).toMatchObject({ input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 200 });
    expect(p.model).toBe('m');
    expect(p.stopReason).toBe('end_turn');
    const q = new SseUsageParser();
    q.push(body.replace(/\n/g, '\r\n'));
    q.end();
    expect(q.usage?.output_tokens).toBe(7);
  });
});
