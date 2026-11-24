import { useEffect, useMemo, useRef } from 'react';
import type { SessionSummary } from '../../server/src/sessions';
import { formatAgo, formatDur, formatUsd } from './format';
import { titleOf, toHash, type Tab } from './view';

interface Node {
  s: SessionSummary;
  children: Node[];
  /** Latest activity in this session or any session it launched. */
  lastActive: string;
  has(id: string): boolean;
}

/**
 * Sessions nested under the session that launched them; roots newest first, children oldest first.
 * Sessions that never called the model (0 tokens) are left out, unless they launched sessions that did.
 */
function buildTree(all: SessionSummary[]): Node[] {
  const parents = new Set(all.map((s) => s.parentId).filter(Boolean));
  const sessions = all.filter((s) => s.tokens > 0 || parents.has(s.id));
  const ids = new Set(sessions.map((s) => s.id));
  const kids = new Map<string, SessionSummary[]>();
  for (const s of sessions) if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const node = (s: SessionSummary): Node => {
    const children = (kids.get(s.id) ?? []).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')).map(node);
    return {
      s,
      children,
      lastActive: [s.end ?? '', ...children.map((c) => c.lastActive)].reduce((a, b) => (b > a ? b : a), ''),
      has: (id) => s.id === id || children.some((c) => c.has(id)),
    };
  };
  return sessions
    .filter((s) => !s.parentId || !ids.has(s.parentId))
    .map(node)
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

/** The suggestions lab's status as a small coloured pill (nothing for sessions never analysed). */
function LabPill({ s }: { s: SessionSummary }) {
  const l = s.lab;
  if (!l || l.status === 'failed') return null;
  const [cls, text, title] =
    l.status === 'analysing'
      ? ['analysing', 'analysing', 'The analysis is running']
      : l.status === 'testing'
        ? ['testing', 'testing', 'Suggestions are being evaluated']
        : l.open
          ? ['open', `${l.open} open`, `${l.open} of ${l.suggestions} suggestion${l.suggestions === 1 ? '' : 's'} not yet accepted or rejected${l.untested ? `; ${l.untested} not yet run` : ''}`]
          : l.accepted
            ? ['done', `${l.accepted} accepted`, `All ${l.suggestions} suggestions decided: ${l.accepted} accepted`]
            : ['done', 'analysed', l.suggestions ? 'All suggestions rejected' : 'Analysed: no suggestions'];
  return (
    <span className={`pill pill-${cls}`} title={title}>
      {text}
    </span>
  );
}

const folderName = (f: string | null) => (f ? f.replace(/\/+$/, '').split('/').pop() || f : '—');

export function Sidebar({ sessions, error, selected, tab }: { sessions: SessionSummary[] | null; error: string | null; selected: string | null; tab: Tab }) {
  const tree = useMemo(() => buildTree(sessions ?? []), [sessions]);
  return (
    <aside className="sidebar panel">
      <div className="panel-head">
        <span>Sessions</span>
        {sessions && <span className="dim">{tree.length}</span>}
      </div>
      <div className="scroll">
        {error && <p className="pad error">Couldn't load sessions: {error}</p>}
        {!sessions && !error && <p className="pad dim">Loading…</p>}
        {sessions?.length === 0 && <p className="pad dim">No sessions yet. Run ./init.sh, then start a Claude Code session.</p>}
        <ol className="side-list">
          {tree.map((n) => (
            <SideRow key={n.s.id} node={n} selected={selected} tab={tab} />
          ))}
        </ol>
      </div>
    </aside>
  );
}

/**
 * One top-level session. Sessions it launched aren't listed here (they're on its Sessions tab); while one
 * of them is open, this row stays marked as the way back.
 */
function SideRow({ node, selected, tab }: { node: Node; selected: string | null; tab: Tab }) {
  const s = node.s;
  const isSel = s.id === selected;
  const holdsSel = !isSel && !!selected && node.has(selected);
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (isSel || holdsSel) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isSel, holdsSel]);
  return (
    <li>
      <a
        ref={ref}
        className={`side-row${isSel ? ' selected' : holdsSel ? ' ancestor' : ''}`}
        href={toHash({ id: s.id, tab, sel: null })}
        aria-current={isSel ? 'page' : undefined}
      >
        <span className="side-title">
          <span className="side-title-text">{titleOf(s)}</span>
          {s.headless && <span className="chip">headless</span>}
          <LabPill s={s} />
        </span>
        <span className="side-ago num" title={node.lastActive || s.end || undefined}>
          {formatAgo(node.lastActive || s.end)}
        </span>
        <span className="side-meta">
          <span className="side-folder">{folderName(s.folder)}</span>
          <span className="num">{formatUsd(s.costUsd)}</span>
          <span className="num">{s.start && s.end ? formatDur(Date.parse(s.end) - Date.parse(s.start)) : '—'}</span>
        </span>
      </a>
    </li>
  );
}
