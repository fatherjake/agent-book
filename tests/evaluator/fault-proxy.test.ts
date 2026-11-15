/**
 * The evaluator's fault-injecting HTTP proxy (evaluator/fault-proxy.ts), run locally as the exact
 * script the proxy container runs (`node -e FAULT_PROXY_SCRIPT`), in front of a local upstream.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAULT_PROXY_SCRIPT, shouldFail, type FaultMode } from '../../evaluator/fault-proxy.js';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe('shouldFail', () => {
  it('implements the three modes on /api only', () => {
    expect(shouldFail('off', 'POST', '/api/todos')).toBe(false);
    expect(shouldFail('fail-mutations-500', 'POST', '/api/todos')).toBe(true);
    expect(shouldFail('fail-mutations-500', 'PATCH', '/api/todos/3')).toBe(true);
    expect(shouldFail('fail-mutations-500', 'DELETE', '/api/todos/3')).toBe(true);
    expect(shouldFail('fail-mutations-500', 'GET', '/api/todos')).toBe(false);
    expect(shouldFail('fail-all-api-500', 'GET', '/api/todos?x=1')).toBe(true);
    expect(shouldFail('fail-all-api-500', 'GET', '/')).toBe(false);
    expect(shouldFail('fail-all-api-500', 'GET', '/assets/api/x.js')).toBe(false);
    expect(shouldFail('fail-all-api-500', 'GET', '/apix')).toBe(false);
  });
});

describe('fault proxy script', { timeout: 30_000 }, () => {
  let upstream: http.Server;
  let proxy: ChildProcess;
  let clean = '';
  let agent = '';
  let faultFile = '';
  const seen: string[] = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const [cp, ap] = [await freePort(), await freePort()];
    faultFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-fault-')), 'mode');
    proxy = spawn(process.execPath, ['-e', FAULT_PROXY_SCRIPT], {
      env: {
        UPSTREAM_HOST: '127.0.0.1',
        UPSTREAM_PORT: String((upstream.address() as AddressInfo).port),
        CLEAN_PORT: String(cp),
        AGENT_PORT: String(ap),
        FAULT_FILE: faultFile,
        BIND: '127.0.0.1',
      },
      stdio: 'ignore',
    });
    clean = `http://127.0.0.1:${cp}`;
    agent = `http://127.0.0.1:${ap}`;
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${clean}/`);
        await fetch(`${agent}/`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  afterAll(async () => {
    proxy?.kill('SIGKILL');
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const setMode = (m: FaultMode) => fs.writeFileSync(faultFile, m);
  const post = (base: string) => fetch(`${base}/api/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":"t"}' });

  it('off: forwards method, path, body, status and headers unchanged on both listeners', async () => {
    setMode('off');
    for (const base of [clean, agent]) {
      const r = await post(base);
      expect(r.status).toBe(201);
      expect(r.headers.get('x-upstream')).toBe('yes');
      expect(await r.json()).toEqual({ method: 'POST', url: '/api/todos', body: '{"title":"t"}' });
    }
    // missing mode file = off
    fs.rmSync(faultFile, { force: true });
    expect((await post(agent)).status).toBe(201);
  });

  it('fail-mutations-500: mutations on the agent listener get a contract-shaped 500; GETs and the clean listener are untouched', async () => {
    setMode('fail-mutations-500');
    const before = seen.length;
    const r = await post(agent);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Simulated server failure' } });
    expect(seen.length).toBe(before); // never reached the app
    for (const m of ['PATCH', 'DELETE']) expect((await fetch(`${agent}/api/todos/1`, { method: m })).status).toBe(500);
    expect((await fetch(`${agent}/api/todos`)).status).toBe(200);
    expect((await post(clean)).status).toBe(201);
  });

  it('fail-all-api-500: every /api request on the agent listener fails, the page itself still loads', async () => {
    setMode('fail-all-api-500');
    expect((await fetch(`${agent}/api/todos`)).status).toBe(500);
    expect((await fetch(`${agent}/`)).status).toBe(200);
    expect((await fetch(`${clean}/api/todos`)).status).toBe(200);
    setMode('off');
    expect((await fetch(`${agent}/api/todos`)).status).toBe(200);
  });

  it('an unreachable app drops the connection (no synthetic 502), like the old TCP forwarder', async () => {
    const dead = await freePort();
    const [cp, ap] = [await freePort(), await freePort()];
    const p = spawn(process.execPath, ['-e', FAULT_PROXY_SCRIPT], {
      env: { UPSTREAM_HOST: '127.0.0.1', UPSTREAM_PORT: String(dead), CLEAN_PORT: String(cp), AGENT_PORT: String(ap), FAULT_FILE: faultFile, BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    try {
      let err: unknown = null;
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${cp}/api/todos`);
          err = new Error(`unexpected status ${r.status}`);
          break;
        } catch (e) {
          err = e;
          if (String((e as Error).cause ?? '').includes('ECONNREFUSED')) await new Promise((r) => setTimeout(r, 100));
          else break;
        }
      }
      expect(String(err)).toMatch(/fetch failed|socket|other side closed/i);
    } finally {
      p.kill('SIGKILL');
    }
  });
});
