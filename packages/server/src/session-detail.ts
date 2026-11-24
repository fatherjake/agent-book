/**
 * One session in detail, for the session page: the sessions it launched, the conversation turn by turn,
 * where the time went, what it cost, and what it changed. All of it comes from the telemetry store.
 *
 *   Turns       events grouped by prompt id: the prompt, Claude's replies, tool calls (subagent work nested
 *               under the subagent), errors, compactions, skills and permission-mode changes
 *   Time        wall clock from first to last event. "Working" is the time something was running: the
 *               union of model calls (side calls such as recaps left out), tool calls (the Agent tool
 *               left out: its subagent's own calls are counted) and waits for a permission decision. Each
 *               moment counts once, as permission wait, else tool, else model, so the three add up to
 *               working time however many calls ran at once. A turn's duration is the same measure over
 *               its own calls. (Interaction spans are not used: long turns often lack theirs.) The rest
 *               of the wall clock is time waiting for the next prompt.
 *               Tool output is fetched separately (toolOutput).
 *   Cost        every API request, including side calls (titles, recaps, suggestions) and subagents
 *   Changes     lines added/removed (Claude Code's own metric), each file edited or written with the
 *               edits themselves, commits and pull requests made through Bash
 */
import { TelemetryDb } from './store.js';
import { listSessions, type SessionSummary } from './sessions.js';

/** Long strings are cut to this many characters in the payload (tool output is fetched on its own). */
const MAX_TEXT = 4000;
const cut = (s: string | null | undefined, n = MAX_TEXT): string | null => (s == null ? null : s.length > n ? s.slice(0, n) + `…[${s.length - n} more chars]` : s);

