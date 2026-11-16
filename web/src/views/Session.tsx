import { paired, relChange, summarize } from '../stats';
import { decide, href, useLab } from '../store';
import type { Session as SessionT, Suggestion, Task } from '../types';
import { Ago, Delta, Metrics, RunsTable, SessionStatus, SuggestionStatusBadge, summaryMetrics } from '../components/ui';

export function Session({ id }: { id: string }) {
  const { sessions, tasks } = useLab();
  const session = sessions.find((s) => s.id === id);
  if (!session) return <NotFound what={`Session ${id}`} />;
  const sum = summarize(session.runs, tasks);
  return (
    <main className="page">
      <nav className="crumbs">
        <a href={href.sessions()}>Sessions</a> <span>/</span> <span className="mono">{session.id}</span>
      </nav>
      <div className="page-head row">
        <h1 className="mono">{session.id}</h1>
        <SessionStatus status={session.status} />
        {session.error && <span className="bad-text small">{session.error}</span>}
        <span className="dim">
          {session.skillsVersion} · <a href={href.repo()}>profile v{session.profileVersion}</a> · started <Ago iso={session.createdAt} />
        </span>
      </div>
      <Metrics items={summaryMetrics(sum)} />
      <div className="panes">
        <section className="pane">
          <div className="pane-head">
            <h2>Runs</h2>
            <span className="dim small">The current skills on every task. Click a run for its acceptance criteria.</span>
          </div>
          <RunsTable runs={session.runs} tasks={tasks} />
        </section>
        <section className="pane">
          <div className="pane-head">
            <h2>Suggestions</h2>
            <span className="dim small">Proposed from these runs; each is tested on the same tasks.</span>
          </div>
          <div className="cards">
            {session.suggestions.map((g) => (
              <SuggestionCard key={g.id} session={session} suggestion={g} tasks={tasks} />
            ))}
            {!session.suggestions.length && (
              <p className="empty">
                {session.status === 'running'
                  ? 'Suggestions are proposed once the runs finish.'
                  : session.status === 'analysing'
                    ? 'Analysing the runs…'
                    : 'No suggestions for this session.'}
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function SuggestionCard({ session, suggestion: g, tasks }: { session: SessionT; suggestion: Suggestion; tasks: Task[] }) {
  const base = summarize(session.runs, tasks);
  const sum = summarize(g.runs, tasks);
  const pr = paired(session.runs, g.runs, tasks);
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
        <span className="mono dim small">
          {g.file
            .split(', ')
            .map((x) => x.split('/').slice(-2).join('/'))
            .join(' · ')}
        </span>
        {hasData ? (
          <span className="card-deltas">
            <span>
              criteria <Delta value={sum.criteria !== null && base.criteria !== null ? sum.criteria - base.criteria : null} kind="pts" interval={pr.criteria} />
            </span>
            <span>
              tokens <Delta value={relChange(base.tokens, sum.tokens)} kind="rel" lowerIsBetter interval={pr.tokens} />
            </span>
            <span>
              time <Delta value={relChange(base.durationMs, sum.durationMs)} kind="rel" lowerIsBetter interval={pr.time} />
            </span>
            <span className="dim" title="Paired with the session's runs (same task, same seed). ~ = within noise.">
              {pr.pairs} paired runs{sum.pending ? ` · ${sum.pending} running` : ''}
            </span>
          </span>
        ) : (
          <span className="dim small">{g.status === 'proposed' ? 'Not tested yet' : 'Waiting for runs'}</span>
        )}
      </div>
      {g.status === 'tested' && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-primary" onClick={() => decide(g.id, 'accepted')}>
            Accept
          </button>
          <button className="btn" onClick={() => decide(g.id, 'rejected')}>
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
