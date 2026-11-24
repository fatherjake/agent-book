/** The suggestions lab on the client: its state for the open session, the actions, and the comparisons. */
import { useCallback, useEffect, useState } from 'react';
import type { LabState, Run, Suggestion } from '../../server/src/lab/state';

export type { LabState, Run, Suggestion };

export interface Lab {
  state: LabState | null;
  error: string | null;
  /** Something is running: the analysis or any replay. */
  busy: boolean;
  analyse(): Promise<void>;
  saveBrief(task: string, checks: string[], budgetUsd: number): Promise<void>;
  run(suggestion: string, runs: number): Promise<void>;
  stop(suggestion?: string): Promise<void>;
  /** Accept or reject a suggestion; null clears the decision. */
  decide(suggestion: string, decision: 'accepted' | 'rejected' | null): Promise<void>;
}

const POLL_BUSY_MS = 2500;
const POLL_IDLE_MS = 20_000;

const running = (r: Run) => r.status === 'running' || r.status === 'judging';
export const isBusy = (s: LabState | null) => !!s && (s.analysis?.status === 'running' || s.baseline.some(running) || s.suggestions.some((x) => x.runs.some(running)));

export function useLab(sessionId: string | null): Lab {
  const [state, setState] = useState<LabState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = (action = '') => `/api/lab${action}?session=${sessionId}`;

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/lab?session=${sessionId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setState(body);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [sessionId]);

  useEffect(() => {
    setState(null);
    setError(null);
    void load();
  }, [load]);

  const busy = isBusy(state);
  useEffect(() => {
    const t = setInterval(load, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearInterval(t);
  }, [load, busy]);

  const post = async (action: string, body: unknown = {}) => {
    setError(null);
    try {
      const res = await fetch(url(action), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      setState(out);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  return {
    state,
    error,
    busy,
    analyse: () => post('/analyse'),
    saveBrief: (task, checks, budgetUsd) => post('/brief', { task, checks, budgetUsd }),
    run: (suggestion, runs) => post('/run', { suggestion, runs }),
    stop: (suggestion) => post('/stop', suggestion ? { suggestion } : {}),
    decide: (suggestion, decision) => post('/decide', { suggestion, decision }),
  };
}

// --- Comparing runs -------------------------------------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const runTokens = (r: Run) => (r.tokens ? r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite : 0);
export const checksMet = (r: Run) => (r.judge ? r.judge.checks.filter((c) => c.met).length : 0);

export type MetricKey = 'cost' | 'tokens' | 'time' | 'tools' | 'checks';
export const METRICS: { key: MetricKey; label: string; value: (r: Run) => number; higherIsBetter: boolean }[] = [
  { key: 'checks', label: 'Checks met', value: (r) => (r.judge ? checksMet(r) / Math.max(1, r.judge.checks.length) : NaN), higherIsBetter: true },
  { key: 'cost', label: 'Cost', value: (r) => r.costUsd ?? NaN, higherIsBetter: false },
  { key: 'tokens', label: 'Tokens', value: runTokens, higherIsBetter: false },
  { key: 'time', label: 'Time', value: (r) => r.durationMs ?? NaN, higherIsBetter: false },
  { key: 'tools', label: 'Tool calls', value: (r) => r.toolCalls ?? NaN, higherIsBetter: false },
];

export interface MetricComparison {
  base: number;
  cand: number;
  /** Relative change, with-change vs baseline (checks: absolute change in the share met). */
  change: number;
  better: boolean | null;
  /** Too small to tell apart from run-to-run variation. */
  noise: boolean;
}

/** Finished, judged runs on the brief's current version. */
export const finished = (runs: Run[], version: number) => runs.filter((r) => r.briefVersion === version && r.status === 'done');

/**
 * The suggestion against the baseline, on medians. A difference counts as noise when the two sides'
 * ranges overlap (with two or more runs each), or, with a single run on a side, when it is under 15%.
 */
export function compare(base: Run[], cand: Run[]): Record<MetricKey, MetricComparison> | null {
  if (!base.length || !cand.length) return null;
  const out = {} as Record<MetricKey, MetricComparison>;
  for (const m of METRICS) {
    const b = base.map(m.value).filter(Number.isFinite);
    const c = cand.map(m.value).filter(Number.isFinite);
    const mb = median(b);
    const mc = median(c);
    const change = m.key === 'checks' ? mc - mb : mb ? (mc - mb) / mb : 0;
    const overlap = Math.max(Math.min(...b), Math.min(...c)) <= Math.min(Math.max(...b), Math.max(...c));
    const noise = b.length >= 2 && c.length >= 2 ? overlap : Math.abs(change) < 0.15;
    out[m.key] = { base: mb, cand: mc, change, better: change === 0 ? null : m.higherIsBetter ? change > 0 : change < 0, noise };
  }
  return out;
}
