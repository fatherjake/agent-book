/**
 * OTLP/JSON decoding (Claude Code exports `http/json`) and credential scrubbing for what is stored.
 */

export type Attrs = Record<string, unknown>;

/** An OTLP AnyValue as a plain value. */
export function anyValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, any>;
  if ('stringValue' in o) return o.stringValue;
  if ('intValue' in o) {
    const n = Number(o.intValue);
    return Number.isSafeInteger(n) ? n : String(o.intValue);
  }
  if ('doubleValue' in o) return Number(o.doubleValue);
  if ('boolValue' in o) return Boolean(o.boolValue);
  if ('arrayValue' in o) return (o.arrayValue?.values ?? []).map(anyValue);
  if ('kvlistValue' in o) return attrs(o.kvlistValue?.values);
  if ('bytesValue' in o) return o.bytesValue;
  return null;
}

/** An OTLP KeyValue list as an object. */
export function attrs(kvs: unknown): Attrs {
  const out: Attrs = {};
  if (Array.isArray(kvs)) for (const kv of kvs) if (kv && typeof kv === 'object' && 'key' in kv) out[(kv as any).key] = anyValue((kv as any).value);
  return out;
}

/** Nanoseconds since the epoch (string or number) → ISO timestamp, or null. */
export function nsToIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const n = BigInt(String(v));
    if (n <= 0n) return null;
    const ms = Number(n / 1_000_000n);
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

export interface LogRecord {
  resource: Attrs;
  attributes: Attrs;
  ts: string | null;
  traceId: string | null;
  spanId: string | null;
}

export function* iterLogs(payload: any): Generator<LogRecord> {
  for (const rl of payload?.resourceLogs ?? []) {
    const resource = attrs(rl?.resource?.attributes);
    for (const sl of rl?.scopeLogs ?? [])
      for (const rec of sl?.logRecords ?? [])
        yield { resource, attributes: attrs(rec?.attributes), ts: nsToIso(rec?.timeUnixNano) ?? nsToIso(rec?.observedTimeUnixNano), traceId: rec?.traceId || null, spanId: rec?.spanId || null };
  }
}

export interface SpanRecord {
  resource: Attrs;
  name: string;
  traceId: string;
  spanId: string;
  parentId: string | null;
  attributes: Attrs;
  start: string | null;
  end: string | null;
  durationMs: number | null;
  events: { name: string; ts: string | null; attributes: Attrs }[];
}

export function* iterSpans(payload: any): Generator<SpanRecord> {
  for (const rs of payload?.resourceSpans ?? []) {
    const resource = attrs(rs?.resource?.attributes);
    for (const ss of rs?.scopeSpans ?? [])
      for (const s of ss?.spans ?? []) {
        let durationMs: number | null = null;
        try {
          durationMs = Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6;
        } catch {
          /* missing times */
        }
        yield {
          resource,
          name: s?.name ?? '',
          traceId: s?.traceId ?? '',
          spanId: s?.spanId ?? '',
          parentId: s?.parentSpanId || null,
          attributes: attrs(s?.attributes),
          start: nsToIso(s?.startTimeUnixNano),
          end: nsToIso(s?.endTimeUnixNano),
          durationMs,
          events: (s?.events ?? []).map((e: any) => ({ name: e?.name ?? '', ts: nsToIso(e?.timeUnixNano), attributes: attrs(e?.attributes) })),
        };
      }
  }
}

export interface MetricPoint {
  resource: Attrs;
  name: string;
  value: number | null;
  attributes: Attrs;
  ts: string | null;
}

export function* iterMetrics(payload: any): Generator<MetricPoint> {
  for (const rm of payload?.resourceMetrics ?? []) {
    const resource = attrs(rm?.resource?.attributes);
    for (const sm of rm?.scopeMetrics ?? [])
      for (const m of sm?.metrics ?? [])
        for (const kind of ['sum', 'gauge', 'histogram'] as const)
          for (const dp of m?.[kind]?.dataPoints ?? []) {
            const value = 'asInt' in dp ? Number(dp.asInt) : 'asDouble' in dp ? Number(dp.asDouble) : 'sum' in dp ? Number(dp.sum) : null;
            yield { resource, name: m?.name ?? '', value, attributes: attrs(dp?.attributes), ts: nsToIso(dp?.timeUnixNano) ?? nsToIso(dp?.startTimeUnixNano) };
          }
  }
}

/**
 * Things that look like credentials, replaced before anything is stored. Conservative on purpose: long hex
 * strings stay (git shas are data the miner needs).
 */
const SECRETS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const URL_CREDS = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g;
const KEY_VALUE = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)((?=[^\s"'&;,]*[A-Za-z])[^\s"'&;,$(){}<>]{6,})\3/gi;

export function scrub(s: string): string {
  if (!s) return s;
  let out = s;
  for (const re of SECRETS) out = out.replace(re, '[REDACTED]');
  return out
    .replace(BEARER, '$1 [REDACTED]')
    .replace(URL_CREDS, '$1$2:[REDACTED]@')
    .replace(KEY_VALUE, (m, k, sep, q) => `${k}${sep}${q}[REDACTED]${q}`);
}

export function scrubDeep<T>(v: T): T {
  if (typeof v === 'string') return scrub(v) as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) as T;
  return v;
}
