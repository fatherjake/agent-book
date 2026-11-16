import { REPO } from '../mock';
import { relChange, summarize } from '../stats';
import { decide, href, useSessions } from '../store';
import type { Session as SessionT, Suggestion } from '../types';
import { Ago, Delta, Metrics, RunsTable, SessionStatus, SuggestionStatusBadge, summaryMetrics } from '../components/ui';

export function Session({ id }: { id: string }) {
  const session = useSessions().find((s) => s.id === id);
  if (!session) return <NotFound what={`Session ${id}`} />;
  const sum = summarize(session.runs, REPO.tasks);
  return (
    <main className="page">
      <nav className="crumbs">
        <a href={href.sessions()}>Sessions</a> <span>/</span> <span className="mono">{session.id}</span>
      </nav>
      <div className="page-head row">
        <h1 className="mono">{session.id}</h1>
        <SessionStatus status={session.status} />
        <span className="dim">
          {session.skillsVersion} · started <Ago iso={session.createdAt} />
        </span>
      </div>
      <Metrics items={summaryMetrics(sum)} />
      <div className="panes">
        <section className="pane">
          <div className="pane-head">
            <h2>Runs</h2>
            <span className="dim small">The current skills on every task. Click a run for its acceptance criteria.</span>
          </div>
          <RunsTable runs={session.runs} tasks={REPO.tasks} />
        </section>
        <section className="pane">
          <div className="pane-head">
            <h2>Suggestions</h2>
            <span className="dim small">Proposed from these runs; each is tested on the same tasks.</span>
          </div>
          <div className="cards">
            {session.suggestions.map((g) => (
              <SuggestionCard key={g.id} session={session} suggestion={g} />
            ))}
            {!session.suggestions.length && <p className="empty">No suggestions yet: the runs are still being analysed.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}

function SuggestionCard({ session, suggestion: g }: { session: SessionT; suggestion: Suggestion }) {
  const base = summarize(session.runs, REPO.tasks);
  const sum = summarize(g.runs, REPO.tasks);
  const hasData = sum.done > 0;
  return (
    <article className="card" onClick={() => (location.hash = href.suggestion(session.id, g.id))}>
      <div className="card-top">
        <a className="card-title" href={href.suggestion(session.id, g.id)} onClick={(e) => e.stopPropagation()}>
          {g.title}
        </a>
        <SuggestionStatusBadge status={g.status} />
      </div>
      <p className="card-desc">{g.description}</p>
      <div className="card-foot">
        <span className="mono dim small">{g.file.split('/').slice(-2).join('/')}</span>
        {hasData ? (
          <span className="card-deltas">
            <span>
              criteria <Delta value={sum.criteria !== null && base.criteria !== null ? sum.criteria - base.criteria : null} kind="pts" />
            </span>
            <span>
              tokens <Delta value={relChange(base.tokens, sum.tokens)} kind="rel" lowerIsBetter />
            </span>
            <span>
              time <Delta value={relChange(base.durationMs, sum.durationMs)} kind="rel" lowerIsBetter />
            </span>
            <span className="dim">{sum.done} runs{sum.running ? ` · ${sum.running} running` : ''}</span>
          </span>
        ) : (
          <span className="dim small">{g.status === 'proposed' ? 'Not tested yet' : 'Waiting for runs'}</span>
        )}
      </div>
      {g.status === 'tested' && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-primary" onClick={() => decide(session.id, g.id, 'accepted')}>
            Accept
          </button>
          <button className="btn" onClick={() => decide(session.id, g.id, 'rejected')}>
            Reject
          </button>
        </div>
      )}
    </article>
  );
}

export function NotFound({ what }: { what: string }) {
  return (
    <main className="page">
      <nav className="crumbs">
        <a href={href.sessions()}>Sessions</a>
      </nav>
      <p className="empty">{what} not found.</p>
    </main>
  );
}
