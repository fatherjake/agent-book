import { useState } from 'react';
import { enc, useApi } from '../api';
import type { EvaluationView, RunDetail, TokenBreakdownRow } from '../api-types';
import { Ago, Card, LoadState, MockBadge, PassBadge, Stat } from '../components';
import { TraceViewer } from '../TraceViewer';
import { TokenProfile } from '../TokenProfile';
import { fmtDate, fmtDuration, fmtInt, fmtScore, fmtTokens, fmtUsd } from '../format';

function TokenTable({ rows }: { rows: TokenBreakdownRow[] }) {
  if (!rows.length) return <div className="empty">No usage records for this run.</div>;
  const sum = (k: keyof TokenBreakdownRow) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Role</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
            <th className="num">Cache read</th>
            <th className="num">Cache write</th>
            <th className="num">Reasoning</th>
            <th className="num">Total</th>
            <th className="num">Calls</th>
            <th className="num">API-equiv. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.role}>
              <td>
                {r.role} {r.anyEstimated && <span className="badge neutral" title="Some usage was estimated, not provider-reported">est.</span>}
              </td>
              <td className="num">{fmtInt(r.inputTokens)}</td>
              <td className="num">{fmtInt(r.outputTokens)}</td>
              <td className="num">{fmtInt(r.cacheReadTokens)}</td>
              <td className="num">{fmtInt(r.cacheWriteTokens)}</td>
              <td className="num">{fmtInt(r.reasoningTokens)}</td>
              <td className="num strong">{fmtInt(r.totalTokens)}</td>
              <td className="num">{fmtInt(r.calls)}</td>
              <td className="num">{fmtUsd(r.costUsd)}</td>
            </tr>
          ))}
          {rows.length > 1 && (
            <tr className="total-row">
              <td>All roles</td>
              <td className="num">{fmtInt(sum('inputTokens'))}</td>
              <td className="num">{fmtInt(sum('outputTokens'))}</td>
              <td className="num">{fmtInt(sum('cacheReadTokens'))}</td>
              <td className="num">{fmtInt(sum('cacheWriteTokens'))}</td>
              <td className="num">{fmtInt(sum('reasoningTokens'))}</td>
              <td className="num strong">{fmtInt(sum('totalTokens'))}</td>
              <td className="num">{fmtInt(sum('calls'))}</td>
              <td className="num">{fmtUsd(sum('costUsd'))}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">Reasoning tokens are shown for information; where the provider counts them inside output they aren't added to the total again.</p>
    </div>
  );
}

