/**
 * The system context for the page's chat: what Agent Book is, how to dig deeper (the telemetry store and
 * the session's transcript, read-only), and a text version of everything on the session's page. It is
 * fixed when the chat starts; each message adds a note of what the user is looking at right then.
 */
import { homedir } from 'node:os';
import { TELEMETRY_DB_PATH, TelemetryDb } from './store.js';
import { sessionDetail, type SessionDetail } from './session-detail.js';
import { listSessions, type SessionSummary } from './sessions.js';

/** The session context is cut to about this many characters (it goes on the command line). */
const MAX_CONTEXT = 90_000;

const home = homedir();
const tilde = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);

export const CHAT_PROMPT = `You are chatting from the bottom pane of Agent Book, a local dashboard of the user's Claude Code sessions. It is built from Claude Code's OpenTelemetry export, which a collector writes to a SQLite file, plus Claude Code's transcripts.
The page shows one session: headline stats, then tabs (launched sessions, conversation, time, cost, changes) and a detail panel for whatever is selected. Below is a text version of that session's page as it was when this chat started. Each message from the user begins with a note of the tab and selection they are looking at.
Answer from the page context first. When you need more, look it up read-only:
- The telemetry store: sqlite3 -readonly ${tilde(TELEMETRY_DB_PATH())} "<query>". Tables: sessions(id, cwd, branch, transcript_path, parent_id, first_ts, last_ts, events, prompts), events(session_id, prompt_id, name, ts, attrs JSON), spans(session_id, name, start_ts, end_ts, duration_ms, tool_use_id, attrs JSON, output), metrics(session_id, name, ts, value, attrs JSON). Event names include user_prompt (attrs.prompt), assistant_response (attrs.response), tool_result (attrs.tool_name, tool_parameters / tool_input, duration_ms, success), api_request (attrs.model, query_source, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms). Tool output is spans.output, joined on tool_use_id. attrs.query_source says what a model call was for: repl_main_thread / sdk is the conversation, agent:* a subagent, the rest are side calls (prompt suggestions, recaps, titles).
- The session's transcript (JSONL) when it still exists, and the files in its folder.
Never change anything: no edits, no writes, no commands other than read-only queries. Costs are the API-equivalent dollars Claude Code reports. Keep replies short and concrete; the pane is small.`;

const usd = (v: number) => (v < 0.01 && v > 0 ? '<$0.01' : `$${v.toFixed(2)}`);
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
const one = (s: string | null | undefined, n = 140) => {
  const line = (s ?? '').replace(/\s+/g, ' ').trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
};
const titleOf = (s: SessionSummary) => s.title ?? one(s.firstPrompt, 80) ?? 'Untitled';

