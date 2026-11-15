/**
 * Host-side Anthropic gateway for Claude Code processes running on a Claude **subscription**.
 *
 * Every Claude Code process (host-side researcher / browser agent, or the coding agent inside its
 * container) is started with `ANTHROPIC_BASE_URL=<gateway>` and `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`.
 * This module is the ONLY place where the real subscription token (CLAUDE_CODE_OAUTH_TOKEN from .env,
 * created with `claude setup-token`) is used: it swaps the placeholder bearer for the real token on the
 * outgoing upstream request and nowhere else. It never logs headers or bodies.
 *
 * Guarantees:
 *  - Listens on 127.0.0.1 only, on an ephemeral port. (Docker Desktop forwards host.docker.internal
 *    to the host loopback, which is how the coding container's forwarder reaches it.)
 *  - Forwards to https://api.anthropic.com only. The request target must be an origin-form path
 *    ('/...'); absolute-form ('http://x/...') and scheme-relative ('//x/...') targets are refused,
 *    so no request can be steered to another host. Tests may point at a loopback upstream only.
 *  - Streams responses through byte-for-byte (SSE included) while parsing usage on the side.
 *  - Records one UsageRecord per /v1/messages call (purpose 'agent-turn' for the main model,
 *    'background' for side calls on another model, 'count-tokens' for /v1/messages/count_tokens,
 *    which is free on the API and recorded with zero tokens but the counted value in `raw`).
 *  - Enforces maxTotalTokens / maxModelCalls: once reached, further /v1/messages calls get a 400
 *    invalid_request_error that names the limit (Claude Code does not retry 400s), and
 *    `limitExceeded()` reports it.
 *  - Detects subscription usage-limit 429s (anthropic-ratelimit-unified-* headers or a long
 *    retry-after) and exposes the reset time through `usageLimitResetAt()`.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { AgentRole, ModelResponse, UsageRecord } from './types.js';
import { TokenTracker } from './token-tracker.js';
import { loadDotEnv } from './env.js';
import { logger } from './logger.js';

const log = logger('gateway');

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';

/**
 * Dummy value given to every claude process instead of the real token. It has the shape of an
 * OAuth access token so Claude Code takes the subscription auth path, but it is worthless upstream.
 */
export const PLACEHOLDER_OAUTH_TOKEN = 'sk-ant-oat01-frugal-gateway-placeholder-not-a-real-token-0000000000000000000000000000';

/** Hostname the coding container uses to reach the gateway (network alias of the forwarder). */
export const GATEWAY_CONTAINER_ALIAS = 'frugal-gateway';
export const GATEWAY_CONTAINER_PORT = 8080;

export const SETUP_TOKEN_HELP =
  'No Claude subscription token found. Run `claude setup-token` on this machine, then add the printed token to .env as ' +
  'CLAUDE_CODE_OAUTH_TOKEN=<token> (see README "Setup").';

export interface GatewayHandle {
  port: number;
  /** http://127.0.0.1:<port> (for host-side claude processes) */
  hostUrl: string;
  /** URL reachable from the coding container's network (the per-run forwarder alias). */
  containerUrl: string;
  tracker: TokenTracker;
  /** ISO time when a subscription usage limit resets; set once a usage-limit 429 was seen. */
  usageLimitResetAt(): string | null;
  /** (additive) Reason string once a configured gateway limit blocked a call, else null. */
  limitExceeded(): string | null;
  /** (additive) Counters for diagnostics (no secrets). */
  stats(): { requests: number; messagesCalls: number; upstreamErrors: number; blocked: number; lastStatus: number | null };
  stop(): Promise<void>;
}

