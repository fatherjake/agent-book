import type { Run, Task } from './types';

export interface Summary {
  runs: number;
  done: number;
  running: number;
  /** Averages over finished runs (null when none finished). */
  tokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Share of acceptance criteria met, over all finished runs (0..1). */
  criteria: number | null;
  criteriaMet: number;
  criteriaTotal: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function taskOf(tasks: Task[], id: string): Task {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

export function summarize(runs: Run[], tasks: Task[]): Summary {
  const done = runs.filter((r) => r.status === 'done');
  const criteriaMet = done.reduce((n, r) => n + r.criteriaMet.length, 0);
  const criteriaTotal = done.reduce((n, r) => n + taskOf(tasks, r.taskId).criteria.length, 0);
  return {
    runs: runs.length,
    done: done.length,
    running: runs.filter((r) => r.status === 'running').length,
    tokens: avg(done.map((r) => r.tokens)),
    costUsd: avg(done.map((r) => r.costUsd)),
    durationMs: avg(done.map((r) => r.durationMs)),
    criteria: criteriaTotal ? criteriaMet / criteriaTotal : null,
    criteriaMet,
    criteriaTotal,
  };
}

/** Relative change (b - a) / a, or null. */
export const relChange = (a: number | null, b: number | null) => (a && b !== null ? (b - a) / a : null);
