import * as f from '../format';
import { approveTask, href, useLab } from '../store';
import type { RepoProfile, StepStatus, Task } from '../types';
import { Ago, Badge, KindTag, Metrics } from '../components/ui';

const STEP_MARK: Record<StepStatus, string> = { ok: '✓', warn: '!', fail: '✕', running: '…', pending: '·' };

export function Repo() {
  const { repo, profile, tasks } = useLab();
  if (!repo) return null;
  const suite = tasks.filter((t) => !t.heldOut);
  const held = tasks.filter((t) => t.heldOut);
  return (
    <main className="page">
      <nav className="crumbs">
        <a href={href.sessions()}>Sessions</a> <span>/</span> <span>Repo</span>
      </nav>
      <div className="page-head row">
        <h1>{repo.name}</h1>
        <a className="dim" href={repo.url} target="_blank" rel="noreferrer">
          {repo.url.replace('https://', '')}
        </a>
        <span className="mono dim">@ {repo.commit.slice(0, 7)}</span>
        {profile ? <Badge tone="good">Ready</Badge> : <Badge tone="live">Setup pending</Badge>}
        <span className="spacer" />
        {profile && (
          <span className="dim small">
            Profile v{profile.version} · evaluated <Ago iso={profile.evaluatedAt} />
          </span>
        )}
      </div>
      <p className="dim lead">
        Setup builds a sandbox where the repo's tests pass offline. Evaluation reads the repo the way a new engineer would and works out how
        its skills have to be invoked to fire, so every session tests the skills doing their job.
      </p>
      {profile ? (
        <ProfileSections profile={profile} suiteCount={suite.length} heldCount={held.length} />
      ) : (
        <div className="finding">
          <span className="finding-label">Setup has not run for this repo</span>
          Sessions use the built-in environment and activation recipe for now. Setup will record the verified environment, the instruction
          sources, the skill map and the measured activation recipe here.
        </div>
      )}

      <section className="block">
        <h2>Task suite</h2>
        <p className="dim small">Sessions run every approved task. Held-out tasks are never used to propose suggestions, only to confirm them.</p>
        <TaskTable tasks={suite} />
        {held.length > 0 && (
          <>
            <h3 className="subhead">Held out</h3>
            <TaskTable tasks={held} />
          </>
        )}
      </section>
    </main>
  );
}