export interface StartGatewayOptions {
  role: AgentRole;
  runId?: string;
  experimentId?: string;
  /** (additive) Task of the coding run; recorded on each usage record. */
  taskId?: string;
  usageFile?: string;
  limits?: { maxTotalTokens?: number; maxModelCalls?: number };
  onUsageRecord?: (r: UsageRecord) => void;
  /** (additive) Main model id; calls on any other model are recorded as purpose 'background'. */
  mainModel?: string;
  /** (additive) Called once when a subscription usage limit is detected. */
  onUsageLimit?: (resetAt: string) => void;
  /** (additive) Called once when a gateway limit blocks a call. */
  onLimitExceeded?: (reason: string) => void;
  /** (additive) Observer for each upstream response: path, status and ONLY rate-limit headers (no credentials). */
  onUpstreamResponse?: (info: { path: string; status: number; rateLimitHeaders: Record<string, string> }) => void;
  /** TESTS ONLY: loopback upstream (http://127.0.0.1:<port>). Anything else is refused. */
  upstreamUrl?: string;
  /** TESTS ONLY: token to inject instead of CLAUDE_CODE_OAUTH_TOKEN. */
  token?: string;
  /**
   * DEV ONLY (fixture capture): forward the caller's own Authorization header unchanged instead of
   * swapping the placeholder. Never used by the runner.
   */
  passthroughAuth?: boolean;
}

/** Real subscription token from the environment / .env, or undefined. Never log the value. */
function readToken(): string | undefined {
  loadDotEnv();
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!t || t === PLACEHOLDER_OAUTH_TOKEN) return undefined;
  return t;
}

export function hasSubscriptionToken(): boolean {
  return readToken() !== undefined;
}

function resolveUpstream(u: string | undefined): URL {
  if (u === undefined) return new URL(ANTHROPIC_UPSTREAM);
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`gateway: invalid upstreamUrl`);
  }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if (url.origin === ANTHROPIC_UPSTREAM || loopback) {
    if (url.pathname !== '/' || url.search) throw new Error('gateway: upstreamUrl must be an origin without a path');
    return url;
  }
  throw new Error(`gateway: upstream must be ${ANTHROPIC_UPSTREAM} (or a loopback test server); refusing ${url.origin}`);
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'host',
  'content-length', // recomputed by node from the forwarded body
  'accept-encoding', // forced to identity so usage can be parsed from the stream
]);
/** Headers that carry credentials and are never forwarded as-is. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie', 'anthropic-api-key', 'x-auth-token']);

function looksLikeCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name) || /(^|-)(api-?key|token|secret|password|auth)($|-)/.test(name);
}

/** Build upstream headers: drop hop-by-hop + credentials; swap the placeholder bearer for the real token. */
export function buildUpstreamHeaders(
  inHeaders: IncomingHttpHeaders,
  token: string | undefined,
  passthroughAuth = false,
): { headers: Record<string, string | string[]>; auth: 'swapped' | 'passthrough' | 'none' | 'stripped' } {
  const out: Record<string, string | string[]> = {};
  let auth: 'swapped' | 'passthrough' | 'none' | 'stripped' = 'none';
  for (const [k, v] of Object.entries(inHeaders)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (name === 'authorization') {
      const val = Array.isArray(v) ? v[0] : v;
      if (passthroughAuth) {
        out.authorization = val;
        auth = 'passthrough';
      } else if (val === `Bearer ${PLACEHOLDER_OAUTH_TOKEN}` && token) {
        out.authorization = `Bearer ${token}`;
        auth = 'swapped';
      } else auth = 'stripped';
      continue;
    }
    if (looksLikeCredentialHeader(name)) {
      if (passthroughAuth && name === 'x-api-key') out[name] = v;
      continue;
    }
    out[name] = v;
  }
  out['accept-encoding'] = 'identity';
  return { headers: out, auth };
}

// ---------------------------------------------------------------------------
// Usage parsing
// ---------------------------------------------------------------------------

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  [k: string]: unknown;
}

/** Incremental SSE parser that tracks message_start / message_delta usage. */
export class SseUsageParser {
  private buf = '';
  model: string | undefined;
  usage: RawUsage | undefined;
  stopReason: string | undefined;
  sawMessageStop = false;
  error: string | undefined;

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    // Events are separated by a blank line (\n\n or \r\n\r\n).
    while ((idx = this.findBoundary()) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^(\r?\n){2}/, '');
      this.handleEvent(raw);
    }
  }

  end(): void {
    if (this.buf.trim()) this.handleEvent(this.buf);
    this.buf = '';
  }

  private findBoundary(): number {
    const a = this.buf.indexOf('\n\n');
    const b = this.buf.indexOf('\r\n\r\n');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }

  private handleEvent(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev?.type === 'message_start' && ev.message) {
      this.model = ev.message.model ?? this.model;
      if (ev.message.usage) this.usage = { ...ev.message.usage };
    } else if (ev?.type === 'message_delta') {
      if (ev.usage) this.usage = mergeUsage(this.usage, ev.usage);
      if (ev.delta?.stop_reason) this.stopReason = ev.delta.stop_reason;
    } else if (ev?.type === 'message_stop') {
      this.sawMessageStop = true;
    } else if (ev?.type === 'error') {
      this.error = String(ev.error?.type ?? 'error');
    }
  }
}

