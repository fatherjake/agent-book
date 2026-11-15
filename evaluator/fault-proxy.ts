/**
 * The evaluator's forwarder in front of the app container: a minimal HTTP-aware reverse proxy with
 * fault injection. Evaluator-owned code (never app code); it runs inside the proxy container as
 * `node -e FAULT_PROXY_SCRIPT` from the benchmark image.
 *
 * Two listeners, both published on 127.0.0.1 only:
 *   CLEAN_PORT (8080)  never faulted. LaunchedApp.url: harness API reads/seeding, backend tests,
 *                      deterministic UI scenarios (which keep using page.route), visual tests.
 *   AGENT_PORT (8081)  faultable. LaunchedApp.agentUrl: the LLM browser agent's page only.
 *
 * Fault control: the mode is read from FAULT_FILE (on the proxy's tmpfs) on every request. Only the
 * host can change it (`docker exec <proxy> ...`, see app-launcher.ts setFaultMode). There is no
 * network control channel, so neither the app nor the browser can switch modes.
 *
 * Modes (FaultMode):
 *   off                 forward everything
 *   fail-mutations-500  /api/* POST, PUT, PATCH, DELETE → 500 INTERNAL_ERROR (GETs still work)
 *   fail-all-api-500    every /api/* request → 500 INTERNAL_ERROR
 *
 * Fidelity: status, headers and bodies are streamed through unchanged. If the app is unreachable
 * the client socket is destroyed (like the old TCP pipe) instead of answering 502, so the
 * launcher's readiness loop keeps treating "app still starting" as a connection error.
 */

export const FAULT_MODES = ['off', 'fail-mutations-500', 'fail-all-api-500'] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export const PROXY_CLEAN_PORT = 8080;
export const PROXY_AGENT_PORT = 8081;
export const PROXY_FAULT_FILE = '/tmp/frugal-fault-mode';

/** Pure decision function (mirrored inside the script; unit-tested). */
export function shouldFail(mode: string, method: string, url: string): boolean {
  const path = url.split('?')[0];
  if (!(path === '/api' || path.startsWith('/api/'))) return false;
  if (mode === 'fail-all-api-500') return true;
  if (mode === 'fail-mutations-500') return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  return false;
}

/**
 * Self-contained CommonJS script (no deps). Env: UPSTREAM_HOST (app), UPSTREAM_PORT (3000),
 * CLEAN_PORT, AGENT_PORT, FAULT_FILE, BIND (0.0.0.0).
 */
export const FAULT_PROXY_SCRIPT = String.raw`
const http = require('http'), net = require('net'), fs = require('fs');
const E = process.env;
const UH = E.UPSTREAM_HOST || 'app', UP = +(E.UPSTREAM_PORT || 3000);
const FILE = E.FAULT_FILE || '/tmp/frugal-fault-mode', BIND = E.BIND || '0.0.0.0';
const mode = () => { try { return fs.readFileSync(FILE, 'utf8').trim() || 'off'; } catch { return 'off'; } };
const fail = (m, method, url) => {
  const p = String(url || '').split('?')[0];
  if (!(p === '/api' || p.startsWith('/api/'))) return false;
  if (m === 'fail-all-api-500') return true;
  if (m === 'fail-mutations-500') return !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
  return false;
};
function serve(faultable) {
  const srv = http.createServer((req, res) => {
    if (faultable && fail(mode(), req.method, req.url)) {
      req.resume();
      const body = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Simulated server failure' } });
      res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      return res.end(body);
    }
    const up = http.request({ host: UH, port: UP, method: req.method, path: req.url, headers: req.headers, agent: false }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.statusMessage, ur.rawHeaders);
      ur.pipe(res);
      ur.on('error', () => res.destroy());
    });
    up.on('error', () => { if (!res.headersSent) req.socket.destroy(); else res.destroy(); });
    req.pipe(up);
    req.on('error', () => up.destroy());
  });
  srv.on('upgrade', (req, sock, head) => {
    const u = net.connect(UP, UH, () => {
      let h = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
      for (let i = 0; i < req.rawHeaders.length; i += 2) h += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
      u.write(h + '\r\n'); if (head && head.length) u.write(head);
      sock.pipe(u).pipe(sock);
    });
    u.on('error', () => sock.destroy()); sock.on('error', () => u.destroy());
  });
  srv.keepAliveTimeout = 5000;
  return srv;
}
serve(false).listen(+(E.CLEAN_PORT || 8080), BIND);
serve(true).listen(+(E.AGENT_PORT || 8081), BIND);
`;