/** The session page as text. */
export function pageText(d: SessionDetail): string {
  const s = d.session;
  const t = d.time;
  const c = d.changes;
  const tokens = d.totals.input + d.totals.output + d.totals.cacheRead + d.totals.cacheWrite;
  const out: string[] = [];
  out.push(`<session id="${s.id}">`);
  out.push(`Title: ${titleOf(s)}${s.headless ? ' (headless)' : ''}`);
  if (s.summary) out.push(`Recap: ${s.summary}`);
  out.push(`Folder: ${s.folder ?? 'unknown'}${s.branch ? ` (branch ${s.branch})` : ''}`);
  out.push(`Open: ${s.start} → ${s.end} (${dur(t.wallMs)}); Claude Code ${s.appVersion ?? '?'}`);
  if (s.parentId) out.push(`Launched from session ${s.parentId} (${d.parent ? titleOf(d.parent) : '?'}), link: ${s.parentLink}`);
  out.push('</session>');

  out.push(`\n<stats>`);
  out.push(`Cost ${usd(d.totals.costUsd)} over ${d.totals.requests} model calls; tokens ${tok(tokens)} (cache read ${tok(d.totals.cacheRead)}, cache write ${tok(d.totals.cacheWrite)}, input ${tok(d.totals.input)}, output ${tok(d.totals.output)})`);
  out.push(`Time: working ${dur(t.workingMs)} of ${dur(t.wallMs)} open (model ${dur(t.modelMs)}, tools ${dur(t.toolMs)}, permission prompts ${dur(t.permissionMs)}); Claude Code active-time metric: CLI ${dur(t.activeCliMs)}, user ${dur(t.activeUserMs)}`);
  out.push(`Changes: +${c.linesAdded} −${c.linesRemoved} lines, ${c.files.length} files edited, ${c.filesRead} read, ${c.commits.length} commits, ${c.pullRequests.length} PRs`);
  if (d.childrenTotal.sessions) out.push(`Launched ${d.childrenTotal.sessions} sessions costing ${usd(d.childrenTotal.costUsd)} (${tok(d.childrenTotal.tokens)} tokens), not included above`);
  out.push(`</stats>`);

  if (d.children.length) {
    out.push(`\n<launched_sessions>`);
    for (const k of d.children) out.push(`- ${k.id} ${k.start} "${titleOf(k)}" in ${k.folder ?? '?'}: ${usd(k.costUsd)}, ${tok(k.tokens)} tokens${k.parentLink === 'timing' ? ' (linked by timing, a guess)' : ''}`);
    out.push(`</launched_sessions>`);
  }

  out.push(`\n<cost_by_model>`);
  for (const m of d.byModel) out.push(`- ${m.model}: ${m.requests} calls, ${usd(m.costUsd)}, ${tok(m.input + m.output + m.cacheRead + m.cacheWrite)} tokens`);
  out.push(`</cost_by_model>\n<cost_by_purpose>`);
  for (const p of d.bySource) out.push(`- ${p.source}: ${p.requests} calls, ${usd(p.costUsd)}, ${tok(p.tokens)} tokens`);
  out.push(`</cost_by_purpose>`);

  out.push(`\n<slowest_tool_calls>`);
  for (const x of t.slowestTools) out.push(`- ${dur(x.durationMs)} ${x.name} ${one(x.label, 120)}`);
  out.push(`</slowest_tool_calls>`);

  if (c.commits.length) {
    out.push(`\n<commits>`);
    for (const x of c.commits.slice(0, 150)) out.push(`- ${x.ts} ${x.message ?? one(x.command, 120)}`);
    out.push(`</commits>`);
  }
  if (c.files.length) {
    out.push(`\n<files_edited>`);
    for (const f of c.files.slice(0, 200)) out.push(`- ${f.path}: ${f.edits.length} edits, +${f.added} −${f.removed}`);
    out.push(`</files_edited>`);
  }

  // The conversation last: it is the part that gets cut when the session is long.
  out.push(`\n<conversation turns="${d.turns.length}">`);
  const head = out.join('\n');
  const lines: string[] = [];
  d.turns.forEach((x, i) => {
    const who = x.promptKind === 'user' ? 'user' : x.promptKind === 'task' ? 'background task' : 'message';
    const tools = x.items.filter((it) => it.kind === 'tool').map((it) => (it.kind === 'tool' ? it.name : ''));
    const counts = [...new Set(tools)].map((n) => `${n}×${tools.filter((x) => x === n).length}`).join(' ');
    const reply = [...x.items].reverse().find((it) => it.kind === 'response');
    lines.push(
      `#${i + 1} ${x.ts} [${who}] ${one(x.promptLabel ?? x.prompt, 300)} | ${dur(x.durationMs)}, ${usd(x.costUsd)}, ${x.toolCalls} tools${counts ? ` (${counts})` : ''}` +
        (reply && reply.kind === 'response' ? `\n   last reply: ${one(reply.text, 300)}` : ''),
    );
  });
  let body = lines.join('\n');
  if (head.length + body.length > MAX_CONTEXT) {
    // Keep the start and the end of the conversation; the middle is what gets dropped.
    const budget = MAX_CONTEXT - head.length - 200;
    const half = Math.max(0, Math.floor(budget / 2));
    body = `${body.slice(0, half)}\n… (middle turns left out; query the events table for them) …\n${body.slice(body.length - half)}`;
  }
  return `${head}\n${body}\n</conversation>`;
}

/** The chat's whole system context for a session, or for the session list when `id` is null. */
export function chatContext(db: TelemetryDb, id: string | null): { prompt: string; name: string; folder: string | null } {
  if (id) {
    const d = sessionDetail(db, id);
    if (d) return { prompt: `${CHAT_PROMPT}\n\n${pageText(d)}`, name: titleOf(d.session), folder: d.session.folder };
  }
  const recent = listSessions(db)
    .filter((s) => !s.parentId)
    .slice(0, 80)
    .map((s) => `- ${s.id} ${s.end} "${titleOf(s)}" in ${s.folder ?? '?'}${s.headless ? ' (headless)' : ''}`);
  return { prompt: `${CHAT_PROMPT}\n\nNo session is open. The most recent sessions:\n${recent.join('\n')}`, name: 'All sessions', folder: null };
}
