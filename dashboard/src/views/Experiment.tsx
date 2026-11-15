import { useEffect, useState } from 'react';
import { enc, useApi } from '../api';
import type { ExperimentDetail } from '../api-types';
import { Card, CheatingBadge, LoadState, MockBadge, NoBrowserBadge, OutcomeBadge, PassBadge, Stat } from '../components';
import { fmtDate, fmtDuration, fmtPct, fmtScore, fmtTokens, fmtUsd } from '../format';
import { RunPanel } from './Run';

function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---')
            ? 'diff-file'
            : line.startsWith('+')
              ? 'diff-add'
              : line.startsWith('-')
                ? 'diff-del'
                : line.startsWith('@@')
                  ? 'diff-hunk'
                  : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export function ExperimentView({ id }: { id: string }) {
  const state = useApi<ExperimentDetail>(`/api/experiments/${enc(id)}`);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  useEffect(() => setSelectedRun(null), [id]);

  return (
    <LoadState state={state}>
      {(d) => {
        const e = d.experiment;
        const runId = selectedRun ?? d.runs.find((r) => r.passed === false)?.id ?? d.runs[0]?.id ?? null;
        return (
          <>
            <div className="crumbs">
              <a href="#/experiments">Experiments</a> / {e.id}
            </div>
            <h1>
              {e.id} <MockBadge show={e.isMock} /> <NoBrowserBadge show={e.noBrowserAgent} /> <CheatingBadge cheating={e.cheating} /> <OutcomeBadge outcome={e.outcome} />{' '}
              <span className="badge neutral">{e.status}</span>
            </h1>
            {e.isMock && (
              <div className="mock-banner">
                <MockBadge /> This experiment ran against the mock provider. Its token counts are not real measurements.
              </div>
            )}
            {e.cheating && (
              <div className="mock-banner">
                <CheatingBadge cheating={e.cheating} /> Flagged as cheating{e.cheating.inheritedFrom ? ` (inherited from ${e.cheating.inheritedFrom})` : ''}:{' '}
                {e.cheating.reason}. It is never promoted, does not count as the best config, and the research agent is told not to reuse it.
              </div>
            )}
            {e.noBrowserAgent && (
              <div className="mock-banner">
                <NoBrowserBadge /> Evaluated without the LLM browser agent: the evaluation is incomplete, so this experiment can never
                be promoted, whatever its pass rate.
              </div>
            )}
            <div className="stats">
              <Stat label="Config" value={<span className="mono">{e.configId}</span>} sub={e.parentConfigId ? `parent: ${e.parentConfigId}` : 'no parent'} />
              <Stat label="Model" value={e.model} sub={e.provider} />
              <Stat label="Pass rate" value={e.passRate === null ? '—' : fmtPct(e.passRate * 100)} sub={`${e.passes}/${e.runs} runs passed`} />
              <Stat label="Median tokens" value={fmtTokens(e.medianTokens)} sub={e.improvementVsBestPct === null ? undefined : `${fmtPct(e.improvementVsBestPct, true)} fewer tokens than best`} />
              <Stat label="API-equiv. cost" value={fmtUsd(e.costUsd)} sub={`median runtime ${fmtDuration(e.medianDurationMs)}`} />
              <Stat label="Visual score" value={fmtScore(e.visualScore)} sub={`created ${fmtDate(e.createdAt)}`} />
            </div>

            <div className="grid-2">
              <Card title="Research hypothesis">
                <p className="prose">{e.hypothesis || <span className="muted">No hypothesis recorded.</span>}</p>
                {(e.changeSummary || e.changes) && (
                  <>
                    <h3>Changes</h3>
                    <p className="prose">{e.changeSummary || e.changes}</p>
                  </>
                )}
                {e.error && (
                  <>
                    <h3>Error</h3>
                    <div className="error-box">{e.error}</div>
                  </>
                )}
                {e.notes && (
                  <>
                    <h3>Notes</h3>
                    <p className="prose">{e.notes}</p>
                  </>
                )}
              </Card>
              <Card title="Configuration changes">
                {d.configDiff ? <DiffView text={d.configDiff} /> : <div className="empty">No config diff available.</div>}
              </Card>
            </div>

            <Card title={`Runs (${d.runs.length})`}>
              {d.runs.length === 0 ? (
                <div className="empty">No runs recorded for this experiment.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Status</th>
                        <th>Result</th>
                        <th className="num">Tokens</th>
                        <th className="num">API-equiv. cost</th>
                        <th className="num">Runtime</th>
                        <th className="num">Tool calls</th>
                        <th className="num">Visual</th>
                        <th>Failure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.runs.map((r) => (
                        <tr key={r.id} className={'clickable ' + (r.id === runId ? 'selected' : '')} onClick={() => setSelectedRun(r.id)}>
                          <td className="mono">
                            {r.id} <MockBadge show={r.isMock} /> <NoBrowserBadge show={r.noBrowserAgent} />
                          </td>
                          <td>{r.status}</td>
                          <td>
                            <PassBadge passed={r.passed} />
                          </td>
                          <td className="num">{fmtTokens(r.totalTokens)}</td>
                          <td className="num">{fmtUsd(r.costUsd)}</td>
                          <td className="num">{fmtDuration(r.durationMs)}</td>
                          <td className="num">{r.toolCalls ?? '—'}</td>
                          <td className="num">{fmtScore(r.visualScore)}</td>
                          <td className="truncate" title={r.failureReason ?? ''}>
                            {r.failureReason ?? ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {runId && (
              <>
                <h2 className="section-title">
                  Run <span className="mono">{runId}</span>{' '}
                  <a className="small" href={`#/runs/${runId}`}>
                    open on its own page
                  </a>
                </h2>
                <RunPanel id={runId} />
              </>
            )}
          </>
        );
      }}
    </LoadState>
  );
}
