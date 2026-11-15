import { useApi } from '../api';
import type { Charts } from '../api-types';
import { Legend, StepLineChart } from '../charts';
import { LoadState, MockBadge } from '../components';

/** Progress section of the home page: the best-verified-tokens chart. */
export function ChartsSection() {
  const state = useApi<Charts>('/api/charts');
  return (
    <section className="ds-section" aria-label="Progress">
      <LoadState state={state}>
        {(c) => {
          const anyMock = c.scatter.some((p) => p.isMock) || c.bestOverTime.some((p) => p.isMock);
          return (
            <>
              {anyMock && (
                <div className="mock-banner">
                  <MockBadge /> Charts include mock-provider data, which is not a real measurement.
                </div>
              )}
              <div className="ds-panel">
                <h3 className="ds-panel__title">Best verified tokens over experiments</h3>
                <p className="ds-panel__sub">Median coding tokens per experiment · green verified, red not verified · line = best verified so far</p>
                <StepLineChart
                  points={c.bestOverTime.map((p) => ({ label: p.experimentId, value: p.bestTokens, raw: p.medianTokens, passed: p.passed }))}
                />
                <Legend
                  items={[
                    { label: 'Best verified so far', color: '--ds-ink', kind: 'line' },
                    { label: 'Verified', color: '--ds-pos' },
                    { label: 'Not verified', color: '--ds-neg' },
                  ]}
                />
              </div>
            </>
          );
        }}
      </LoadState>
    </section>
  );
}
