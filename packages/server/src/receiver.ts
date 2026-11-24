/**
 * The collector: an OTLP/HTTP (JSON) endpoint on loopback that writes Claude Code's telemetry straight
 * into the telemetry store, plus a hook endpoint for session context.
 *
 *   POST /v1/logs | /v1/traces | /v1/metrics   OTLP/JSON export requests (gzip accepted)
 *   POST /hook                                  a Claude Code hook's stdin JSON (session id, cwd, transcript)
 *   GET  /health                                {ok, sessions, events, lastEvent}
 *
 * Bound to 127.0.0.1 only. A request that cannot be stored gets a 5xx so the exporter may retry it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { COLLECTOR_PORT, TelemetryDb } from './store.js';

const log = { warn: (msg: string, data: Record<string, unknown>) => console.warn(`collector: ${msg}`, data) };
const MAX_BODY = 256 * 1024 * 1024;
const SIGNALS: Record<string, 'logs' | 'traces' | 'metrics'> = { '/v1/logs': 'logs', '/v1/traces': 'traces', '/v1/metrics': 'metrics' };

function reply(res: ServerResponse, code: number, body: unknown = {}): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function startCollector(db: TelemetryDb, o: { port?: number; host?: string } = {}): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && (path === '/health' || path === '')) return reply(res, 200, { ok: true, ...db.stats() });
      if (req.method !== 'POST') return reply(res, 404, { error: 'not found' });
      // Only local, non-browser senders: a web page could otherwise post here (no CORS preflight for
      // text/plain), so a page Origin is refused and bodies must be declared JSON.
      if (req.headers.origin) return reply(res, 403, { error: 'browser requests are refused' });
      let raw = await readBody(req);
      if ((req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip') raw = gunzipSync(raw);
      if (path === '/hook') {
        if (!(req.headers['content-type'] ?? '').includes('json')) return reply(res, 415, { error: 'hook posts must be application/json' });
        db.recordHook(JSON.parse(raw.toString('utf8') || '{}'));
        return reply(res, 200, {});
      }
      const signal = SIGNALS[path];
      if (!signal) return reply(res, 404, { error: 'unsupported path' });
      if (!(req.headers['content-type'] ?? '').includes('json'))
        return reply(res, 415, { error: 'this collector accepts OTLP/JSON only: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json' });
      db.ingest(signal, JSON.parse(raw.toString('utf8')));
      reply(res, 200, {});
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      log.warn('request failed', { path, error: msg });
      reply(res, e instanceof SyntaxError ? 400 : 500, { error: msg });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? COLLECTOR_PORT, o.host ?? '127.0.0.1', () => resolve(server));
  });
}
