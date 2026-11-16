import * as f from '../format';
import { summarize } from '../stats';
import { href, useLab } from '../store';
import { Ago, CriteriaBar, SessionStatus } from '../components/ui';

export function Sessions() {
  const { sessions, tasks } = useLab();
  const suite = tasks.filter((t) => t.approved && !t.heldOut).length;
  return (
    <main className="page">
      <div className="page-head">
        <h1>Sessions</h1>
        <p className="dim">
          Each session runs the current skills on the {suite === 1 ? 'task' : `${suite} tasks`} in the suite, then proposes and tests changes to the skill files.
        </p>
      </div>
      {!sessions.length ? (
        <p className="empty">
          No sessions yet. Start one with <code>npm run lab -- session</code>.
        </p>
      ) : (
        <table className="table sessions">
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Profile</th>
              <th>Skills</th>
              <th className="r">Runs</th>
              <th className="r">Suggestions</th>
              <th className="r">Criteria</th>
              <th className="r">Avg tokens</th>
              <th className="r">Avg cost</th>
              <th className="r">Avg time</th>
              <th className="r">Created</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const sum = summarize(s.runs, tasks);
              const accepted = s.suggestions.filter((g) => g.status === 'accepted').length;
              const toReview = s.suggestions.filter((g) => g.status === 'tested').length;
              return (
                <tr key={s.id} className="link" onClick={() => (location.hash = href.session(s.id))}>
                  <td>
                    <a className="mono strong" href={href.session(s.id)} onClick={(e) => e.stopPropagation()}>
                      {s.id}
                    </a>
                  </td>
                  <td>
                    <SessionStatus status={s.status} />
                  </td>
                  <td>
                    <a className="dim" href={href.repo()} onClick={(e) => e.stopPropagation()}>
                      {s.profileVersion ? `v${s.profileVersion}` : '—'}
                    </a>
                  </td>
                  <td className="dim">{s.skillsVersion}</td>
                  <td className="r">
                    <span className="num">
                      {sum.done}/{sum.runs}
                    </span>
                    {sum.errors > 0 && <span className="bad-text small"> · {sum.errors} failed</span>}
                  </td>
                  <td className="r">
                    <span className="num">{s.suggestions.length}</span>
                    {accepted > 0 && <span className="dim"> · {accepted} accepted</span>}
                    {toReview > 0 && <span className="review"> · {toReview} to review</span>}
                  </td>
                  <td className="r">{sum.done ? <CriteriaBar met={sum.criteriaMet} total={sum.criteriaTotal} asPct /> : <span className="dim">—</span>}</td>
                  <td className="r num">{f.tokens(sum.tokens)}</td>
                  <td className="r num">{f.usd(sum.costUsd)}</td>
                  <td className="r num">{f.duration(sum.durationMs)}</td>
                  <td className="r dim">
                    <Ago iso={s.createdAt} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
