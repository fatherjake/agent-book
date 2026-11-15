import { useEffect, useState, type ReactNode } from 'react';
import { fmtAgo, fmtDate } from './format';
import type { Loadable } from './api';

export function MockBadge({ show = true, title }: { show?: boolean; title?: string }) {
  if (!show) return null;
  return (
    <span className="badge mock" title={title ?? 'Produced by the mock provider: not a real measurement'}>
      [MOCK]
    </span>
  );
}

export function CheatingBadge({ cheating }: { cheating: { reason: string; inheritedFrom: string | null } | null | undefined }) {
  if (!cheating) return null;
  return (
    <span className="badge neg-solid" title={`Flagged as cheating${cheating.inheritedFrom ? ` (inherited from ${cheating.inheritedFrom})` : ''}: ${cheating.reason}`}>
      cheating
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
        : outcome === 'flagged_cheating'
          ? 'neg-solid'
          : outcome === 'error' || outcome.startsWith('failed') || outcome === 'fail'
            ? 'fail'
            : 'neutral';
  return <span className={'badge ' + cls}>{outcome.replace(/_/g, ' ')}</span>;
}

export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={'ds-panel card ' + (className ?? '')}>
      {title && <h2 className="ds-panel__title">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="ds-metric">
      <div className="ds-metric__label">{label}</div>
      {/* Numbers use the 24px mono metric value; words (a model id, a status) drop to 15px so they don't wrap. */}
      <div className={'ds-metric__value' + (typeof value === 'string' && /[A-Za-z]{2,}/.test(value) ? ' text' : '')}>{value}</div>
      {sub && <div className="ds-metric__sub">{sub}</div>}
    </div>
  );
}

export function LoadState<T>({ state, children }: { state: Loadable<T>; children: (data: T) => ReactNode }) {
  if (state.loading) return <div className="ds-empty">Loading…</div>;
  if (state.error) return <div className="error-box">Failed to load: {state.error}</div>;
  if (!state.data) return <div className="ds-empty">Nothing has been recorded yet.</div>;
  return <>{children(state.data)}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** One shared 1s clock so every relative time on the page ticks together. */
const listeners = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) timer = setInterval(() => listeners.forEach((l) => l(Date.now())), 1000);
    return () => {
      listeners.delete(setNow);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

/** Relative timestamp ("20m ago") with the exact UTC time on hover. */
export function Ago({ iso }: { iso: string | null | undefined }) {
  const now = useNow();
  return <time dateTime={iso ?? undefined} title={fmtDate(iso)}>{fmtAgo(iso, now)}</time>;
}
