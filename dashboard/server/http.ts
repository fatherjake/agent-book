/**
 * Read-only HTTP server for the dashboard. node:http only, no framework.
 *
 *   GET /api/overview
 *   GET /api/experiments
 *   GET /api/experiments/:id
 *   GET /api/runs/:id
 *   GET /api/charts
 *   GET /artifacts/<path>      files under results/ only (traversal-safe)
 *   GET /*                     built SPA from dashboard/dist
 *
 * Every method other than GET/HEAD is rejected with 405.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DashboardData } from './data.js';

export interface ServerOptions {
  data: DashboardData;
  /** Absolute path of the results directory that /artifacts serves from. */
  resultsDir: string;
  /** Absolute path of the built SPA (dashboard/dist). May not exist. */
  distDir: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Types served inline from /artifacts; everything else is served as an attachment-ish octet stream or text. */
const ARTIFACT_TEXTLIKE = new Set(['.ts', '.tsx', '.jsx', '.js', '.css', '.html', '.sql', '.csv', '.xml']);

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve a URL path segment (already stripped of the /artifacts/ prefix) to an
 * absolute file under root, or null if it escapes root, hits a dotfile, or
 * isn't a regular file. Follows symlinks and re-checks containment.
 */
export function resolveSafe(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const parts = rel.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('.'))) return null;
  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch {
      return null;
    }
  })();
  if (!rootReal) return null;
  const candidate = path.resolve(rootReal, ...parts);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) return null;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (!real.startsWith(rootReal + path.sep)) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, head = false) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(head ? undefined : text);
}

function sendFile(res: http.ServerResponse, file: string, opts: { head: boolean; artifact: boolean }) {
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  let type = contentTypeFor(file);
  // Never let a results file execute as active content in the dashboard's origin.
  if (opts.artifact && (ext === '.html' || ext === '.svg' || ext === '.js' || ARTIFACT_TEXTLIKE.has(ext))) {
    type = 'text/plain; charset=utf-8';
  }
  const headers: Record<string, string | number> = {
    'content-type': type,
    'content-length': stat.size,
    'x-content-type-options': 'nosniff',
    'cache-control': opts.artifact ? 'no-cache' : file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (opts.artifact) headers['content-security-policy'] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
  res.writeHead(200, headers);
  if (opts.head) return res.end();
  fs.createReadStream(file).pipe(res);
}

export function createDashboardServer(opts: ServerOptions): http.Server {
  const { data, resultsDir, distDir } = opts;

  return http.createServer((req, res) => {
    // Never read request bodies; drain them so the connection stays healthy.
    req.resume();
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'Method not allowed: the dashboard is read-only' });
    }
    const head = method === 'HEAD';
    // Reject dot segments (raw or percent-encoded) before URL normalization can rewrite them.
    const rawPath = (req.url ?? '/').split('?')[0];
    const badSegment = rawPath.split('/').some((seg) => {
      try {
        const d = decodeURIComponent(seg);
        return d === '.' || d === '..' || d.includes('/') || d.includes('\\') || d.includes('\0');
      } catch {
        return true;
      }
    });
    if (badSegment) return sendJson(res, 400, { error: 'Bad path' }, head);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }
    // Work on the raw (still percent-encoded) pathname so encoded slashes can't sneak through routing.
    const p = url.pathname;

    try {
      if (p === '/api' || p.startsWith('/api/')) {
        const seg = p.split('/').slice(2).map((s) => decodeURIComponent(s));
        if (seg.length === 1 && seg[0] === 'overview') return sendJson(res, 200, data.overview(), head);
        if (seg.length === 1 && seg[0] === 'experiments') return sendJson(res, 200, { experiments: data.experiments() }, head);
        if (seg.length === 1 && seg[0] === 'charts') return sendJson(res, 200, data.charts(), head);
        if (seg.length === 2 && seg[0] === 'experiments') {
          const d = data.experiment(seg[1]);
          return d ? sendJson(res, 200, d, head) : sendJson(res, 404, { error: `Experiment not found: ${seg[1]}` }, head);
        }
        if (seg.length === 2 && seg[0] === 'runs') {
          const d = data.run(seg[1]);
          return d ? sendJson(res, 200, d, head) : sendJson(res, 404, { error: `Run not found: ${seg[1]}` }, head);
        }
        if (seg.length === 1 && seg[0] === 'health') return sendJson(res, 200, { ok: true }, head);
        return sendJson(res, 404, { error: 'Unknown API endpoint' }, head);
      }

      if (p.startsWith('/artifacts/')) {
        const file = resolveSafe(resultsDir, p.slice('/artifacts/'.length));
        // The SQLite files themselves are not artifacts.
        if (!file || /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(file)) return sendJson(res, 404, { error: 'Artifact not found' }, head);
        return sendFile(res, file, { head, artifact: true });
      }

      // Static SPA.
      if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(
          head
            ? undefined
            : 'Dashboard UI is not built. Run:\n  npm --prefix dashboard install && npm --prefix dashboard run build\nThe JSON API under /api/ is available.\n',
        );
      }
      const file = p === '/' ? path.join(distDir, 'index.html') : resolveSafe(distDir, p.slice(1));
      if (file) return sendFile(res, file, { head, artifact: false });
      if (p.startsWith('/assets/')) return sendJson(res, 404, { error: 'Not found' }, head);
      // Unknown non-asset path: serve the SPA shell (hash routing makes this rare).
      return sendFile(res, path.join(distDir, 'index.html'), { head, artifact: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) return sendJson(res, 500, { error: msg }, head);
      res.destroy();
    }
  });
}
