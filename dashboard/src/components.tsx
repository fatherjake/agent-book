import type { ReactNode } from 'react';
import type { Loadable } from './api';

export function MockBadge({ show = true, title }: { show?: boolean; title?: string }) {
  if (!show) return null;
  return (
    <span className="badge mock" title={title ?? 'Produced by the mock provider: not a real measurement'}>
      [MOCK]
    </span>
  );
}

export function NoBrowserBadge({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span className="badge mock" title="Evaluated without the LLM browser agent: incomplete evaluation, never eligible for promotion">
      [NO-BROWSER-AGENT]
    </span>
  );
}

export function PassBadge({ passed, label }: { passed: boolean | null | undefined; label?: string }) {
  if (passed === null || passed === undefined) return <span className="badge neutral">{label ?? 'n/a'}</span>;
  return <span className={'badge ' + (passed ? 'pass' : 'fail')}>{label ?? (passed ? 'PASS' : 'FAIL')}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span className="badge neutral">—</span>;
  const cls =
    outcome === 'promoted' || outcome === 'baseline' || outcome === 'pass'
      ? 'pass'
      : outcome === 'not_better'
        ? 'neutral'
        : outcome === 'error' || outcome.startsWith('failed') || outcome === 'fail'
          ? 'fail'
          : 'neutral';
  return <span className={'badge ' + cls}>{outcome.replace(/_/g, ' ')}</span>;
}

export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={'card ' + (className ?? '')}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function LoadState<T>({ state, children }: { state: Loadable<T>; children: (data: T) => ReactNode }) {
  if (state.loading) return <div className="muted pad">Loading…</div>;
  if (state.error) return <div className="error-box">Failed to load: {state.error}</div>;
  if (!state.data) return <div className="muted pad">No data.</div>;
  return <>{children(state.data)}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