function ProfileSections({ profile: p, suiteCount, heldCount }: { profile: RepoProfile; suiteCount: number; heldCount: number }) {
  const okSteps = p.setup.filter((s) => s.status === 'ok' || s.status === 'warn').length;
  const warnSteps = p.setup.filter((s) => s.status === 'warn').length;
  const chosen = p.activation.probes.find((x) => x.chosen);
  return (
    <>
      <Metrics
        items={[
          { label: 'Setup', value: `${okSteps}/${p.setup.length}`, sub: warnSteps ? `steps passed · ${warnSteps} warning` : 'steps passed' },
          { label: 'Commands', value: `${p.commands.filter((c) => c.verified).length}/${p.commands.length}`, sub: 'verified' },
          { label: 'Skills', value: String(p.skills.length), sub: 'mapped to task types' },
          { label: 'Activation', value: chosen ? `${chosen.fired}/${chosen.total}` : '—', sub: chosen ? chosen.recipe.toLowerCase() : 'not measured' },
          { label: 'Task suite', value: String(suiteCount), sub: `+ ${heldCount} held out` },
        ]}
      />
      <div className="repo-grid">
        <section className="block">
          <h2>1 · Setup</h2>
          <ol className="steps">
            {p.setup.map((s) => (
              <li key={s.label} className={`step step-${s.status}`}>
                <span className="step-mark">{STEP_MARK[s.status]}</span>
                <span className="step-body">
                  <span className="step-label">{s.label}</span>
                  <span className="step-detail dim">{s.detail}</span>
                </span>
                <span className="num dim small">{f.duration(s.durationMs)}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="block">
          <h2>2 · Skill activation</h2>
          <p className="dim small">{p.activation.probeTask}</p>
          <table className="table">
            <thead>
              <tr>
                <th>Recipe</th>
                <th className="r">Fired</th>
              </tr>
            </thead>
            <tbody>
              {p.activation.probes.map((x) => (
                <tr key={x.recipe} className={x.chosen ? 'chosen' : ''}>
                  <td>
                    <div className="strong">
                      {x.recipe} {x.chosen && <Badge tone="strong">Used by sessions</Badge>}
                    </div>
                    <div className="mono dim small">{x.example}</div>
                  </td>
                  <td className="r">
                    <span className="crit">
                      <span className="crit-bar">
                        <span className="crit-fill" style={{ width: `${(x.fired / x.total) * 100}%` }} data-full={x.fired === x.total ? '' : undefined} />
                      </span>
                      <span className="num">
                        {x.fired}/{x.total}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="finding">
            <span className="finding-label">Finding</span>
            {p.activation.finding}
          </div>
        </section>
      </div>

      <section className="block">
        <h2>3 · Environment commands</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Purpose</th>
              <th>Command</th>
              <th>Found in</th>
              <th className="r">Verified</th>
            </tr>
          </thead>
          <tbody>
            {p.commands.map((c) => (
              <tr key={c.purpose}>
                <td className="nowrap strong">{c.purpose}</td>
                <td className="mono">{c.command}</td>
                <td className="dim nowrap">{c.source}</td>
                <td className="r nowrap">
                  <span className={c.verified ? 'ok-text' : 'bad-text'}>{c.verified ? '✓' : '✕'}</span> <span className="dim">{c.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="repo-grid">
        <section className="block">
          <h2>4 · Instruction sources</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Loaded</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {p.surfaces.map((s) => (
                <tr key={s.path}>
                  <td>
                    <div className="mono strong">{s.path}</div>
                    <div className="dim small">{s.what}</div>
                  </td>
                  <td className="nowrap">
                    {s.loading === 'auto' && <Badge tone="good">Automatically</Badge>}
                    {s.loading === 'wired' && <Badge tone="live">Wired by setup</Badge>}
                    {s.loading === 'not-loaded' && <Badge tone="muted">Not loaded</Badge>}
                  </td>
                  <td className="dim small">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="block">
          <h2>5 · Skills</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Used for</th>
                <th>How it is triggered</th>
              </tr>
            </thead>
            <tbody>
              {p.skills.map((s) => (
                <tr key={s.name}>
                  <td>
                    <div className="mono strong">{s.name}</div>
                    <div className="dim small">{s.role}</div>
                  </td>
                  <td className="nowrap">{s.usedFor}</td>
                  <td className="dim small">{s.trigger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="repo-grid">
        <section className="block">
          <h2>6 · Sandbox conflicts</h2>
          <table className="table">
            <thead>
              <tr>
                <th>What the repo expects</th>
                <th>How setup handles it</th>
              </tr>
            </thead>
            <tbody>
              {p.conflicts.map((c) => (
                <tr key={c.issue}>
                  <td>{c.issue}</td>
                  <td className="dim">{c.handling}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

const SOURCE_LABEL = { commit: 'From history', injected: 'Injected bug', invented: 'Written' } as const;

function TaskTable({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return <p className="empty">No tasks.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Task</th>
          <th>Source</th>
          <th className="r">Criteria</th>
          <th className="r">Used by sessions</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.id}>
            <td>
              <KindTag kind={t.kind} /> {t.title}
            </td>
            <td>
              <div>{SOURCE_LABEL[t.source.type]}</div>
              <div className="dim small mono">{t.source.ref}</div>
            </td>
            <td className="r num" title={t.criteria.map((c) => '• ' + c.label).join('\n')}>
              {t.criteria.length}
            </td>
            <td className="r">
              {t.approved ? (
                <span className="nowrap">
                  <Badge tone="good">Approved</Badge>{' '}
                  <button className="btn btn-small" onClick={() => void approveTask(t.id, false)}>
                    Remove
                  </button>
                </span>
              ) : (
                <button className="btn btn-small btn-primary" onClick={() => void approveTask(t.id, true)}>
                  Approve
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
