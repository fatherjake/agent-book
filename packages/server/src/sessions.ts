/**
 * The session list for the dashboard: one row per session with the folder it ran from and a line
 * saying what it was about.
 *
 * Folder: the hook's working directory, else the `workspace.host_paths` attribute Claude Code puts on
 * API events, else the `cwd` recorded in the session's transcript.
 *
 * Title: the latest session title Claude Code generated (the `generate_session_title` response body),
 * else the title in the transcript (`ai-title`, or `summary` in older versions).
 *
 * Summary: the latest "while you were away" recap (the `away_summary` response body): a sentence or two
 * on what the session was doing and what comes next. Sessions without one show their first prompt.
 *
 * Headless: every API call the session made came through the SDK / `claude -p` (query_source `sdk`),
 * none from an interactive main thread.
 *
 * Parent: the session that launched this one, by the first of these that applies:
 *   hook    the SessionStart hook saw the launching session's id in the inherited environment (exact;
 *           sessions since the hook started recording it)
 *   path    the folder contains another session's id: a run inside that session's scratchpad
 *   timing  a headless session started while exactly one launcher session was running, i.e. one that
 *           ran `claude -p` from Bash or already has children by the rules above (a best guess)
 *
 * The dashboard's own page chats (chats.ts) and lab runs (lab/) are Claude Code sessions too; they are
 * left out of the list.
 *
 * Transcripts are found under ~/.claude/projects by session id when the hook didn't record a path. They
 * can be large, so what is read from each one is cached until the file changes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chatSessionIds } from './chats.js';
import { labSessionIds, labSummaries, type LabSummary } from './lab/state.js';
import { TelemetryDb } from './store.js';

export interface SessionSummary {
  id: string;
  /** Absolute path, with the home directory shown as `~`. */
  folder: string | null;
  branch: string | null;
  title: string | null;
  summary: string | null;
  firstPrompt: string | null;
  prompts: number;
  start: string | null;
  end: string | null;
  appVersion: string | null;
  headless: boolean;
  /** API-equivalent cost of the session's own model calls (not the sessions it launched). */
  costUsd: number;
  /** Tokens of the session's own model calls (0 when it never called the model). */
  tokens: number;
  parentId: string | null;
  /** How the parent was found (see the module comment). */
  parentLink: 'hook' | 'path' | 'timing' | null;
  /** One of the dashboard's own sessions (a page chat or a lab run); only listed with `hidden`. */
  internal: boolean;
  /** The suggestions lab's status for this session, when it has been analysed. */
  lab: LabSummary | null;
}

const PROJECTS = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

interface TranscriptInfo {
  title: string | null;
  cwd: string | null;
}
const cache = new Map<string, { key: string; info: TranscriptInfo }>();

/** Every transcript on disk by session id (`<projects>/<encoded cwd>/<session id>.jsonl`). */
function transcriptIndex(): Map<string, string> {
  const out = new Map<string, string>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(PROJECTS());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(PROJECTS(), d));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith('.jsonl')) out.set(f.slice(0, -6), join(PROJECTS(), d, f));
  }
  return out;
}

const STRING = '"((?:[^"\\\\]|\\\\.)*)"';
const TITLE = new RegExp(`"type":"(?:ai-title","aiTitle|summary","summary)":${STRING}`, 'g');
const CWD = new RegExp(`"cwd":${STRING}`);
const unquote = (s: string): string | null => {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return null;
  }
};

function readTranscript(path: string): TranscriptInfo | null {
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit?.key === key) return hit.info;
  const text = readFileSync(path, 'utf8');
  let title: string | null = null;
  // The latest title wins: Claude Code rewrites it as the session goes on.
  for (const m of text.matchAll(TITLE)) title = unquote(m[1]) ?? title;
  const cwd = text.match(CWD);
  const info = { title, cwd: cwd ? unquote(cwd[1]) : null };
  cache.set(path, { key, info });
  return info;
}

const tilde = (p: string | null): string | null => {
  const home = homedir();
  return p && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
};

