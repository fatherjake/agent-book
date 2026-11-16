import type { ReactNode } from 'react';
import * as f from '../format';
import { paired, relChange, summarize, type Interval, type Paired, type Summary } from '../stats';
import { decide, href, useLab } from '../store';
import { Ago, CriteriaBar, Delta, Diff, Metrics, RunsTable, SuggestionStatusBadge, summaryMetrics } from '../components/ui';
import { NotFound } from './Session';
import type { Run, Task } from '../types';

export function Suggestion({ id, sid }: { id: string; sid: string }) {
  const { sessions, tasks } = useLab();
  const session = sessions.find((s) => s.id === id);
  const g = session?.suggestions.find((x) => x.id === sid);
  if (!session || !g) return <NotFound what="Suggestion" />;
  const base = summarize(session.runs, tasks);
  const sum = summarize(g.runs, tasks);
  const pr = paired(session.runs, g.runs, tasks);
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
            <button className="btn btn-primary" onClick={() => decide(g.id, 'accepted')}>
              Accept change
            </button>
            <button className="btn" onClick={() => decide(g.id, 'rejected')}>
              Reject
            </button>
          </>
        )}
        {decided && (
          <>
            <span className="dim small">{g.status === 'accepted' ? 'Applied to the skills for the next session.' : 'Not applied.'}</span>
            <button className="btn" onClick={() => decide(g.id, 'tested')}>
              Undo
            </button>
          </>
        )}
        {(g.status === 'proposed' || g.status === 'testing') && <span className="dim small">You can accept or reject once its runs finish.</span>}
      </div>

      <section className="block">
        <h2>What it changes</h2>
        <p className="prose">{g.description}</p>
        {g.evidence && (
          <details className="evidence">
            <summary>Evidence from the session's runs</summary>
            <p className="prose">{g.evidence}</p>
          </details>
        )}
        <Diff file={g.file} diff={g.diff} />
      </section>

      <section className="block">
        <h2>Result</h2>
        {sum.done ? (
          <>
            <Metrics items={summaryMetrics(sum, base, pr)} />
            <Compare base={base} sum={sum} pr={pr} />
            <PerTask sessionRuns={session.runs} suggestionRuns={g.runs} tasks={tasks} />
          </>
        ) : (
          <p className="empty">{g.status === 'proposed' ? 'Not tested yet.' : 'Runs in progress; results appear as they finish.'}</p>
        )}
      </section>

      <section className="block">
        <h2>Runs</h2>
        <p className="dim small">The same tasks as the session, with this change applied. Click a run for its acceptance criteria.</p>
        <RunsTable runs={g.runs} tasks={tasks} />
      </section>
    </main>
  );
}

function rangeText(iv: Interval | null, kind: 'rel' | 'pts'): string {
  if (!iv) return '—';
  if (!Number.isFinite(iv.lo)) return 'one pair: no range';
  const f = (v: number) => (kind === 'rel' ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}`);
  return `${f(iv.lo)} to ${f(iv.hi)}${kind === 'pts' ? ' pts' : ''}`;
}

function Compare({ base, sum, pr }: { base: Summary; sum: Summary; pr: Paired }) {
  const rows: [string, string, string, ReactNode, string][] = [
    ['Acceptance criteria', f.pct(base.criteria), f.pct(sum.criteria), <Delta value={sum.criteria !== null && base.criteria !== null ? sum.criteria - base.criteria : null} kind="pts" interval={pr.criteria} />, rangeText(pr.criteria, 'pts')],
    ['Avg tokens', f.tokens(base.tokens), f.tokens(sum.tokens), <Delta value={relChange(base.tokens, sum.tokens)} kind="rel" lowerIsBetter interval={pr.tokens} />, rangeText(pr.tokens, 'rel')],
    ['Avg cost', f.usd(base.costUsd), f.usd(sum.costUsd), <Delta value={relChange(base.costUsd, sum.costUsd)} kind="rel" lowerIsBetter interval={pr.tokens} />, ''],
    ['Avg time', f.duration(base.durationMs), f.duration(sum.durationMs), <Delta value={relChange(base.durationMs, sum.durationMs)} kind="rel" lowerIsBetter interval={pr.time} />, rangeText(pr.time, 'rel')],
    ['Runs', String(base.done), String(sum.done), '', `${pr.pairs} pairs`],
  ];
  const anyClear = [pr.criteria, pr.tokens].some((iv) => iv && !iv.inconclusive);
  return (
    <>
      <table className="table compare">
        <thead>
          <tr>
            <th />
            <th className="r">Session (current skills)</th>
            <th className="r">With this change</th>
            <th className="r">Change</th>
            <th className="r">95% range, paired</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b, d, range]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className="r num">{a}</td>
              <td className="r num strong">{b}</td>
              <td className="r">{d}</td>
              <td className="r dim small">{range}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!anyClear && (
        <p className="dim small noise-note">
          ~ Within noise: with {pr.pairs} paired runs the 95% ranges include zero, so these differences could be luck. More runs would settle it.
        </p>
      )}
    </>
  );
}

/** Per task: criteria and tokens, session vs this change, so a gain on one kind of task can't hide a loss on another. */
function PerTask({ sessionRuns, suggestionRuns, tasks }: { sessionRuns: Run[]; suggestionRuns: Run[]; tasks: Task[] }) {
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
        {tasks.filter((t) => sessionRuns.some((r) => r.taskId === t.id) || suggestionRuns.some((r) => r.taskId === t.id)).map((t) => {
          const a = summarize(sessionRuns.filter((r) => r.taskId === t.id), tasks);
          const b = summarize(suggestionRuns.filter((r) => r.taskId === t.id), tasks);
          const tp = paired(sessionRuns.filter((r) => r.taskId === t.id), suggestionRuns.filter((r) => r.taskId === t.id), tasks);
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
                <Delta value={b.criteria !== null && a.criteria !== null ? b.criteria - a.criteria : null} kind="pts" interval={tp.criteria} /> · <Delta value={relChange(a.tokens, b.tokens)} kind="rel" lowerIsBetter interval={tp.tokens} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
