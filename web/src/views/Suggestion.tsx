import type { ReactNode } from 'react';
import * as f from '../format';
import { REPO } from '../mock';
import { relChange, summarize, type Summary } from '../stats';
import { decide, href, useSessions } from '../store';
import { Ago, CriteriaBar, Delta, Diff, Metrics, RunsTable, SuggestionStatusBadge, summaryMetrics } from '../components/ui';
import { NotFound } from './Session';
import type { Run } from '../types';

export function Suggestion({ id, sid }: { id: string; sid: string }) {
  const session = useSessions().find((s) => s.id === id);
  const g = session?.suggestions.find((x) => x.id === sid);
  if (!session || !g) return <NotFound what="Suggestion" />;
  const base = summarize(session.runs, REPO.tasks);
  const sum = summarize(g.runs, REPO.tasks);
  const decided = g.status === 'accepted' || g.status === 'rejected';
  return (
    <main className="page">
      <nav className="crumbs">
        <a href={href.sessions()}>Sessions</a> <span>/</span> <a className="mono" href={href.session(session.id)}>{session.id}</a> <span>/</span> <span>Suggestion</span>
      </nav>
      <div className="page-head row">
        <h1>{g.title}</h1>
        <SuggestionStatusBadge status={g.status} />
      </div>
      <div className="decision">
        <span className="dim">
          Proposed <Ago iso={g.createdAt} /> from {base.done} runs of {session.id}
        </span>
        <span className="spacer" />
        {g.status === 'tested' && (
          <>
            <button className="btn btn-primary" onClick={() => decide(session.id, g.id, 'accepted')}>
              Accept change
            </button>
            <button className="btn" onClick={() => decide(session.id, g.id, 'rejected')}>
              Reject
            </button>
          </>
        )}
        {decided && (
          <>
            <span className="dim small">{g.status === 'accepted' ? 'Applied to the skills for the next session.' : 'Not applied.'}</span>
            <button className="btn" onClick={() => decide(session.id, g.id, 'tested')}>
              Undo
            </button>
          </>
        )}
        {(g.status === 'proposed' || g.status === 'testing') && <span className="dim small">You can accept or reject once its runs finish.</span>}
      </div>

      <section className="block">
        <h2>What it changes</h2>
        <p className="prose">{g.description}</p>
        <Diff file={g.file} diff={g.diff} />
      </section>

      <section className="block">
        <h2>Result</h2>
        {sum.done ? (
          <>
            <Metrics items={summaryMetrics(sum, base)} />
            <Compare base={base} sum={sum} />
            <PerTask sessionRuns={session.runs} suggestionRuns={g.runs} />
          </>
        ) : (
          <p className="empty">{g.status === 'proposed' ? 'Not tested yet.' : 'Runs in progress; results appear as they finish.'}</p>
        )}
      </section>

      <section className="block">
        <h2>Runs</h2>
        <p className="dim small">The same tasks as the session, with this change applied. Click a run for its acceptance criteria.</p>
        <RunsTable runs={g.runs} tasks={REPO.tasks} />
      </section>
    </main>
  );
}

function Compare({ base, sum }: { base: Summary; sum: Summary }) {
  const rows: [string, string, string, ReactNode][] = [
    ['Acceptance criteria', f.pct(base.criteria), f.pct(sum.criteria), <Delta value={sum.criteria !== null && base.criteria !== null ? sum.criteria - base.criteria : null} kind="pts" />],
    ['Avg tokens', f.tokens(base.tokens), f.tokens(sum.tokens), <Delta value={relChange(base.tokens, sum.tokens)} kind="rel" lowerIsBetter />],
    ['Avg cost', f.usd(base.costUsd), f.usd(sum.costUsd), <Delta value={relChange(base.costUsd, sum.costUsd)} kind="rel" lowerIsBetter />],
    ['Avg time', f.duration(base.durationMs), f.duration(sum.durationMs), <Delta value={relChange(base.durationMs, sum.durationMs)} kind="rel" lowerIsBetter />],
    ['Runs', String(base.done), String(sum.done), ''],
  ];
  return (
    <table className="table compare">
      <thead>
        <tr>
          <th />
          <th className="r">Session (current skills)</th>
          <th className="r">With this change</th>
          <th className="r">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, a, b, d]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="r num">{a}</td>
            <td className="r num strong">{b}</td>
            <td className="r">{d}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Per task: criteria and tokens, session vs this change, so a gain on one kind of task can't hide a loss on another. */
function PerTask({ sessionRuns, suggestionRuns }: { sessionRuns: Run[]; suggestionRuns: Run[] }) {
  return (
    <table className="table pertask">
      <thead>
        <tr>
          <th>Task</th>
          <th className="r">Criteria before → after</th>
          <th className="r">Tokens before → after</th>
          <th className="r">Change</th>
        </tr>
      </thead>
      <tbody>
        {REPO.tasks.map((t) => {
          const a = summarize(sessionRuns.filter((r) => r.taskId === t.id), REPO.tasks);
          const b = summarize(suggestionRuns.filter((r) => r.taskId === t.id), REPO.tasks);
          return (
            <tr key={t.id}>
              <td>
                <span className={`kind kind-${t.kind}`}>{t.kind}</span> {t.title}
              </td>
              <td className="r">
                <span className="pair">
                  <CriteriaBar met={a.criteriaMet} total={a.criteriaTotal} asPct /> <span className="dim">→</span> <CriteriaBar met={b.criteriaMet} total={b.criteriaTotal} asPct />
                </span>
              </td>
              <td className="r num">
                {f.tokens(a.tokens)} <span className="dim">→</span> {f.tokens(b.tokens)}
              </td>
              <td className="r">
                <Delta value={b.criteria !== null && a.criteria !== null ? b.criteria - a.criteria : null} kind="pts" /> · <Delta value={relChange(a.tokens, b.tokens)} kind="rel" lowerIsBetter />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
