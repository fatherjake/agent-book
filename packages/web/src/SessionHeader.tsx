/** The top panel: what the session is, and its headline numbers. */
import type { ReactNode } from 'react';
import type { SessionDetail } from '../../server/src/session-detail';
import { formatCount, formatDur, formatPercent, formatStamp, formatTokens, formatUsd } from './format';
import { titleOf, toHash } from './view';

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub != null && <div className="stat-sub num">{sub}</div>}
    </div>
  );
}

export function SessionHeader({ d }: { d: SessionDetail }) {
  const s = d.session;
  const t = d.totals;
  const tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const tools = d.turns.reduce((n, x) => n + x.toolCalls, 0);
  const c = d.changes;
  return (
    <header className="info panel">
      <div className="info-top">
        <div className="info-title">
          <h1>{titleOf(s)}</h1>
          {s.headless && <span className="chip">headless</span>}
        </div>
        <div className="info-meta">
          <span className="mono">{s.folder ?? 'unknown folder'}</span>
          {s.branch && <span className="mono dim">⎇ {s.branch}</span>}
          <span className="num">
            {formatStamp(s.start)} → {formatStamp(s.end)}
          </span>
        </div>
      </div>
      {(s.summary || d.parent) && (
        <div className="info-recap">
          {d.parent && (
            <span className="parent">
              ↳ launched from <a href={toHash({ id: d.parent.id, tab: 'sessions', sel: { kind: 'child', key: s.id } })}>{titleOf(d.parent)}</a>
              {s.parentLink === 'timing' && <span className="chip guess">timing</span>}
            </span>
          )}
          {s.summary && <span className="dim">{s.summary}</span>}
        </div>
      )}
      <div className="stats">
        <Stat label="Cost" value={formatUsd(t.costUsd)} sub={d.childrenTotal.sessions ? `+${formatUsd(d.childrenTotal.costUsd)} kids` : `${t.requests} calls`} />
        <Stat label="Tokens" value={formatTokens(tokens)} sub={`${formatPercent(t.cacheRead, tokens)} cached`} />
        <Stat label="Output" value={formatTokens(t.output)} sub={`${formatTokens(t.input)} in`} />
        <Stat label="Working" value={formatDur(d.time.workingMs)} sub={`of ${formatDur(d.time.wallMs)}`} />
        <Stat label="Model" value={formatPercent(d.time.modelMs, d.time.workingMs)} sub={`tools ${formatPercent(d.time.toolMs, d.time.workingMs)} · perm ${formatPercent(d.time.permissionMs, d.time.workingMs)}`} />
        <Stat label="Turns" value={d.turns.length} sub={`${s.prompts} prompts`} />
        <Stat label="Tool calls" value={formatCount(tools)} sub={`${formatTokens(tokens / Math.max(1, d.turns.length))} tok/turn`} />
        <Stat
          label="Lines"
          value={
            <>
              <span className="up">+{formatCount(c.linesAdded)}</span> <span className="down">−{formatCount(c.linesRemoved)}</span>
            </>
          }
          sub={`${c.files.length} files`}
        />
        <Stat label="Commits" value={c.commits.length} sub={c.pullRequests.length ? `${c.pullRequests.length} PRs` : '—'} />
        <Stat label="Launched" value={d.childrenTotal.sessions} sub={d.childrenTotal.sessions ? `${formatTokens(d.childrenTotal.tokens)} tok` : '—'} />
      </div>
    </header>
  );
}