/** message_delta usage is cumulative: its non-null fields replace message_start's. */
export function mergeUsage(a: RawUsage | undefined, b: RawUsage): RawUsage {
  const out: RawUsage = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === undefined) continue;
    if (k === 'output_tokens_details' && typeof v === 'object') out[k] = { ...((out[k] as object) ?? {}), ...(v as object) };
    else out[k] = v;
  }
  return out;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Convert a raw Anthropic usage object into the tracker's provider-usage shape. */
export function usageFromRaw(model: string, raw: RawUsage | undefined): ModelResponse['usage'] {
  const u = raw ?? {};
  const inputTokens = n(u.input_tokens);
  const outputTokens = n(u.output_tokens);
  const cacheReadTokens = n(u.cache_read_input_tokens);
  const cacheWriteTokens = n(u.cache_creation_input_tokens);
  const reasoningTokens = n(u.output_tokens_details?.thinking_tokens);
  return {
    provider: 'anthropic',
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    reasoningIncludedInOutput: true,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: 0,
    costEstimated: true,
    usageEstimated: raw === undefined,
    raw: raw ?? null,
  };
}

/** Parse a subscription usage-limit response. Returns the reset time (ISO) or null. */
export function detectUsageLimit(status: number, headers: IncomingHttpHeaders, now = Date.now()): string | null {
  if (status !== 429) return null;
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const toIso = (v: string | undefined): string | null => {
    if (!v) return null;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) {
      // epoch seconds (unified-reset) vs epoch ms
      return new Date(num < 1e12 ? num * 1000 : num).toISOString();
    }
    const d = Date.parse(v);
    return Number.isFinite(d) ? new Date(d).toISOString() : null;
  };
  const unifiedStatus = h('anthropic-ratelimit-unified-status');
  const unifiedReset = h('anthropic-ratelimit-unified-reset');
  const unifiedKeys = Object.keys(headers).filter((k) => k.startsWith('anthropic-ratelimit-unified-'));
  // Per-window resets, e.g. anthropic-ratelimit-unified-5h-reset / -7d-reset.
  const windowResets = unifiedKeys
    .filter((k) => /-reset$/.test(k))
    .map((k) => toIso(h(k)))
    .filter((x): x is string => !!x)
    .sort();
  // Real headers (captured 2026-11-15): unified-status, unified-reset (epoch s), representative-claim,
  // per-window unified-<w>-status / -<w>-reset / -<w>-utilization (w = 5h, 7d, ...), and overage-status
  // (often 'rejected' even on healthy 200s, so it is never used on its own). Only 429s are considered.
  const rejectedWindowResets = unifiedKeys
    .filter((k) => /^anthropic-ratelimit-unified-(.+)-status$/.test(k) && h(k) === 'rejected' && !k.includes('overage'))
    .map((k) => toIso(h(k.replace(/-status$/, '-reset'))))
    .filter((x): x is string => !!x)
    .sort();
  if (unifiedStatus === 'rejected' || unifiedReset || unifiedKeys.length) {
    const reset = rejectedWindowResets[rejectedWindowResets.length - 1] ?? toIso(unifiedReset) ?? windowResets[windowResets.length - 1] ?? null;
    if (reset) return reset;
    const ra = Number(h('retry-after'));
    return new Date(now + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3600_000)).toISOString();
  }
  // Plain rate limits carry a short retry-after (Claude Code retries those). A long one is a usage limit.
  const ra = Number(h('retry-after'));
  if (Number.isFinite(ra) && ra >= 300) return new Date(now + ra * 1000).toISOString();
  return null;
}

/** Rate-limit related response headers only (anthropic-ratelimit-*, retry-after). */
export function rateLimitHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k.startsWith('anthropic-ratelimit-') || k === 'retry-after') out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