/** API calls that are not the conversation itself. */
const SIDE_SOURCES = new Set(['prompt_suggestion', 'away_summary', 'generate_session_title', 'agent_summary', 'side_question', 'web_fetch_apply', 'web_search_tool', 'compact']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type Item =
  | { kind: 'response'; ts: string; text: string }
  | { kind: 'tool'; ts: string; id: string | null; name: string; label: string; input: string | null; success: boolean; durationMs: number | null; hasOutput: boolean }
  | { kind: 'subagent'; ts: string; agentId: string; agentType: string | null; tokens: number | null; toolUses: number | null; durationMs: number | null; done: boolean; items: Item[] }
  | { kind: 'error'; ts: string; text: string }
  | { kind: 'compaction'; ts: string; trigger: string | null; preTokens: number | null; postTokens: number | null; durationMs: number | null }
  | { kind: 'skill'; ts: string; name: string }
  | { kind: 'mode'; ts: string; from: string | null; to: string | null };

/** Who a turn's "prompt" came from: you, a background task finishing, or another session or agent. */
export type PromptKind = 'user' | 'task' | 'message';

export interface Turn {
  promptId: string;
  ts: string;
  prompt: string | null;
  promptKind: PromptKind;
  /** One line for lists: the prompt's first line, or a notification's summary. */
  promptLabel: string | null;
  durationMs: number;
  costUsd: number;
  tokens: Tokens;
  modelCalls: number;
  toolCalls: number;
  items: Item[];
}

export interface Child extends SessionSummary {
  costUsd: number;
  tokens: number;
  descendants: number;
}

export interface FileChange {
  path: string;
  edits: { ts: string; tool: string; old: string | null; new: string | null }[];
  added: number;
  removed: number;
}

export interface SessionDetail {
  session: SessionSummary;
  parent: SessionSummary | null;
  children: Child[];
  /** Cost and tokens of every session launched from here, at any depth. */
  childrenTotal: { sessions: number; costUsd: number; tokens: number };
  totals: Tokens & { costUsd: number; requests: number };
  byModel: (Tokens & { model: string; requests: number; costUsd: number })[];
  bySource: { source: string; requests: number; costUsd: number; tokens: number }[];
  time: {
    wallMs: number;
    workingMs: number;
    modelMs: number;
    toolMs: number;
    permissionMs: number;
    /** Claude Code's active-time metric: you typing (`user`) and the CLI working (`cli`). */
    activeUserMs: number;
    activeCliMs: number;
    slowestTools: { id: string | null; ts: string; name: string; label: string; durationMs: number; promptId: string | null }[];
    longestTurns: { promptId: string; ts: string; promptKind: PromptKind; promptLabel: string | null; durationMs: number }[];
  };
  turns: Turn[];
  changes: {
    linesAdded: number;
    linesRemoved: number;
    files: FileChange[];
    filesRead: number;
    commits: { ts: string; message: string | null; command: string }[];
    pullRequests: { ts: string; title: string | null; command: string }[];
    editDecisions: { accept: number; reject: number };
  };
}

interface EventRow {
  id: number;
  name: string;
  ts: string;
  prompt_id: string | null;
  attrs: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const parseJson = (s: unknown): Record<string, any> => {
  if (typeof s !== 'string') return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addTokens = (t: Tokens, a: Record<string, unknown>) => {
  t.input += num(a.input_tokens) ?? 0;
  t.output += num(a.output_tokens) ?? 0;
  t.cacheRead += num(a.cache_read_tokens) ?? 0;
  t.cacheWrite += num(a.cache_creation_tokens) ?? 0;
};
const tokenSum = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
const lines = (s: string | null) => (s ? s.split('\n').length : 0);

/** A tool call's input: Bash and search tools log `tool_parameters`, file tools `tool_input`. */
function toolInput(a: Record<string, unknown>): Record<string, any> {
  return { ...parseJson(a.tool_parameters), ...parseJson(a.tool_input) };
}

/** A short description of a tool call for the timeline. */
function toolLabel(name: string, p: Record<string, any>, rel: (path: string) => string): string {
  const first = (s: unknown) => (typeof s === 'string' ? s.split('\n')[0] : '');
  if (name === 'Bash') return first(p.description) || first(p.full_command) || first(p.command) || first(p.bash_command);
  const path = p.file_path ?? p.notebook_path ?? p.path;
  if (typeof path === 'string' && ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return rel(path);
  if (name === 'Grep' || name === 'Glob') return [p.pattern, p.path ? `in ${rel(p.path)}` : '', p.glob ? `(${p.glob})` : ''].filter(Boolean).join(' ');
  if (name === 'WebFetch') return first(p.url);
  if (name === 'WebSearch') return first(p.query);
  if (name === 'Agent' || name === 'Task') return first(p.description) || first(p.subagent_type);
  if (name === 'Skill') return first(p.skill);
  const s = Object.values(p).find((v) => typeof v === 'string');
  return first(s);
}

/**
 * The first line of the message in a `git commit` command: `-m "…"`, `-qm '…'`, `-m "$(cat <<'EOF' …)"`,
 * `-F - <<'EOF' …`.
 * Null when the message isn't in the command (an editor, `-F file`).
 */
function commitMessage(cmd: string): string | null {
  const at = cmd.search(COMMIT);
  const rest = at >= 0 ? cmd.slice(at) : cmd;
  const heredoc =
    rest.match(/\s-[A-Za-z]*m\s*"\$\(cat <<-?\s*'?(\w+)'?\n([\s\S]*?)\n\s*\1/) ?? // -m "$(cat <<'EOF' … EOF)"
    rest.match(/\s-[A-Za-z]*F\s*-\s*<<-?\s*'?(\w+)'?\n([\s\S]*?)\n\s*\1/); // -F - <<'EOF' … EOF
  const quoted = rest.match(/\s-[A-Za-z]*m\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|\$'((?:[^'\\]|\\.)*)')/);
  const msg = heredoc ? heredoc[2] : quoted ? (quoted[1] ?? quoted[2] ?? quoted[3] ?? '') : '';
  const first = msg.replace(/\\n/g, '\n').replace(/\\"/g, '"').split('\n').map((l) => l.trim()).find(Boolean);
  return first ?? null;
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|#39|amp);/g, (_m, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", amp: '&' })[e] ?? _m);

/** Claude Code injects background-task notifications and messages from other sessions as prompts. */
function describePrompt(text: string | null): { kind: PromptKind; label: string | null } {
  if (!text) return { kind: 'user', label: null };
  const t = text.trimStart();
  const tag = (name: string) => {
    const v = t.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
    return v ? unescapeXml(v) : null;
  };
  const short = (v: string) => (v.length > 200 ? v.slice(0, 197) + '…' : v);
  if (t.startsWith('<task-notification>')) {
    const summary = tag('summary');
    const status = tag('status');
    return { kind: 'task', label: short(summary ?? (status ? `Background task ${status}` : 'Background task')) };
  }
  if (t.startsWith('<cross-session-message') || t.startsWith('<agent-message')) {
    const from = t.match(/from="([^"]+)"/)?.[1];
    const body = unescapeXml(t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return { kind: 'message', label: short(`${from ? `From ${from}: ` : ''}${body}`) };
  }
  const first = t.split('\n').map((l) => l.replace(/^#+\s+/, '').trim()).find(Boolean) ?? null;
  return { kind: 'user', label: first && first.length > 200 ? first.slice(0, 197) + '…' : first };
}

/** `git commit` / `gh pr create` where a command starts (not merely mentioned inside a script or string). */
const COMMIT = /(?:^|[;&|(\n]\s*)git(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+commit\b/m;
const PR_CREATE = /(?:^|[;&|(\n]\s*)gh\s+pr\s+create\b/m;

type Category = 'permission' | 'tool' | 'model';
interface Interval {
  cat: Category;
  start: number;
  end: number;
  promptId: string | null;
}

/** A call that ended at `ts` after `durationMs`. */
function pushInterval(out: Interval[], cat: Category, ts: string, durationMs: number | null, promptId: string | null): void {
  const end = Date.parse(ts);
  if (!durationMs || durationMs <= 0 || !Number.isFinite(end)) return;
  out.push({ cat, start: end - durationMs, end, promptId });
}

/**
 * How long something was running, and what: a sweep over the interval edges that gives each moment to
 * the highest-priority category running then (permission wait, then tool, then model).
 */
function busyTime(intervals: Interval[]): { total: number; permission: number; tool: number; model: number } {
  const out = { total: 0, permission: 0, tool: 0, model: 0 };
  const edges: [number, Category, 1 | -1][] = [];
  for (const x of intervals) if (x.end > x.start) edges.push([x.start, x.cat, 1], [x.end, x.cat, -1]);
  edges.sort((a, b) => a[0] - b[0]);
  const open: Record<Category, number> = { permission: 0, tool: 0, model: 0 };
  let at = edges.length ? edges[0][0] : 0;
  for (const [t, cat, d] of edges) {
    const span = t - at;
    if (span > 0) {
      const top: Category | null = open.permission > 0 ? 'permission' : open.tool > 0 ? 'tool' : open.model > 0 ? 'model' : null;
      if (top) {
        out[top] += span;
        out.total += span;
      }
    }
    open[cat] += d;
    at = t;
  }
  return out;
}

export function sessionDetail(db: TelemetryDb, id: string): SessionDetail | null {
  const all = listSessions(db, { hidden: true });
  const session = all.find((s) => s.id === id);
  if (!session) return null;
  const homeFolder = session.folder;
  const rel = (p: string) => {
    const full = p.replace(/^\/(?:Users|home)\/[^/]+/, '~');
    return homeFolder && full.startsWith(homeFolder + '/') ? full.slice(homeFolder.length + 1) : full;
  };

  // --- children ---------------------------------------------------------------------------------
  const kids = new Map<string, SessionSummary[]>();
  // The dashboard's own sessions (chats, lab runs) are never counted as launched by the session.
  for (const s of all) if (s.parentId && !s.internal) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const descendantsOf = (sid: string): string[] => (kids.get(sid) ?? []).flatMap((c) => [c.id, ...descendantsOf(c.id)]);
  const family = descendantsOf(id);
  const costs = new Map<string, { cost: number; tokens: number }>();
  if (family.length) {
    const rows = db.raw
      .prepare(
        `SELECT session_id, sum(json_extract(attrs, '$.cost_usd')) AS cost,
                sum(coalesce(json_extract(attrs, '$.input_tokens'), 0) + coalesce(json_extract(attrs, '$.output_tokens'), 0)
                  + coalesce(json_extract(attrs, '$.cache_read_tokens'), 0) + coalesce(json_extract(attrs, '$.cache_creation_tokens'), 0)) AS tokens
         FROM events WHERE name = 'api_request' AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id`,
      )
      .all(JSON.stringify(family)) as { session_id: string; cost: number | null; tokens: number | null }[];
    for (const r of rows) costs.set(r.session_id, { cost: r.cost ?? 0, tokens: r.tokens ?? 0 });
  }
  const subtree = (sid: string) => [sid, ...descendantsOf(sid)].reduce((t, x) => ({ cost: t.cost + (costs.get(x)?.cost ?? 0), tokens: t.tokens + (costs.get(x)?.tokens ?? 0) }), { cost: 0, tokens: 0 });
  const children: Child[] = (kids.get(id) ?? [])
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    .map((c) => {
      const t = subtree(c.id);
      return { ...c, costUsd: t.cost, tokens: t.tokens, descendants: descendantsOf(c.id).length };
    });
  const childrenTotal = family.reduce((t, x) => ({ sessions: t.sessions + 1, costUsd: t.costUsd + (costs.get(x)?.cost ?? 0), tokens: t.tokens + (costs.get(x)?.tokens ?? 0) }), { sessions: 0, costUsd: 0, tokens: 0 });

  // --- events -----------------------------------------------------------------------------------
  const events = db.raw
    .prepare(
      `SELECT id, name, ts, prompt_id, attrs FROM events
       WHERE session_id = ? AND name IN ('user_prompt', 'assistant_response', 'tool_result', 'api_request', 'api_error',
         'compaction', 'skill_activated', 'subagent_completed', 'permission_mode_changed')
       ORDER BY ts, seq, id`,
    )
    .all(id) as EventRow[];

  const toolsWithOutput = new Set(
    (db.raw.prepare(`SELECT tool_use_id FROM spans WHERE session_id = ? AND output IS NOT NULL AND tool_use_id IS NOT NULL`).all(id) as { tool_use_id: string }[]).map((r) => r.tool_use_id),
  );

  const totals = { ...emptyTokens(), costUsd: 0, requests: 0 };
  const byModel = new Map<string, Tokens & { model: string; requests: number; costUsd: number }>();
  const bySource = new Map<string, { source: string; requests: number; costUsd: number; tokens: number }>();
  /** What was running when, for the time accounting (ms since the epoch). */
  const intervals: Interval[] = [];
  const allTools: SessionDetail['time']['slowestTools'] = [];
  const files = new Map<string, FileChange>();
  const read = new Set<string>();
  const commits: SessionDetail['changes']['commits'] = [];
  const pullRequests: SessionDetail['changes']['pullRequests'] = [];

  const turns = new Map<string, Turn & { last: string; agents: Map<string, Extract<Item, { kind: 'subagent' }>> }>();
  const turnFor = (e: EventRow) => {
    if (!e.prompt_id) return null;
    let t = turns.get(e.prompt_id);
    if (!t) {
      t = { promptId: e.prompt_id, ts: e.ts, prompt: null, promptKind: 'user', promptLabel: null, durationMs: 0, costUsd: 0, tokens: emptyTokens(), modelCalls: 0, toolCalls: 0, items: [], last: e.ts, agents: new Map() };
      turns.set(e.prompt_id, t);
    }
    const side = SIDE_SOURCES.has(String(parseJson(e.attrs).query_source ?? ''));
    if (!side && e.ts > t.last) t.last = e.ts;
    return t;
  };
  /** Subagent work goes into the subagent's group, created where its first event appears. */
  const push = (t: NonNullable<ReturnType<typeof turnFor>>, agentId: string | null, item: Item) => {
    if (!agentId) return void t.items.push(item);
    let g = t.agents.get(agentId);
    if (!g) {
      g = { kind: 'subagent', ts: item.ts, agentId, agentType: null, tokens: null, toolUses: null, durationMs: null, done: false, items: [] };
      t.agents.set(agentId, g);
      t.items.push(g);
    }
    g.items.push(item);
  };

  for (const e of events) {
    const a = parseJson(e.attrs);
    const agentId = str(a.agent_id);
    const t = turnFor(e);
    switch (e.name) {
      case 'user_prompt':
        if (t && !agentId) {
          t.prompt = cut(str(a.prompt) ?? str(a.prompt_text), 20_000);
          const p = describePrompt(t.prompt);
          t.promptKind = p.kind;
          t.promptLabel = p.label;
          if (e.ts < t.ts) t.ts = e.ts;
        }
        break;
      case 'assistant_response': {
        const text = str(a.response);
        if (t && text && !SIDE_SOURCES.has(String(a.query_source ?? ''))) push(t, agentId, { kind: 'response', ts: e.ts, text: cut(text, 20_000)! });
        break;
      }
      case 'api_request': {
        const cost = num(a.cost_usd) ?? 0;
        const source = String(a.query_source ?? 'unknown');
        const model = String(a.model ?? 'unknown');
        totals.costUsd += cost;
        totals.requests++;
        addTokens(totals, a);
        const m = byModel.get(model) ?? { model, requests: 0, costUsd: 0, ...emptyTokens() };
        m.requests++;
        m.costUsd += cost;
        addTokens(m, a);
        byModel.set(model, m);
        const tk = emptyTokens();
        addTokens(tk, a);
        const s = bySource.get(source) ?? { source, requests: 0, costUsd: 0, tokens: 0 };
        s.requests++;
        s.costUsd += cost;
        s.tokens += tokenSum(tk);
        bySource.set(source, s);
        if (!SIDE_SOURCES.has(source)) pushInterval(intervals, 'model', e.ts, num(a.duration_ms), e.prompt_id);
        if (t) {
          t.costUsd += cost;
          addTokens(t.tokens, a);
          if (!SIDE_SOURCES.has(source)) t.modelCalls++;
        }
        break;
      }
      case 'tool_result': {
        const name = String(a.tool_name ?? 'tool');
        const p = toolInput(a);
        const label = toolLabel(name, p, rel);
        const durationMs = num(a.duration_ms);
        const success = String(a.success) !== 'false';
        const toolUseId = str(a.tool_use_id);
        if (name !== 'Agent' && name !== 'Task') pushInterval(intervals, 'tool', e.ts, durationMs, e.prompt_id);
        if (durationMs != null) allTools.push({ id: toolUseId, ts: e.ts, name, label, durationMs, promptId: e.prompt_id });
        if (t) {
          t.toolCalls++;
          const inputText = name === 'Bash' ? str(p.full_command) ?? str(p.command) : Object.keys(p).length ? JSON.stringify(p, null, 2) : null;
          push(t, agentId, { kind: 'tool', ts: e.ts, id: toolUseId, name, label, input: cut(inputText), success, durationMs, hasOutput: !!toolUseId && toolsWithOutput.has(toolUseId) });
        }
        // What changed
        const path = str(p.file_path) ?? str(p.notebook_path);
        if (success && path && name === 'Read') read.add(path);
        if (success && path && EDIT_TOOLS.has(name)) {
          const key = rel(path);
          const f = files.get(key) ?? { path: key, edits: [], added: 0, removed: 0 };
          const pairs: { old: string | null; new: string | null }[] =
            name === 'MultiEdit' && Array.isArray(p.edits)
              ? p.edits.map((x: any) => ({ old: str(x?.old_string), new: str(x?.new_string) }))
              : name === 'Write'
                ? [{ old: null, new: str(p.content) }]
                : [{ old: str(p.old_string), new: str(p.new_string) ?? str(p.new_source) }];
          for (const x of pairs) {
            f.edits.push({ ts: e.ts, tool: name, old: cut(x.old), new: cut(x.new) });
            if (name !== 'Write') {
              f.added += lines(x.new);
              f.removed += lines(x.old);
            }
          }
          files.set(key, f);
        }
        if (success && name === 'Bash') {
          const cmd = str(p.full_command) ?? str(p.command) ?? '';
          if (COMMIT.test(cmd)) commits.push({ ts: e.ts, message: commitMessage(cmd), command: cut(cmd, 2000)! });
          if (PR_CREATE.test(cmd)) {
            const title = cmd.match(/--title\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
            pullRequests.push({ ts: e.ts, title: title ? (title[1] ?? title[2]) : null, command: cut(cmd, 2000)! });
          }
        }
        break;
      }
      case 'subagent_completed': {
        if (!t) break;
        const aid = agentId ?? `agent-${e.id}`;
        let g = t.agents.get(aid);
        if (!g) {
          g = { kind: 'subagent', ts: e.ts, agentId: aid, agentType: null, tokens: null, toolUses: null, durationMs: null, done: false, items: [] };
          t.agents.set(aid, g);
          t.items.push(g);
        }
        Object.assign(g, { agentType: str(a.agent_type), tokens: num(a.total_tokens), toolUses: num(a.total_tool_uses), durationMs: num(a.duration_ms), done: true });
        break;
      }
      case 'api_error':
        if (t) push(t, agentId, { kind: 'error', ts: e.ts, text: [str(a.error), num(a.attempt) ? `attempt ${a.attempt}` : null].filter(Boolean).join(' · ') });
        break;
      case 'compaction':
        if (t) push(t, null, { kind: 'compaction', ts: e.ts, trigger: str(a.trigger), preTokens: num(a.pre_tokens), postTokens: num(a.post_tokens), durationMs: num(a.duration_ms) });
        break;
      case 'skill_activated':
        if (t) push(t, agentId, { kind: 'skill', ts: e.ts, name: String(a['skill.name'] ?? 'skill') });
        break;
      case 'permission_mode_changed':
        if (t) push(t, null, { kind: 'mode', ts: e.ts, from: str(a.from_mode), to: str(a.to_mode) });
        break;
    }
  }

  // --- time: permission waits, then each turn's busy time over its own calls ------------------------
  const blocked = db.raw
    .prepare(`SELECT start_ts, end_ts FROM spans WHERE session_id = ? AND name = 'claude_code.tool.blocked_on_user' AND start_ts IS NOT NULL AND end_ts IS NOT NULL`)
    .all(id) as { start_ts: string; end_ts: string }[];
  for (const b of blocked) intervals.push({ cat: 'permission', start: Date.parse(b.start_ts), end: Date.parse(b.end_ts), promptId: null });
  const turnList = [...turns.values()].filter((t) => t.prompt != null || t.items.length > 0).sort((a, b) => a.ts.localeCompare(b.ts));
  turnList.forEach((t, i) => {
    // Permission spans carry no prompt id: they belong to the turn they fall in.
    const from = Date.parse(t.ts);
    const to = i + 1 < turnList.length ? Date.parse(turnList[i + 1].ts) : Infinity;
    const own = intervals.filter((x) => (x.promptId ? x.promptId === t.promptId : x.start >= from && x.start < to));
    t.durationMs = busyTime(own).total;
  });
  const busy = busyTime(intervals);
  const active = db.raw
    .prepare(`SELECT json_extract(attrs, '$.type') AS type, sum(value) AS v FROM metrics WHERE session_id = ? AND name = 'claude_code.active_time.total' GROUP BY type`)
    .all(id) as { type: string; v: number }[];
  const metric = (name: string, key: string, value: string) =>
    (db.raw.prepare(`SELECT coalesce(sum(value), 0) AS v FROM metrics WHERE session_id = ? AND name = ? AND json_extract(attrs, ?) = ?`).get(id, name, `$.${key}`, value) as { v: number }).v;

  const wallMs = session.start && session.end ? Date.parse(session.end) - Date.parse(session.start) : 0;

  return {
    session,
    parent: session.parentId ? (all.find((s) => s.id === session.parentId) ?? null) : null,
    children,
    childrenTotal,
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    bySource: [...bySource.values()].sort((a, b) => b.costUsd - a.costUsd),
    time: {
      wallMs,
      workingMs: busy.total,
      modelMs: busy.model,
      toolMs: busy.tool,
      permissionMs: busy.permission,
      activeUserMs: (active.find((r) => r.type === 'user')?.v ?? 0) * 1000,
      activeCliMs: (active.find((r) => r.type === 'cli')?.v ?? 0) * 1000,
      slowestTools: allTools.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
      longestTurns: [...turnList]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10)
        .map((t) => ({ promptId: t.promptId, ts: t.ts, promptKind: t.promptKind, promptLabel: t.promptLabel, durationMs: t.durationMs })),
    },
    turns: turnList.map(({ last: _last, agents: _agents, ...t }) => t),
    changes: {
      linesAdded: metric('claude_code.lines_of_code.count', 'type', 'added'),
      linesRemoved: metric('claude_code.lines_of_code.count', 'type', 'removed'),
      files: [...files.values()].sort((a, b) => b.edits.length - a.edits.length || a.path.localeCompare(b.path)),
      filesRead: read.size,
      commits,
      pullRequests,
      editDecisions: {
        accept: metric('claude_code.code_edit_tool.decision', 'decision', 'accept'),
        reject: metric('claude_code.code_edit_tool.decision', 'decision', 'reject'),
      },
    },
  };
}

/** A tool call's full output (scrubbed when stored), or null. */
export function toolOutput(db: TelemetryDb, toolUseId: string): string | null {
  const r = db.raw.prepare('SELECT output FROM spans WHERE tool_use_id = ? AND output IS NOT NULL LIMIT 1').get(toolUseId) as { output: string } | undefined;
  return r?.output ?? null;
}
