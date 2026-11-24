/**
 * The telemetry store: Claude Code's OpenTelemetry export, written straight into SQLite as it arrives.
 *
 * One machine-wide file (~/.agent-book/telemetry.db, every project's sessions), written only by the
 * collector. Each OTLP request is stored in one transaction:
 *
 *   events    every log event (user_prompt, api_request, tool_result, …) with its attributes as JSON
 *   spans     trace spans; tool spans keep the tool's output (span event `tool.output`)
 *   metrics   metric points (lines of code, commits, active time, …)
 *   bodies    raw API response bodies, gzipped. Request bodies are dropped: each repeats the whole
 *             conversation so far, and Claude Code truncates them at the content limit anyway.
 *   hooks     session context from the SessionStart / UserPromptSubmit hooks: working directory,
 *             transcript file and the git branch at that moment (OpenTelemetry has none of these)
 *   sessions  one row per session id, kept up to date from the above
 *
 * Identity attributes (user email, account and organisation ids) are not stored, and strings are
 * scrubbed of things that look like credentials. Re-delivered records are ignored (unique keys).
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { iterLogs, iterMetrics, iterSpans, scrub, scrubDeep, type Attrs } from './otlp.js';

export const TELEMETRY_DB_PATH = () => process.env.AGENT_BOOK_TELEMETRY_DB ?? join(homedir(), '.agent-book', 'telemetry.db');
export const COLLECTOR_PORT = Number(process.env.AGENT_BOOK_COLLECTOR_PORT ?? 4318);

/** Attributes kept as columns or not stored at all. */
const DROP = new Set(['user.id', 'user.email', 'user.account_uuid', 'user.account_id', 'organization.id', 'session.id', 'event.name', 'event.timestamp', 'event.sequence', 'prompt.id', 'terminal.type']);
const BODY_EVENTS = new Set(['api_request_body', 'api_response_body']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, cwd TEXT, branch TEXT, transcript_path TEXT, app_version TEXT, terminal TEXT,
  first_ts TEXT, last_ts TEXT, events INTEGER NOT NULL DEFAULT 0, prompts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, session_id TEXT, prompt_id TEXT, name TEXT NOT NULL,
  ts TEXT, seq INTEGER, trace_id TEXT, span_id TEXT, attrs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_name ON events(name, ts);
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY, trace_id TEXT, parent_id TEXT, session_id TEXT, name TEXT NOT NULL,
  start_ts TEXT, end_ts TEXT, duration_ms REAL, tool_use_id TEXT, attrs TEXT NOT NULL, output TEXT
);
CREATE INDEX IF NOT EXISTS spans_session ON spans(session_id, start_ts);
CREATE INDEX IF NOT EXISTS spans_tool ON spans(tool_use_id);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, session_id TEXT, name TEXT NOT NULL, ts TEXT, value REAL, attrs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_session ON metrics(session_id, name);
CREATE TABLE IF NOT EXISTS bodies (event_id INTEGER PRIMARY KEY, gz BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS hooks (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, event TEXT, cwd TEXT, branch TEXT, transcript_path TEXT, source TEXT
);
CREATE INDEX IF NOT EXISTS hooks_session ON hooks(session_id, ts);
`;

/** Any timestamp form Claude Code has used (…Z, …+00:00, microseconds) as a sortable ISO string. */
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

function strip(a: Attrs): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(a)) if (!DROP.has(k)) out[k] = scrubDeep(v);
  return out;
}

export interface IngestCounts {
  events: number;
  spans: number;
  metrics: number;
  skipped: number;
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

export class TelemetryDb {
  readonly raw: Database.Database;
  constructor(path = TELEMETRY_DB_PATH(), opts: { readonly?: boolean } = {}) {
    if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path, opts.readonly ? { readonly: true, fileMustExist: true } : {});
    this.raw.pragma('busy_timeout = 5000');
    if (!opts.readonly) {
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('synchronous = NORMAL');
      this.raw.exec(SCHEMA);
    }
  }

  /** Open the store for reading, or null when nothing has been collected yet. */
  static openReadonly(path = TELEMETRY_DB_PATH()): TelemetryDb | null {
    try {
      return new TelemetryDb(path, { readonly: true });
    } catch {
      return null;
    }
  }

  close(): void {
    this.raw.close();
  }

  private touch(sessionId: string, ts: string | null, o: { events?: number; prompts?: number; appVersion?: unknown; terminal?: unknown } = {}): void {
    if (!sessionId) return;
    this.raw
      .prepare(
        `INSERT INTO sessions (id, first_ts, last_ts, events, prompts, app_version, terminal) VALUES (@id, @ts, @ts, @events, @prompts, @app, @term)
         ON CONFLICT(id) DO UPDATE SET
           first_ts = CASE WHEN first_ts IS NULL OR (@ts IS NOT NULL AND @ts < first_ts) THEN @ts ELSE first_ts END,
           last_ts = CASE WHEN last_ts IS NULL OR (@ts IS NOT NULL AND @ts > last_ts) THEN @ts ELSE last_ts END,
           events = events + @events, prompts = prompts + @prompts,
           app_version = COALESCE(@app, app_version), terminal = COALESCE(@term, terminal)`,
      )
      .run({ id: sessionId, ts, events: o.events ?? 0, prompts: o.prompts ?? 0, app: o.appVersion == null ? null : String(o.appVersion), term: o.terminal == null ? null : String(o.terminal) });
  }

  /** Store one OTLP/JSON export request (`signal` from the URL path: logs, traces or metrics). */
  ingest(signal: 'logs' | 'traces' | 'metrics', payload: unknown): IngestCounts {
    const n: IngestCounts = { events: 0, spans: 0, metrics: 0, skipped: 0 };
    const keepRequestBodies = process.env.AGENT_BOOK_KEEP_REQUEST_BODIES === '1';
    const run = this.raw.transaction(() => {
      if (signal === 'logs') {
        const ins = this.raw.prepare('INSERT OR IGNORE INTO events (key, session_id, prompt_id, name, ts, seq, trace_id, span_id, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const body = this.raw.prepare('INSERT OR IGNORE INTO bodies (event_id, gz) VALUES (?, ?)');
        for (const r of iterLogs(payload)) {
          const a = r.attributes;
          const name = String(a['event.name'] ?? '').replace(/^claude_code\./, '');
          if (!name) continue;
          const session = a['session.id'] == null ? null : String(a['session.id']);
          const ts = iso(a['event.timestamp']) ?? r.ts;
          const seq = typeof a['event.sequence'] === 'number' ? (a['event.sequence'] as number) : null;
          const kept = strip(a);
          let text: string | null = null;
          if (BODY_EVENTS.has(name) && typeof kept.body === 'string') {
            text = kept.body as string;
            delete kept.body;
            kept.body_chars = text.length;
          }
          const key = `${session}:${seq}:${name}:${ts}`;
          const res = ins.run(key, session, a['prompt.id'] ?? null, name, ts, seq, r.traceId, r.spanId, JSON.stringify(kept));
          if (!res.changes) {
            n.skipped++;
            continue;
          }
          n.events++;
          if (text && (name === 'api_response_body' || keepRequestBodies)) body.run(res.lastInsertRowid, gzipSync(text));
          if (session) this.touch(session, ts, { events: 1, prompts: name === 'user_prompt' ? 1 : 0, appVersion: r.resource['service.version'], terminal: a['terminal.type'] });
        }
      } else if (signal === 'traces') {
        const ins = this.raw.prepare(
          'INSERT OR IGNORE INTO spans (span_id, trace_id, parent_id, session_id, name, start_ts, end_ts, duration_ms, tool_use_id, attrs, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const s of iterSpans(payload)) {
          if (!s.spanId) continue;
          const a = s.attributes;
          const session = a['session.id'] == null ? null : String(a['session.id']);
          const out = s.events.filter((e) => e.name === 'tool.output').map((e) => String(e.attributes.output ?? ''));
          const res = ins.run(s.spanId, s.traceId, s.parentId, session, s.name, s.start, s.end, s.durationMs, (a.tool_use_id ?? a['gen_ai.tool.call.id'] ?? null) as string | null, JSON.stringify(strip(a)), out.length ? scrub(out.join('\n')) : null);
          if (res.changes) n.spans++;
          else n.skipped++;
        }
      } else {
        const ins = this.raw.prepare('INSERT OR IGNORE INTO metrics (key, session_id, name, ts, value, attrs) VALUES (?, ?, ?, ?, ?, ?)');
        for (const m of iterMetrics(payload)) {
          const session = m.attributes['session.id'] == null ? null : String(m.attributes['session.id']);
          const kept = JSON.stringify(strip(m.attributes));
          const res = ins.run(sha(`${session}:${m.name}:${m.ts}:${kept}`), session, m.name, m.ts, m.value, kept);
          if (res.changes) n.metrics++;
          else n.skipped++;
        }
      }
    });
    run();
    return n;
  }

  /** Record a hook call (SessionStart / UserPromptSubmit): where the session runs and on which branch. */
  recordHook(h: HookInput, ts = new Date().toISOString()): void {
    if (!h.session_id) return;
    const cwd = h.cwd ?? null;
    let branch: string | null = null;
    if (cwd)
      try {
        branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
      } catch {
        /* not a repo */
      }
    this.raw.prepare('INSERT INTO hooks (session_id, ts, event, cwd, branch, transcript_path, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(h.session_id, ts, h.hook_event_name ?? null, cwd, branch, h.transcript_path ?? null, h.source ?? null);
    this.touch(h.session_id, ts);
    this.raw
      .prepare('UPDATE sessions SET cwd = COALESCE(?, cwd), branch = COALESCE(?, branch), transcript_path = COALESCE(?, transcript_path) WHERE id = ?')
      .run(cwd, branch, h.transcript_path ?? null, h.session_id);
  }

  /** Set a session's working directory when nothing better is known (imports, transcript fallback). */
  setCwdIfMissing(sessionId: string, cwd: string): void {
    this.raw.prepare('UPDATE sessions SET cwd = ? WHERE id = ? AND cwd IS NULL').run(cwd, sessionId);
  }

  responseBody(eventId: number): string | null {
    const r = this.raw.prepare('SELECT gz FROM bodies WHERE event_id = ?').get(eventId) as { gz: Buffer } | undefined;
    return r ? gunzipSync(r.gz).toString('utf8') : null;
  }

  stats(): { sessions: number; events: number; spans: number; lastEvent: string | null; bytes: number } {
    const one = <T>(sql: string) => (this.raw.prepare(sql).get() as { v: T }).v;
    const pages = (this.raw.pragma('page_count', { simple: true }) as number) * (this.raw.pragma('page_size', { simple: true }) as number);
    return {
      sessions: one<number>('SELECT count(*) AS v FROM sessions'),
      events: one<number>('SELECT count(*) AS v FROM events'),
      spans: one<number>('SELECT count(*) AS v FROM spans'),
      lastEvent: one<string | null>('SELECT max(ts) AS v FROM events'),
      bytes: pages,
    };
  }
}