function classifyPath(path: string): 'messages' | 'count-tokens' | 'other' {
  const p = path.split('?')[0];
  if (p === '/v1/messages') return 'messages';
  if (p === '/v1/messages/count_tokens') return 'count-tokens';
  return 'other';
}

function modelMatches(model: string, main: string): boolean {
  return model === main || model.startsWith(main) || main.startsWith(model);
}

function jsonError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-frugal-gateway': '1' });
  res.end(body);
}

export async function startGateway(opts: StartGatewayOptions): Promise<GatewayHandle> {
  const upstream = resolveUpstream(opts.upstreamUrl);
  const isTestUpstream = opts.upstreamUrl !== undefined && upstream.origin !== ANTHROPIC_UPSTREAM;
  const token = opts.token !== undefined ? (isTestUpstream ? opts.token : undefined) : readToken();
  if (opts.token !== undefined && !isTestUpstream) throw new Error('gateway: the `token` option is only allowed with a loopback test upstream');
  if (!token && !opts.passthroughAuth) throw new Error(SETUP_TOKEN_HELP);

  const tracker = new TokenTracker({ role: opts.role, runId: opts.runId, experimentId: opts.experimentId, taskId: opts.taskId, usageFile: opts.usageFile, onRecord: opts.onUsageRecord });
  const client = upstream.protocol === 'https:' ? https : http;
  const agent = upstream.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: 32 }) : new http.Agent({ keepAlive: true, maxSockets: 32 });

  let usageLimitAt: string | null = null;
  let limitReason: string | null = null;
  const stats = { requests: 0, messagesCalls: 0, upstreamErrors: 0, blocked: 0, lastStatus: null as number | null };
  const inflight = new Set<http.ClientRequest>();

  const countedCalls = () => tracker.records().filter((r) => r.purpose !== 'count-tokens').length;
  const checkLimits = (): string | null => {
    const l = opts.limits;
    if (!l) return null;
    const totals = tracker.totals();
    if (l.maxTotalTokens !== undefined && totals.totalTokens >= l.maxTotalTokens)
      return `maxTotalTokens (${l.maxTotalTokens}) reached: ${totals.totalTokens}`;
    if (l.maxModelCalls !== undefined && countedCalls() >= l.maxModelCalls) return `maxModelCalls (${l.maxModelCalls}) reached`;
    return null;
  };

  const record = (kind: 'messages' | 'count-tokens', reqModel: string, respModel: string | undefined, raw: RawUsage | undefined) => {
    const model = respModel || reqModel || 'unknown';
    if (kind === 'count-tokens') {
      tracker.record({ ...usageFromRaw(model, {}), usageEstimated: false, raw: raw ?? null }, 'count-tokens');
      return;
    }
    const purpose = opts.mainModel && !modelMatches(model, opts.mainModel) && !modelMatches(reqModel, opts.mainModel) ? 'background' : 'agent-turn';
    tracker.record(usageFromRaw(model, raw), purpose);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    stats.requests++;
    const target = req.url ?? '';
    // Only origin-form targets. Rejects 'http://other/...' and '//other/...'.
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
      log.warn('refused non origin-form request target', { method: req.method });
      jsonError(res, 400, 'invalid_request_error', 'frugal gateway: only origin-form request paths are accepted');
      req.resume();
      return;
    }
    const pathOnly = target.split('?')[0];
    const kind = classifyPath(target);

    if (kind === 'messages' && req.method === 'POST') {
      const lim = checkLimits();
      if (lim) {
        stats.blocked++;
        if (!limitReason) {
          limitReason = lim;
          log.warn('gateway limit reached; blocking further model calls', { reason: lim, runId: opts.runId });
          try {
            opts.onLimitExceeded?.(lim);
          } catch {
            /* observer errors are ignored */
          }
        }
        jsonError(res, 400, 'invalid_request_error', `frugal gateway: run limit exceeded: ${lim}`);
        req.resume();
        return;
      }
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => res.destroy());
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let reqModel = '';
      let reqStream = false;
      if (kind !== 'other' && body.length) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          reqModel = typeof j?.model === 'string' ? j.model : '';
          reqStream = j?.stream === true;
        } catch {
          /* not JSON: forwarded as-is */
        }
      }
      const { headers, auth } = buildUpstreamHeaders(req.headers, token, opts.passthroughAuth);
      if (body.length) headers['content-length'] = String(body.length);
      if (auth === 'stripped') log.warn('dropped a non-placeholder Authorization header', { path: pathOnly });

      const upReq = client.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: target,
          headers: { ...headers, host: upstream.host },
          agent,
          // Upstream responses are never followed to other locations.
        },
        (upRes) => {
          inflight.delete(upReq);
          const status = upRes.statusCode ?? 502;
          stats.lastStatus = status;
          if (kind === 'messages') stats.messagesCalls++;
          log.debug('upstream response', { method: req.method, path: pathOnly, status });
          if (status >= 400) log.info('upstream error status', { method: req.method, path: pathOnly, status });

          const rl = rateLimitHeaders(upRes.headers);
          if (Object.keys(rl).length) log.debug('upstream rate-limit headers', { path: pathOnly, status, ...rl });
          try {
            opts.onUpstreamResponse?.({ path: pathOnly, status, rateLimitHeaders: rl });
          } catch {
            /* ignore */
          }
          const ul = detectUsageLimit(status, upRes.headers);
          if (ul) {
            const first = usageLimitAt === null;
            usageLimitAt = ul;
            if (first) {
              log.warn('subscription usage limit reached', { path: pathOnly, status, resetAt: ul });
              try {
                opts.onUsageLimit?.(ul);
              } catch {
                /* ignore */
              }
            }
          }

          const outHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            const name = k.toLowerCase();
            if (name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding' || name === 'set-cookie') continue;
            outHeaders[name] = v;
          }
          res.writeHead(status, outHeaders);
          res.flushHeaders();

          const ctype = String(upRes.headers['content-type'] ?? '');
          const isSse = ctype.includes('text/event-stream');
          const parse = kind !== 'other' && status < 400;
          const sse = parse && isSse ? new SseUsageParser() : undefined;
          const jsonChunks: Buffer[] | undefined = parse && !isSse ? [] : undefined;
          let recorded = false;
          const finish = () => {
            if (recorded || !parse) return;
            recorded = true;
            try {
              if (sse) {
                sse.end();
                if (sse.usage || sse.model) record(kind as 'messages', reqModel, sse.model, sse.usage);
              } else if (jsonChunks) {
                const j = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
                if (kind === 'count-tokens') record('count-tokens', reqModel, undefined, { input_tokens: j?.input_tokens });
                else record('messages', reqModel, j?.model, j?.usage);
              }
            } catch (e) {
              log.warn('could not parse usage from upstream response', { path: pathOnly, error: String((e as Error)?.message ?? e) });
              if (kind === 'messages') record('messages', reqModel, undefined, undefined);
            }
          };
          upRes.on('data', (c: Buffer) => {
            sse?.push(c);
            jsonChunks?.push(c);
            res.write(c);
          });
          upRes.on('end', () => {
            finish();
            res.end();
          });
          upRes.on('error', () => {
            finish();
            res.destroy();
          });
          upRes.on('aborted', () => {
            finish();
            res.destroy();
          });
          void reqStream;
        },
      );
      inflight.add(upReq);
      upReq.setTimeout(15 * 60_000, () => upReq.destroy(new Error('upstream timeout')));
      upReq.on('error', (e) => {
        inflight.delete(upReq);
        stats.upstreamErrors++;
        log.warn('upstream request failed', { method: req.method, path: pathOnly, error: (e as Error).message });
        jsonError(res, 502, 'api_error', 'frugal gateway: upstream request failed');
      });
      res.on('close', () => {
        // Client went away: abort the upstream request too.
        if (!res.writableFinished) upReq.destroy();
      });
      upReq.end(body);
    });
  };

  const server = http.createServer(handle);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  log.info('gateway listening', { port, role: opts.role, runId: opts.runId, upstream: upstream.origin });

  let stopped = false;
  return {
    port,
    hostUrl: `http://127.0.0.1:${port}`,
    containerUrl: `http://${GATEWAY_CONTAINER_ALIAS}:${GATEWAY_CONTAINER_PORT}`,
    tracker,
    usageLimitResetAt: () => usageLimitAt,
    limitExceeded: () => limitReason,
    stats: () => ({ ...stats }),
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const r of inflight) r.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      agent.destroy();
      log.info('gateway stopped', { port, runId: opts.runId, stats });
    },
  };
}