function EvalCard({ ev }: { ev: EvaluationView }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const checks = onlyProblems ? ev.checks.filter((c) => c.outcome !== 'pass') : ev.checks;
  const counts = { pass: 0, fail: 0, error: 0 } as Record<string, number>;
  ev.checks.forEach((c) => (counts[c.outcome] = (counts[c.outcome] ?? 0) + 1));
  return (
    <Card
      title={
        <>
          Evaluation: {ev.suite} suite <PassBadge passed={ev.passed} />
          {ev.evaluatorFailure && <span className="badge fail">evaluator failure</span>}
        </>
      }
    >
      <div className="kv">
        <span>App started</span>
        <b>{ev.appStarted === null ? '—' : ev.appStarted ? 'yes' : 'no'}</b>
        <span>Visual score</span>
        <b>
          {fmtScore(ev.visualScore)} / threshold {ev.visualThreshold ?? '—'}
        </b>
        <span>Checks</span>
        <b>
          <span className="good">{counts.pass} pass</span> · <span className="bad">{counts.fail} fail</span> ·{' '}
          <span className="warn">{counts.error} error</span>
        </b>
        <span>Window</span>
        <b>
          {fmtDate(ev.startedAt)} → {fmtDate(ev.finishedAt)}
        </b>
      </div>
      {ev.failureSummary && <div className="error-box">{ev.failureSummary}</div>}
      <div className="row-between">
        <label className="small">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only failures and errors
        </label>
        {ev.reportUrl && (
          <a className="small" href={ev.reportUrl} target="_blank" rel="noreferrer">
            report.json
          </a>
        )}
      </div>
      <div className="table-wrap">
        <table className="table checks">
          <thead>
            <tr>
              <th>Check</th>
              <th>Category</th>
              <th>Outcome</th>
              <th>Message</th>
              <th className="num">Tries</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id} className={'outcome-' + c.outcome}>
                <td className="mono">
                  {c.id}
                  {c.mandatory && <span className="muted small" title="Mandatory check"> *</span>}
                </td>
                <td>{c.category}</td>
                <td>
                  <span className={'badge ' + (c.outcome === 'pass' ? 'pass' : c.outcome === 'fail' ? 'fail' : 'warn')}>{c.outcome}</span>
                </td>
                <td className="msg">
                  {c.message}
                  {c.evidence.map((p) => (
                    <a key={p} className="evidence" href={'/artifacts/' + p.replace(/^results\//, '')} target="_blank" rel="noreferrer">
                      {p.split('/').pop()}
                    </a>
                  ))}
                </td>
                <td className="num">{c.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">* mandatory</p>
    </Card>
  );
}

function Screenshots({ shots }: { shots: { url: string; name: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!shots.length) return <div className="empty">No screenshots for this run.</div>;
  return (
    <>
      <div className="thumbs">
        {shots.map((s, i) => (
          <button key={s.url} className="thumb" onClick={() => setOpen(i)} title={s.name}>
            <img src={s.url} alt={s.name} loading="lazy" />
            <span>{s.name}</span>
          </button>
        ))}
      </div>
      {open !== null && (
        <div className="lightbox" onClick={() => setOpen(null)} role="dialog" aria-label={shots[open].name}>
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <button disabled={open === 0} onClick={() => setOpen(open - 1)}>‹ Prev</button>
            <span>{shots[open].name}</span>
            <button disabled={open === shots.length - 1} onClick={() => setOpen(open + 1)}>Next ›</button>
            <a href={shots[open].url} target="_blank" rel="noreferrer">Open</a>
            <button onClick={() => setOpen(null)}>Close</button>
          </div>
          <img src={shots[open].url} alt={shots[open].name} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}

export function RunPanel({ id }: { id: string }) {
  const state = useApi<RunDetail>(`/api/runs/${enc(id)}`);
  return (
    <LoadState state={state}>
      {(d) => {
        const r = d.run;
        const failingChecks = d.evaluations.flatMap((e) => e.checks.filter((c) => c.outcome !== 'pass' && c.mandatory).map((c) => ({ ...c, suite: e.suite })));
        const hasFailure = !!r.failureReason || failingChecks.length > 0 || d.evaluations.some((e) => e.failureSummary);
        return (
          <div className="run-panel">
            {r.isMock && (
              <div className="mock-banner">
                <MockBadge /> Mock-provider run: tokens are synthetic.
              </div>
            )}
            <div className="stats">
              <Stat label="Status" value={r.status} sub={<PassBadge passed={r.passed} />} />
              <Stat label="Coding tokens" value={fmtTokens(r.totalTokens)} sub={fmtUsd(r.costUsd)} />
              <Stat
                label="Runtime"
                value={fmtDuration(r.durationMs)}
                sub={
                  <>
                    coding {fmtDuration(r.codingMs)} + evaluation {fmtDuration(r.durationMs !== null && r.codingMs !== null ? r.durationMs - r.codingMs : null)} · started <Ago iso={r.startedAt} />
                  </>
                }
              />
              <Stat label="Tool calls" value={r.toolCalls ?? '—'} sub={`seed ${r.seed ?? '—'}`} />
              <Stat label="Image" value={<span className="mono small">{r.imageId ? r.imageId.slice(0, 19) : '—'}</span>} sub={r.starterHash ? `starter ${r.starterHash.slice(0, 12)}` : undefined} />
            </div>

            {hasFailure && (
              <Card title="Failure details" className="failure-card">
                {r.failureReason && <div className="error-box">{r.failureReason}</div>}
                {d.evaluations
                  .filter((e) => e.failureSummary)
                  .map((e) => (
                    <div key={e.suite} className="error-box">
                      [{e.suite}] {e.failureSummary}
                    </div>
                  ))}
                {failingChecks.length > 0 && (
                  <ul className="fail-list">
                    {failingChecks.map((c) => (
                      <li key={c.suite + c.id}>
                        <span className="mono">{c.id}</span> <span className={'badge ' + (c.outcome === 'fail' ? 'fail' : 'warn')}>{c.outcome}</span> {c.message}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            <Card title="Token breakdown">
              <TokenTable rows={d.tokens} />
            </Card>

            <Card title="Token profile">
              <TokenProfile url={d.profileUrl} />
            </Card>

            {d.evaluations.length === 0 ? (
              <Card title="Evaluation">
                <div className="empty">This run has not been evaluated.</div>
              </Card>
            ) : (
              d.evaluations.map((ev) => <EvalCard key={ev.suite} ev={ev} />)
            )}

            <Card title="Browser screenshots">
              <Screenshots shots={d.screenshots} />
            </Card>

            <Card
              title={
                <>
                  Agent log{' '}
                  {d.trace.url && (
                    <a className="small" href={d.trace.url} target="_blank" rel="noreferrer">
                      raw trace.jsonl
                    </a>
                  )}
                </>
              }
            >
              <TraceViewer entries={d.trace.entries} truncated={d.trace.truncated} totalLines={d.trace.totalLines} />
            </Card>

            <Card title="Artifacts">
              {d.artifacts.length === 0 ? (
                <div className="empty">No artifacts recorded.</div>
              ) : (
                <table className="table">
                  <tbody>
                    {d.artifacts.map((a) => (
                      <tr key={a.path}>
                        <td>{a.kind}</td>
                        <td className="mono">{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.path}</a> : a.path}</td>
                        <td className="mono muted small">{a.sha256 ? a.sha256.slice(0, 12) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        );
      }}
    </LoadState>
  );
}

export function RunView({ id }: { id: string }) {
  const state = useApi<RunDetail>(`/api/runs/${enc(id)}`);
  const expId = state.data?.run.experimentId;
  return (
    <>
      <div className="crumbs">
        <a href="#/">Experiments</a> / {expId ? <a href={`#/experiments/${expId}`}>{expId}</a> : 'no experiment'} / {id}
      </div>
      <h1>
        Run <span className="mono">{id}</span>
      </h1>
      <RunPanel id={id} />
    </>
  );
}
