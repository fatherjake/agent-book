/**
 * Small HTTP client for Mastodon REST checks (host fetch against the forwarder URL).
 */
import { AssertionFailure, trunc } from '../../checks.js';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface ApiRequest {
  method?: string;
  token?: string | null;
  /** Form fields; arrays become `key[]=v` repeated. */
  form?: Record<string, string | number | boolean | Array<string | number> | null | undefined>;
  json?: unknown;
  timeoutMs?: number;
}

export function encodeForm(form: NonNullable<ApiRequest['form']>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) p.append(`${k}[]`, String(x));
    else p.append(k, String(v));
  }
  return p.toString();
}

export class MastodonApi {
  constructor(readonly baseUrl: string) {}

  /** `pathOrUrl` may be a path ('/api/v1/...') or an absolute URL (e.g. from a Link header). */
  async request<T = unknown>(pathOrUrl: string, req: ApiRequest = {}): Promise<ApiResponse<T>> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (req.token) headers.Authorization = `Bearer ${req.token}`;
    let body: string | undefined;
    if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(req.form);
    } else if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.json);
    }
    const res = await fetch(url, {
      method: req.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, headers: res.headers, body: parsed as T, text };
  }

  get<T = unknown>(p: string, token?: string | null) {
    return this.request<T>(p, { token });
  }
  post<T = unknown>(p: string, token?: string | null, form?: ApiRequest['form']) {
    return this.request<T>(p, { method: 'POST', token, form: form ?? {} });
  }
  put<T = unknown>(p: string, token?: string | null, form?: ApiRequest['form']) {
    return this.request<T>(p, { method: 'PUT', token, form: form ?? {} });
  }
  delete<T = unknown>(p: string, token?: string | null) {
    return this.request<T>(p, { method: 'DELETE', token });
  }
}

/** Parse an RFC 8288 Link header into { rel: url }. */
export function parseLinkHeader(h: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>\s*;(.*)$/.exec(part.trim());
    if (!m) continue;
    const relM = /rel\s*=\s*"?([^";]+)"?/i.exec(m[2]);
    if (!relM) continue;
    for (const rel of relM[1].trim().split(/\s+/)) out[rel.toLowerCase()] = m[1];
  }
  return out;
}

export function expectStatus(res: ApiResponse, expected: number | number[], what: string): void {
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  if (!ok) throw new AssertionFailure(`${what}: expected HTTP ${Array.isArray(expected) ? expected.join(' or ') : expected}, got ${res.status} ${trunc(res.text, 300)}`);
}

export function asArray<T = Record<string, unknown>>(res: ApiResponse, what: string): T[] {
  if (!Array.isArray(res.body)) throw new AssertionFailure(`${what}: expected a JSON array, got ${trunc(res.text, 200)}`);
  return res.body as T[];
}

export function asObject<T = Record<string, unknown>>(res: ApiResponse, what: string): T {
  if (!res.body || typeof res.body !== 'object' || Array.isArray(res.body)) throw new AssertionFailure(`${what}: expected a JSON object, got ${trunc(res.text, 200)}`);
  return res.body as T;
}
