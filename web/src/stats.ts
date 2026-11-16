import type { Run, Task } from './types';

export interface Summary {
  runs: number;
  done: number;
  /** queued or running */
  pending: number;
  errors: number;
  /** Averages over finished runs (null when none finished). */
  tokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Share of acceptance criteria met, over all finished runs (0..1). */
  criteria: number | null;
  criteriaMet: number;
  criteriaTotal: number;
  /** Finished runs in which the agent used the repo's skills. */
  skillsFired: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function taskOf(tasks: Task[], id: string): Task {
  return (
    tasks.find((x) => x.id === id) ?? {
      id,
      kind: 'feature',
      title: id,
      criteria: [],
      source: { type: 'invented', ref: '' },
      heldOut: false,
      approved: false,
    }
  );
}

export function summarize(runs: Run[], tasks: Task[]): Summary {
  const done = runs.filter((r) => r.status === 'done');
  const criteriaMet = done.reduce((n, r) => n + r.criteriaMet.length, 0);
  const criteriaTotal = done.reduce((n, r) => n + taskOf(tasks, r.taskId).criteria.length, 0);
  return {
    runs: runs.length,
    done: done.length,
    pending: runs.filter((r) => r.status === 'running' || r.status === 'queued').length,
    errors: runs.filter((r) => r.status === 'error').length,
    tokens: avg(done.map((r) => r.tokens)),
    costUsd: avg(done.map((r) => r.costUsd)),
    durationMs: avg(done.map((r) => r.durationMs)),
    criteria: criteriaTotal ? criteriaMet / criteriaTotal : null,
    criteriaMet,
    criteriaTotal,
    skillsFired: done.filter((r) => r.skillsFired).length,
  };
}

/** Relative change (b - a) / a, or null. */
export const relChange = (a: number | null, b: number | null) => (a && b !== null ? (b - a) / a : null);

/** 97.5% quantile of Student's t for df = 1..30 (beyond: 1.96). */
const T975 = [12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.1, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04];

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
  /** The 95% range includes zero: the data can't tell this change from noise. */
  inconclusive: boolean;
}

function interval(xs: number[]): Interval | null {
  if (!xs.length) return null;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, lo: -Infinity, hi: Infinity, inconclusive: true };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const half = (T975[n - 2] ?? 1.96) * (sd / Math.sqrt(n));
  return { mean, lo: mean - half, hi: mean + half, inconclusive: mean - half <= 0 && mean + half >= 0 };
}

export interface Paired {
  /** Finished pairs: a session run and the suggestion's run of the same task and repeat. */
  pairs: number;
  /** Relative token change per pair, (suggestion - session) / session. */
  tokens: Interval | null;
  /** Change in the share of criteria met per pair (in points of 0..1). */
  criteria: Interval | null;
  /** Relative time change per pair. */
  time: Interval | null;
}

/** Paired comparison: suggestion runs against the session runs with the same pair key. */
export function paired(sessionRuns: Run[], suggestionRuns: Run[], tasks: Task[]): Paired {
  const base = new Map(sessionRuns.filter((r) => r.status === 'done').map((r) => [r.pairKey, r]));
  const tok: number[] = [];
  const cri: number[] = [];
  const tim: number[] = [];
  for (const c of suggestionRuns) {
    const b = base.get(c.pairKey);
    if (!b || c.status !== 'done') continue;
    const total = taskOf(tasks, c.taskId).criteria.length || 1;
    if (b.tokens) tok.push((c.tokens - b.tokens) / b.tokens);
    if (b.durationMs) tim.push((c.durationMs - b.durationMs) / b.durationMs);
    cri.push(c.criteriaMet.length / total - b.criteriaMet.length / total);
  }
  // Relative changes can't go below -100%; criteria shares stay within ±100 points.
  const clamp = (iv: Interval | null, lo: number, hi: number) => (iv ? { ...iv, lo: Math.max(lo, iv.lo), hi: Math.min(hi, iv.hi) } : iv);
  return { pairs: cri.length, tokens: clamp(interval(tok), -1, Infinity), criteria: clamp(interval(cri), -1, 1), time: clamp(interval(tim), -1, Infinity) };
}
