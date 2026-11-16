/**
 * Lab HTTP server: the JSON API the web UI reads, plus the built UI (web/dist).
 *
 *   GET  /api/repos/:repo                    repo, latest profile, task suite
 *   GET  /api/repos/:repo/sessions           sessions with their runs and suggestions (each with its runs)
 *   POST /api/suggestions/:id/decision       { "status": "accepted" | "rejected" | "tested" }
 *   POST /api/tasks/:id/approval             { "approved": true | false }
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { REPO_ROOT } from '../runner/env.js';
import { LabDb, type RunRow } from './db.js';

const WEB_DIST = join(REPO_ROOT, 'web', 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function apiRun(r: RunRow) {
  return {
    id: r.id,
    taskId: r.taskId,
    pairKey: r.pairKey,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    status: r.status,
    tokens: r.tokens,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    criteriaMet: r.criteriaMet,
    criteriaDetail: r.criteriaDetail,
    skillsFired: r.skillsFired,
    error: r.error,
  };
}

export function sessionsPayload(db: LabDb, repoId: string) {
  return db.listSessions(repoId).map((s) => ({
    ...s,
    runs: db.sessionRuns(s.id).map(apiRun),
    suggestions: db.listSuggestions(s.id).map((g) => ({ ...g, runs: db.suggestionRuns(g.id).map(apiRun) })),
  }));
}

export function repoPayload(db: LabDb, repoId: string) {
  const repo = db.getRepo(repoId);
  if (!repo) return null;
  return { repo, profile: db.latestProfile(repoId), tasks: db.listTasks(repoId) };
}

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 100_000) throw new Error('body too large');
  }
  return s ? JSON.parse(s) : {};
}

function send(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function startServer(opts: { port: number; host?: string; dbPath?: string }) {
  const db = new LabDb(opts.dbPath);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] === 'api') {
        if (req.method === 'GET' && parts[1] === 'repos' && parts[2] && !parts[3]) {
          const p = repoPayload(db, parts[2]);
          return p ? send(res, 200, p) : send(res, 404, { error: `unknown repo ${parts[2]}` });
        }
        if (req.method === 'GET' && parts[1] === 'repos' && parts[2] && parts[3] === 'sessions') return send(res, 200, sessionsPayload(db, parts[2]));
        if (req.method === 'POST' && parts[1] === 'suggestions' && parts[2] && parts[3] === 'decision') {
          const { status } = await body(req);
          if (!['accepted', 'rejected', 'tested'].includes(status)) return send(res, 400, { error: 'status must be accepted, rejected or tested' });
          const g = db.getSuggestion(parts[2]);
          if (!g) return send(res, 404, { error: 'unknown suggestion' });
          if (!['tested', 'accepted', 'rejected'].includes(g.status)) return send(res, 409, { error: `suggestion is ${g.status}; it can be decided once its runs finish` });
          db.setSuggestionStatus(g.id, status);
          return send(res, 200, db.getSuggestion(g.id));
        }
        if (req.method === 'POST' && parts[1] === 'tasks' && parts[2] && parts[3] === 'approval') {
          const { approved } = await body(req);
          db.setTaskApproved(parts[2], !!approved);
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'not found' });
      }
      // Static UI (hash routing, so every other path serves index.html).
      const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      let file = join(WEB_DIST, rel);
      if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('web/dist is missing: run `npm --prefix web run build`');
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    } catch (e) {
      send(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  });
  server.listen(opts.port, opts.host ?? '127.0.0.1');
  return { server, db };
}
