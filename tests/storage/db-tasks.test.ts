/** Schema v5 (task_id): migration from v4, per-task best/baseline, filters, read-only v4 fallback. Temp DBs only. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb, openDbReadOnly, SCHEMA_VERSION, TASK_SCHEMA_VERSION, type StoredSummary } from '../../storage/db.js';
import { fakeCoding } from '../researcher/helpers.js';

const summary = (medianTokens: number, o: Partial<StoredSummary> = {}): StoredSummary => ({
  configId: 'x',
  runs: 3,
  passes: 3,
  passRate: 1,
  medianTokens,
  meanTokens: medianTokens,
  tokenVariance: 0,
  medianVisualScore: 100,
  totalCostUsd: 0,
  medianDurationMs: 1,
  meetsQualityRequirements: true,
  ...o,
});

/** A v4 database (the schema before tasks) with a few rows, built with the real v1..v4 migrations. */
function makeV4(path: string): void {
  const raw = new Database(path);
  for (let v = 0; v < 4; v++) {
    raw.exec(MIGRATIONS[v]);
    raw.pragma(`user_version = ${v + 1}`);
  }
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO configs (config_id, hash, path, created_at) VALUES ('baseline', 'h', 'configs/baseline', ?)`).run(now);
  raw
    .prepare(
      `INSERT INTO experiments (id, kind, candidate_config_id, hypothesis, provider, model, created_at, status, outcome, summary_json) VALUES ('exp-0001', 'baseline', 'baseline', 'Baseline', 'anthropic', 'm', ?, 'completed', 'baseline', ?)`,
    )
    .run(now, JSON.stringify(summary(1000)));
  raw.prepare(`INSERT INTO runs (run_id, experiment_id, config_id, seed, phase, suite, started_at, status, total_tokens, passed) VALUES ('r1', 'exp-0001', 'baseline', 1, 'verify', 'dev', ?, 'completed', 1000, 1)`).run(now);
  raw
    .prepare(`INSERT INTO best_history (experiment_id, config_id, median_tokens, pass_rate, summary_json, promoted_at) VALUES ('exp-0001', 'baseline', 1000, 1, ?, ?)`)
    .run(JSON.stringify(summary(1000)), now);
  raw.close();
}

describe('storage schema v5 (tasks)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frugal-db-tasks-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('migrates v4 → v5: existing rows become todo, append-only guards still hold', () => {
    const p = join(dir, 'v4.db');
    makeV4(p);
    expect(SCHEMA_VERSION).toBe(TASK_SCHEMA_VERSION);
    const db = openDb(p, { experimentsJsonl: null });
    expect(db.schemaVersion()).toBe(5);
    expect(db.getRun('r1')!.taskId).toBe('todo');
    expect(db.getExperiment('exp-0001')!.taskId).toBe('todo');
    expect(db.getBestVerified()!.configId).toBe('baseline');
    expect(db.getBestVerified('todo')!.taskId).toBe('todo');
    expect(db.getBestVerified('tiny-depth')).toBeNull();
    expect(db.listTaskIds()).toEqual(['todo']);
    expect(() => db.raw.prepare(`DELETE FROM runs`).run()).toThrow(/append-only/);
    expect(() => db.raw.prepare(`UPDATE best_history SET task_id = 'x'`).run()).toThrow(/immutable/);
    expect(() => db.raw.prepare(`UPDATE runs SET task_id = 'x' WHERE run_id = 'r1'`).run()).toThrow(/immutable: finished run/);
    db.close();
    // Reopening is a no-op.
    const again = openDb(p, { experimentsJsonl: null });
    expect(again.schemaVersion()).toBe(5);
    again.close();
  });

  it('a read-only viewer of a v4 DB sees everything as todo and nothing for other tasks', () => {
    const p = join(dir, 'v4ro.db');
    makeV4(p);
    const db = openDbReadOnly(p);
    expect(db.schemaVersion()).toBe(4);
    expect(db.getBestVerified()!.configId).toBe('baseline');
    expect(db.listRuns({ taskId: 'todo' })).toHaveLength(1);
    expect(db.listRuns({ taskId: 'tiny-depth' })).toHaveLength(0);
    expect(db.listExperiments({ taskId: 'tiny-depth' })).toHaveLength(0);
    expect(db.getBestVerified('tiny-depth')).toBeNull();
    expect(db.listExperimentsWithAggregates()[0].taskId).toBe('todo');
    expect(db.getOverview('tiny-depth').runsTotal).toBe(0);
    db.close();
  });

  it('best, baseline and promotion chains are independent per task', () => {
    const db = openDb(':memory:');
    for (const id of ['baseline', 'experiments/001', 'experiments/002']) db.ensureConfig({ configId: id, hash: id, parentId: null, path: id, hypothesis: null });
    const t = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'b', provider: 'p', model: 'm', status: 'verifying' });
    const m = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'b', provider: 'p', model: 'm', status: 'verifying', taskId: 'tiny-depth' });
    db.updateExperiment(t.id, { summary: summary(1000), status: 'completed', outcome: 'baseline' });
    db.updateExperiment(m.id, { summary: summary(90000), status: 'completed', outcome: 'baseline' });
    db.recordPromotion({ experimentId: t.id, configId: 'baseline', summary: summary(1000) });
    // The same config can be the best of another task; taskId comes from the experiment.
    const bm = db.recordPromotion({ experimentId: m.id, configId: 'baseline', summary: summary(90000) });
    expect(bm.taskId).toBe('tiny-depth');
    expect(bm.previousConfigId).toBeNull(); // no earlier best for this task
    expect(db.getBestVerified()!.medianTokens).toBe(1000);
    expect(db.getBestVerified('tiny-depth')!.medianTokens).toBe(90000);

    const c = db.insertExperiment({ kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: 'experiments/001', hypothesis: 'h', provider: 'p', model: 'm', status: 'verifying', taskId: 'tiny-depth' });
    db.insertRunStart({ runId: 'm1', experimentId: c.id, configId: 'experiments/001', seed: 1, phase: 'verify', suite: 'dev', taskId: 'tiny-depth' });
    db.finishRun('m1', { ...fakeCoding({ runId: 'm1', configId: 'experiments/001', tokens: 60000 }), taskId: 'tiny-depth' }, true);
    const e2 = db.recordPromotion({ experimentId: c.id, configId: 'experiments/001', summary: summary(60000) });
    expect(e2.previousConfigId).toBe('baseline');
    expect(e2.previousMedianTokens).toBe(90000);
    expect(db.getBestVerified()!.configId).toBe('baseline'); // todo untouched
    expect(db.getBestHistory('tiny-depth').map((b) => b.configId)).toEqual(['baseline', 'experiments/001']);
    expect(db.getBestHistory('todo')).toHaveLength(1);

    expect(db.listTaskIds()).toEqual(['todo', 'tiny-depth']);
    expect(db.listExperiments({ taskId: 'tiny-depth' }).map((e) => e.id)).toEqual([m.id, c.id]);
    expect(db.listRuns({ taskId: 'tiny-depth' }).map((r) => r.runId)).toEqual(['m1']);
    expect(db.listRuns({ taskId: 'todo' })).toHaveLength(0);
    // Improvement is computed against the best of each experiment's own task.
    const rows = db.listExperimentsWithAggregates();
    expect(rows.find((r) => r.id === c.id)!.improvementVsBestPct).toBe(0);
    // Overview: best and baseline of the requested task.
    expect(db.getOverview().best!.configId).toBe('baseline');
    const om = db.getOverview('tiny-depth');
    expect(om.best!.configId).toBe('experiments/001');
    expect(om.baseline!.medianTokens).toBe(90000);
    expect(om.experimentsTotal).toBe(2);
    expect(om.runsTotal).toBe(1);
    expect(db.getPassRateByConfig('tiny-depth').map((r) => r.configId)).toEqual(['experiments/001']);
    expect(db.getTokensVsQuality('todo')).toHaveLength(0);
    db.close();
  });
});
