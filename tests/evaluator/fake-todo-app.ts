/**
 * TEST DOUBLE: an in-process todo app implementing the API + accessibility contract closely enough
 * for the browser-agent harness assertions, exposed as a LaunchedApp with a clean `url` and a
 * faultable `agentUrl` (same fault semantics as evaluator/fault-proxy.ts). Not the reference app.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LaunchedApp, TodoRow } from '../../evaluator/app-launcher.js';
import { shouldFail, type FaultMode } from '../../evaluator/fault-proxy.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Todos</title></head><body>
<h1>Todos</h1>
<form id="f"><input id="n" aria-label="New todo"><button>Add</button></form>
<div id="err" role="alert"></div>
<ul aria-label="Todo list" id="l"></ul>
<script>
const err = (m) => { document.getElementById('err').textContent = m || ''; };
async function load() {
  const r = await fetch('/api/todos');
  const todos = await r.json();
  const l = document.getElementById('l');
  l.innerHTML = '';
  for (const t of todos) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = t.completed; cb.setAttribute('aria-label', 'Toggle ' + t.title);
    cb.onchange = async () => {
      const r = await fetch('/api/todos/' + t.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: cb.checked }) });
      if (!r.ok) { err('Could not update'); } else err('');
      load();
    };
    const span = document.createElement('span'); span.textContent = t.title;
    li.append(cb, span); l.append(li);
  }
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = document.getElementById('n').value.trim();
  if (!v) { err('Title is required'); return; }
  const r = await fetch('/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: v }) });
  if (!r.ok) { const b = await r.json().catch(() => ({})); err((b.error && b.error.message) || 'Request failed'); return; }
  err(''); document.getElementById('n').value = ''; load();
});
load();
</script></body></html>`;

export interface FakeTodoApp extends LaunchedApp {
  faultModes: FaultMode[];
  close(): Promise<void>;
}

export async function startFakeTodoApp(): Promise<FakeTodoApp> {
  let rows: TodoRow[] = [];
  let nextId = 1;
  let mode: FaultMode = 'off';
  const faultModes: FaultMode[] = [];
  const api = (t: TodoRow) => ({ id: t.id, title: t.title, completed: !!t.completed, createdAt: t.created_at });
  const handler = (faultable: boolean) => (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': data === undefined ? 'text/plain' : 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const url = req.url ?? '/';
      if (faultable && shouldFail(mode, req.method ?? 'GET', url)) return send(500, { error: { code: 'INTERNAL_ERROR', message: 'Simulated server failure' } });
      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(PAGE);
      }
      const m = /^\/api\/todos(?:\/(\d+))?$/.exec(url.split('?')[0]);
      if (!m) return send(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      const input = body ? JSON.parse(body) : {};
      if (!m[1] && req.method === 'GET') return send(200, rows.map(api));
      if (!m[1] && req.method === 'POST') {
        const title = String(input.title ?? '').trim();
        if (!title) return send(400, { error: { code: 'VALIDATION_ERROR', message: 'Title is required' } });
        const row: TodoRow = { id: nextId++, title, completed: 0, created_at: new Date(Date.now() + nextId).toISOString() };
        rows.push(row);
        return send(201, api(row));
      }
      const row = rows.find((r) => r.id === Number(m[1]));
      if (!row) return send(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      if (req.method === 'PATCH') {
        if (typeof input.title === 'string') row.title = input.title.trim();
        if (typeof input.completed === 'boolean') row.completed = input.completed ? 1 : 0;
        return send(200, api(row));
      }
      if (req.method === 'DELETE') {
        rows = rows.filter((r) => r !== row);
        return send(204);
      }
      return send(404);
    });
  };
  const listen = async (faultable: boolean) => {
    const srv = http.createServer(handler(faultable));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return srv;
  };
  const clean = await listen(false);
  const agent = await listen(true);
  const u = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const app: FakeTodoApp = {
    url: u(clean),
    agentUrl: u(agent),
    faultModes,
    containerId: 'fake',
    containerName: 'fake',
    async setFaultMode(m) {
      mode = m;
      faultModes.push(m);
    },
    async readDb() {
      return rows.map((r) => ({ ...r }));
    },
    async queryDb() {
      return [];
    },
    async writeDb() {},
    async dbSchema() {
      return { columns: [], sql: '' };
    },
    async restart() {},
    async resetDb() {
      rows = [];
      nextId = 1;
    },
    async stop() {},
    logs: () => '',
    async close() {
      await Promise.all([clean, agent].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
  return app;
}