/** The text of a stored Messages API response body, or null. */
function responseText(gz: Buffer): string | null {
  try {
    const body = JSON.parse(gunzipSync(gz).toString('utf8'));
    const text = (body?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** `{"title": "…"}` as the title generator returns it, or the bare text. */
function titleFrom(text: string | null): string | null {
  if (!text) return null;
  try {
    const t = JSON.parse(text)?.title;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {
    /* plain text */
  }
  return text;
}

/** The latest stored response body of each kind per session. */
function latestResponses(db: TelemetryDb): Map<string, { title?: string | null; summary?: string | null }> {
  const rows = db.raw
    .prepare(
      `SELECT session_id, q, gz FROM (
         SELECT e.session_id, json_extract(e.attrs, '$.query_source') AS q, b.gz,
                row_number() OVER (PARTITION BY e.session_id, json_extract(e.attrs, '$.query_source') ORDER BY e.ts DESC) AS n
         FROM events e JOIN bodies b ON b.event_id = e.id
         WHERE e.name = 'api_response_body' AND json_extract(e.attrs, '$.query_source') IN ('generate_session_title', 'away_summary')
       ) WHERE n = 1`,
    )
    .all() as { session_id: string; q: string; gz: Buffer }[];
  const out = new Map<string, { title?: string | null; summary?: string | null }>();
  for (const r of rows) {
    const o = out.get(r.session_id) ?? {};
    if (r.q === 'generate_session_title') o.title = titleFrom(responseText(r.gz));
    else o.summary = responseText(r.gz);
    out.set(r.session_id, o);
  }
  return out;
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Sessions whose API calls all came through the SDK / `claude -p`. */
function headlessSessions(db: TelemetryDb): Set<string> {
  const rows = db.raw
    .prepare(
      `SELECT session_id FROM events WHERE name = 'api_request' AND session_id IS NOT NULL
       GROUP BY session_id
       HAVING sum(json_extract(attrs, '$.query_source') = 'sdk') > 0
          AND sum(json_extract(attrs, '$.query_source') = 'repl_main_thread') = 0`,
    )
    .all() as { session_id: string }[];
  return new Set(rows.map((r) => r.session_id));
}

/** Sessions that ran `claude -p` / `claude --print` from their Bash tool. */
function launcherSessions(db: TelemetryDb): Set<string> {
  const rows = db.raw
    .prepare(
      `SELECT DISTINCT session_id FROM events
       WHERE name = 'tool_result' AND json_extract(attrs, '$.tool_name') = 'Bash'
         AND (json_extract(attrs, '$.tool_parameters') LIKE '%claude -p%' OR json_extract(attrs, '$.tool_parameters') LIKE '%claude --print%')`,
    )
    .all() as { session_id: string }[];
  return new Set(rows.map((r) => r.session_id));
}

interface Times {
  start: string | null;
  end: string | null;
}

/** Each session's parent and how it was found; sessions without one are left out. */
function findParents(
  sessions: (Times & { id: string; hookParent: string | null; folder: string | null; headless: boolean })[],
  launchers: Set<string>,
): Map<string, { id: string; link: 'hook' | 'path' | 'timing' }> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out = new Map<string, { id: string; link: 'hook' | 'path' | 'timing' }>();
  for (const s of sessions) {
    if (s.hookParent && byId.has(s.hookParent)) out.set(s.id, { id: s.hookParent, link: 'hook' });
    else {
      const inPath = [...(s.folder ?? '').matchAll(SESSION_ID)].map((m) => m[0]).find((id) => id !== s.id && byId.has(id));
      if (inPath) out.set(s.id, { id: inPath, link: 'path' });
    }
  }
  const known = new Set([...launchers, ...[...out.values()].map((p) => p.id)]);
  for (const s of sessions) {
    if (out.has(s.id) || !s.headless || !s.start) continue;
    const running = [...known].filter((id) => {
      const p = byId.get(id);
      return p && id !== s.id && p.start && p.end && p.start <= s.start! && s.start! <= p.end;
    });
    if (running.length === 1) out.set(s.id, { id: running[0], link: 'timing' });
  }
  // Drop any link that would make a cycle.
  for (const id of [...out.keys()]) {
    const seen = new Set([id]);
    for (let p = out.get(id)?.id; p; p = out.get(p)?.id) {
      if (seen.has(p)) {
        out.delete(id);
        break;
      }
      seen.add(p);
    }
  }
  return out;
}

/**
 * Every session, newest first. The dashboard's own sessions (page chats, and the lab's analyst, replay and
 * judge runs) are left out unless `hidden` is set, so their pages can still be opened.
 */
export function listSessions(db: TelemetryDb, o: { hidden?: boolean } = {}): SessionSummary[] {
  // parent_id arrives with a collector restart; until then the hook column is read as null.
  const hasParent = (db.raw.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some((c) => c.name === 'parent_id');
  const rows = db.raw
    .prepare(
      `SELECT s.id, s.cwd, s.branch, s.transcript_path, s.first_ts, s.last_ts, s.prompts, s.app_version,
         ${hasParent ? 's.parent_id' : 'NULL'} AS parent_id,
         (SELECT json_extract(e.attrs, '$.prompt') FROM events e
            WHERE e.session_id = s.id AND e.name = 'user_prompt' ORDER BY e.ts LIMIT 1) AS first_prompt,
         -- +e.name keeps SQLite on the session index: the name index would scan every api_request.
         (SELECT json_extract(e.attrs, '$."workspace.host_paths"[0]') FROM events e
            WHERE e.session_id = s.id AND +e.name = 'api_request' LIMIT 1) AS host_path
       FROM sessions s
       ORDER BY s.last_ts DESC`,
    )
    .all() as {
    id: string;
    cwd: string | null;
    branch: string | null;
    transcript_path: string | null;
    first_ts: string | null;
    last_ts: string | null;
    prompts: number;
    app_version: string | null;
    first_prompt: string | null;
    host_path: string | null;
    parent_id: string | null;
  }[];
  const transcripts = transcriptIndex();
  const responses = latestResponses(db);
  const headless = headlessSessions(db);
  const own = new Set([...chatSessionIds(), ...labSessionIds()]);
  const labs = labSummaries();
  const usage = new Map(
    (
      db.raw
        .prepare(
          `SELECT session_id, sum(json_extract(attrs, '$.cost_usd')) AS cost,
                  sum(coalesce(json_extract(attrs, '$.input_tokens'), 0) + coalesce(json_extract(attrs, '$.output_tokens'), 0)
                    + coalesce(json_extract(attrs, '$.cache_read_tokens'), 0) + coalesce(json_extract(attrs, '$.cache_creation_tokens'), 0)) AS tokens
           FROM events WHERE name = 'api_request' AND session_id IS NOT NULL GROUP BY session_id`,
        )
        .all() as { session_id: string; cost: number | null; tokens: number | null }[]
    ).map((r) => [r.session_id, { cost: r.cost ?? 0, tokens: r.tokens ?? 0 }]),
  );
  const base = rows.filter((r) => o.hidden || !own.has(r.id)).map((r) => {
    const path = r.transcript_path ?? transcripts.get(r.id) ?? null;
    return { r, t: path ? readTranscript(path) : null };
  });
  const folders = new Map(base.map(({ r, t }) => [r.id, r.cwd ?? r.host_path ?? t?.cwd ?? null]));
  const parents = findParents(
    base.map(({ r }) => ({ id: r.id, start: r.first_ts, end: r.last_ts, hookParent: r.parent_id, folder: folders.get(r.id) ?? null, headless: headless.has(r.id) })),
    launcherSessions(db),
  );
  return base.map(({ r, t }) => {
    const g = responses.get(r.id);
    const parent = parents.get(r.id);
    return {
      id: r.id,
      folder: tilde(folders.get(r.id) ?? null),
      branch: r.branch,
      title: g?.title ?? t?.title ?? null,
      summary: g?.summary ?? null,
      firstPrompt: r.first_prompt,
      prompts: r.prompts,
      start: r.first_ts,
      end: r.last_ts,
      appVersion: r.app_version,
      headless: headless.has(r.id),
      costUsd: usage.get(r.id)?.cost ?? 0,
      tokens: usage.get(r.id)?.tokens ?? 0,
      parentId: parent?.id ?? null,
      parentLink: parent?.link ?? null,
      internal: own.has(r.id),
      lab: labs.get(r.id) ?? null,
    };
  });
}
