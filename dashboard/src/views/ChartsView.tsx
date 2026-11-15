import { useApi } from '../api';
import type { Charts } from '../api-types';
import { BarChart, CumulativeLineChart, ScatterChart, StepLineChart } from '../charts';
import { Card, LoadState, MockBadge } from '../components';
import { fmtUsd } from '../format';

export function ChartsView() {
  const state = useApi<Charts>('/api/charts');
  return (
    <>
      <h1>Charts</h1>
      <LoadState state={state}>
        {(c) => {
          const anyMock = c.scatter.some((p) => p.isMock) || c.bestOverTime.some((p) => p.isMock);
          const hasVisual = c.scatter.some((p) => p.visualScore !== null);
          return (
            <>
              {anyMock && (
                <div className="mock-banner">
                  <MockBadge /> Charts include mock-provider data.
                </div>
              )}
              <div className="grid-2">
                <Card title="Best verified tokens over experiments">
                  <StepLineChart
                    points={c.bestOverTime.map((p) => ({
                      label: p.experimentId,
                      value: p.bestTokens,
                      raw: p.medianTokens,
                      passed: p.passed,
                    }))}
                  />
                  <div className="legend">
                    <span><i className="sw series-1" />Best verified so far</span>
                    <span><i className="dot dot-pass" />Verified experiment</span>
                    <span><i className="dot dot-fail" />Not verified</span>
                  </div>
                </Card>
                <Card title={hasVisual ? 'Tokens vs quality (visual score)' : 'Tokens vs quality (pass = 100)'}>
                  <ScatterChart
                    yLabel={hasVisual ? 'Visual score' : 'Pass (100) / fail (0)'}
                    points={c.scatter.filter((p) => !hasVisual || p.visualScore !== null).map((p) => ({
                      id: p.runId,
                      x: p.tokens,
                      y: hasVisual ? (p.visualScore ?? 0) : p.passed ? 100 : 0,
                      passed: p.passed,
                    }))}
                  />
                  <div className="legend">
                    <span><i className="dot dot-pass" />Run passed</span>
                    <span><i className="dot dot-fail" />Run failed</span>
                    <span><i className="dot dot-neutral" />Not evaluated</span>
                  </div>
                </Card>
                <Card title="Pass rate by configuration">
                  <BarChart
                    bars={c.passRateByConfig.map((b) => ({
                      label: b.configId,
                      value: b.passRate,
                      note: `${b.passes}/${b.runs} (${Math.round(b.passRate * 100)}%)`,
                      mock: b.isMock,
                    }))}
                  />
                </Card>
                <Card title="API-equivalent cost over time (cumulative)">
                  <CumulativeLineChart
                    fmt={fmtUsd}
                    points={c.costOverTime.map((p) => ({ ...p, t: new Date(p.timestamp).getTime() }))}
                  />
                </Card>
              </div>
            </>
          );
        }}
      </LoadState>
    </>
  );
}
