import * as f from '../format';
import { REPO } from '../mock';
import { summarize } from '../stats';
import { href, useSessions } from '../store';
import { Ago, CriteriaBar, SessionStatus } from '../components/ui';

export function Sessions() {
  const sessions = useSessions();
  return (
    <main className="page">
      <div className="page-head">
        <h1>Sessions</h1>
        <p className="dim">
          Each session runs the current skills on {REPO.tasks.filter((t) => !t.heldOut).length} tasks, then proposes and tests changes to the skill files.
        </p>
      </div>
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
            const sum = summarize(s.runs, REPO.tasks);
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
                    v{s.profileVersion}
                  </a>
                </td>
                <td className="dim">{s.skillsVersion}</td>
                <td className="r num">{sum.runs}</td>
                <td className="r">
                  <span className="num">{s.suggestions.length}</span>
                  {accepted > 0 && <span className="dim"> · {accepted} accepted</span>}
                  {toReview > 0 && <span className="review"> · {toReview} to review</span>}
                </td>
                <td className="r">
                  <CriteriaBar met={sum.criteriaMet} total={sum.criteriaTotal} asPct />
                </td>
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
    </main>
  );
}
