import { useApi } from '../api';
import type { Overview, RoleCost } from '../api-types';
import { Card, LoadState, MockBadge, NoBrowserBadge, Stat } from '../components';
import { fmtInt, fmtPct, fmtTokens, fmtUsd } from '../format';

function CostRow({ label, c, total }: { label: string; c: RoleCost; total: number }) {
  const share = total > 0 ? (c.costUsd / total) * 100 : 0;
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmtUsd(c.costUsd)}</td>
      <td className="num">{fmtTokens(c.tokens)}</td>
      <td className="num">{fmtInt(c.calls)}</td>
      <td className="share-cell">
        <div className="share">
          <div style={{ width: share + '%' }} />
        </div>
      </td>
    </tr>
  );
}

export function OverviewView() {
  const state = useApi<Overview>('/api/overview');
  return (
    <LoadState state={state}>
      {(o) => {
        const best = o.best ?? o.mockBest;
        const bestIsMock = !o.best && !!o.mockBest;
        return (
          <>
            <h1>
              Overview {o.allMock && <MockBadge title="Every result in this database came from the mock provider" />}
            </h1>
            {o.anyMock && (
              <div className="mock-banner">
                <MockBadge /> This database contains mock-provider results. Mock data is never eligible as the best
                configuration and isn't a real token measurement.
              </div>
            )}
            {o.anyNoBrowserAgent && (
              <div className="mock-banner">
                <NoBrowserBadge /> Some evaluations skipped the LLM browser agent. They are incomplete and never count
                toward promotion or the best configuration.
              </div>
            )}
            <div className="stats">
              <Stat
                label={<>Best verified configuration {bestIsMock && <MockBadge />}</>}
                value={best ? <a className="stat-text mono" href={best.experimentId ? `#/experiments/${best.experimentId}` : '#/experiments'}>{best.configId}</a> : '—'}
                sub={
                  best
                    ? `${best.passes}/${best.runs} runs passed${bestIsMock ? ' · mock only, not eligible' : ''}`
                    : 'No configuration has passed verification yet'
                }
              />
              <Stat
                label={<>Lowest verified median tokens {bestIsMock && <MockBadge />}</>}
                value={fmtTokens(best?.medianTokens)}
                sub={best?.medianTokens != null ? fmtInt(best.medianTokens) + ' tokens' : undefined}
              />
              <Stat
                label={<>Baseline tokens {o.baseline?.isMock && <MockBadge />}</>}
                value={fmtTokens(o.baseline?.medianTokens)}
                sub={o.baseline ? `median of ${o.baseline.runs} run(s), ${o.baseline.passes} passed` : 'No baseline runs yet'}
              />
              <Stat
                label={<>Improvement over baseline {o.improvementIsMock && <MockBadge />}</>}
                value={<span className={o.improvementPct != null && o.improvementPct > 0 ? 'good' : ''}>{fmtPct(o.improvementPct)}</span>}
                sub="fewer coding tokens than the baseline median"
              />
              <Stat
                label="Completed experiments"
                value={fmtInt(o.experiments.completed)}
                sub={`${o.experiments.total} total · ${o.experiments.running} in progress`}
              />
              <Stat
                label="API-equivalent cost"
                value={fmtUsd(o.cost.totalUsd)}
                sub={`local price table, not billed on a subscription · ${o.runs.total} runs · ${o.runs.passed}/${o.runs.evaluated} evaluated runs passed`}
              />
            </div>

            <div className="grid-2">
              <Card title="API-equivalent cost by role">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th className="num" title="Tokens priced with the local API price table; nothing is billed per token on a Claude subscription">API-equiv. cost</th>
                      <th className="num">Tokens</th>
                      <th className="num">Calls</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    <CostRow label="Coding agent" c={o.cost.coding} total={o.cost.totalUsd} />
                    <CostRow label="Evaluator agent" c={o.cost.evaluator} total={o.cost.totalUsd} />
                    <CostRow label="Research agent" c={o.cost.research} total={o.cost.totalUsd} />
                  </tbody>
                </table>
              </Card>
              <Card title="Experiment outcomes">
                {Object.keys(o.experiments.byOutcome).length === 0 ? (
                  <div className="empty">No experiments yet.</div>
                ) : (
                  <table className="table">
                    <tbody>
                      {Object.entries(o.experiments.byOutcome)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, v]) => (
                          <tr key={k}>
                            <td>{k.replace(/_/g, ' ')}</td>
                            <td className="num">{v}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
            <p className="muted small">
              Database: <code>{o.dbPath}</code> · generated {o.generatedAt}
            </p>
          </>
        );
      }}
    </LoadState>
  );
}
