// Storage tests. All run/evaluation data here is FAKE (see tests/researcher/helpers.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, openDbReadOnly, SCHEMA_VERSION, type Db } from '../../storage/db.js';
import type { UsageRecord } from '../../runner/types.js';
import { fakeCoding, fakeEval, makeTmp, rmTmp } from '../researcher/helpers.js';

function usage(id: string, role: UsageRecord['role'], tokens: number, cost: number, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    role,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    timestamp: new Date().toISOString(),
    inputTokens: tokens,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningIncludedInOutput: true,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: tokens,
    costUsd: cost,
    costEstimated: true,
    usageEstimated: false,
    purpose: 'test',
    raw: { input_tokens: tokens },
    ...extra,
  };
}

describe('storage/db', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    db = openDb(join(dir, 'benchmark.db'));
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('creates the schema with WAL and user_version', () => {
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    const tables = (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['experiments', 'runs', 'evaluations', 'usage_records', 'artifacts', 'configs', 'research_sessions', 'best_history'])
      expect(tables).toContain(t);
    db.close();
    db = openDb(join(dir, 'benchmark.db')); // re-open: migrations idempotent
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it('inserts and finishes runs, evaluations, artifacts', () => {
    const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'b', provider: 'anthropic', model: 'm', status: 'verifying' });
    expect(exp.id).toBe('exp-0001');
    db.insertRunStart({ runId: 'r1', experimentId: exp.id, configId: 'baseline', seed: 7, phase: 'verify', suite: 'dev' });
    expect(db.getRun('r1')!.status).toBe('running');
    const c = fakeCoding({ runId: 'r1', tokens: 1234, costUsd: 0.5 });
    db.finishRun('r1', c, true);
    db.insertEvaluation(fakeEval({ runId: 'r1', passed: true, visual: 96.5, costUsd: 0.1 }));
    db.insertArtifact({ runId: 'r1', kind: 'trace', path: 'results/runs/r1/trace.jsonl', sha256: 'ab', bytes: 10 });
    const run = db.getRun('r1')!;
    expect(run.status).toBe('completed');
    expect(run.totalTokens).toBe(1234);
    expect(run.passed).toBe(true);
    expect(db.listEvaluations('r1')[0].visualScore).toBe(96.5);
    const detail = db.getExperimentDetail(exp.id)!;
    expect(detail.runs).toHaveLength(1);
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.usageByRole.coding.costUsd).toBeCloseTo(0.5);
    expect(detail.usageByRole.evaluator.costUsd).toBeCloseTo(0.1);
  });

  it('enforces append-only rules', () => {
    const exp = db.insertExperiment({ kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: 'experiments/001', hypothesis: 'h', provider: 'p', model: 'm', status: 'running' });
    db.insertRunStart({ runId: 'r1', experimentId: exp.id, configId: 'experiments/001', seed: 1, phase: 'quick', suite: 'dev' });
    db.finishRun('r1', fakeCoding({ runId: 'r1' }), false);
    db.insertEvaluation(fakeEval({ runId: 'r1', passed: false }));
    db.insertUsageRecords([usage('u1', 'research', 10, 0.01)]);

    for (const t of ['experiments', 'runs', 'evaluations', 'usage_records'])
      expect(() => db.raw.prepare(`DELETE FROM ${t}`).run()).toThrow(/append-only/);
    // finished run cannot be modified
    expect(() => db.raw.prepare(`UPDATE runs SET total_tokens = 1 WHERE run_id = 'r1'`).run()).toThrow(/immutable/);
    expect(() => db.raw.prepare(`UPDATE evaluations SET passed = 1`).run()).toThrow(/immutable/);
    expect(() => db.raw.prepare(`UPDATE usage_records SET cost_usd = 0`).run()).toThrow(/immutable/);
    // experiment: status transitions allowed while active, then frozen
    db.updateExperiment(exp.id, { status: 'rejected', outcome: 'failed_quick_run' });
    expect(() => db.updateExperiment(exp.id, { outcome: 'promoted' })).toThrow(/immutable/);
    // configs: promoted_at set once
    db.insertConfig({ configId: 'experiments/001', hash: 'h1', parentId: 'baseline', path: 'configs/experiments/001', hypothesis: 'h' });
    expect(() => db.raw.prepare(`UPDATE configs SET hash = 'x'`).run()).toThrow(/immutable/);
  });

  it('keeps coding, evaluator and research totals separate', () => {
    const exp = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'b', provider: 'p', model: 'm', sessionId: 's1' });
    db.createSession({ id: 's1', budgets: { maxExperiments: 1, maxResearchCostUsd: 1, maxTokensPerCodingRun: null, maxRuntimePerExperimentSec: 1, maxTotalDurationSec: 1, verificationRuns: 1 } });
    db.insertRunStart({ runId: 'r1', experimentId: exp.id, configId: 'baseline', seed: 1, phase: 'verify', suite: 'dev' });
    db.finishRun('r1', fakeCoding({ runId: 'r1', tokens: 1000, costUsd: 2 }), true);
    db.insertEvaluation(fakeEval({ runId: 'r1', passed: true, costUsd: 0.25 }));
    db.insertUsageRecords([usage('c1', 'coding', 1000, 2, { runId: 'r1' })], { sessionId: 's1' });
    db.insertUsageRecords([usage('x1', 'research', 500, 0.75), usage('x2', 'research', 100, 0.25)], { sessionId: 's1', experimentId: exp.id });
    // duplicate ids ignored
    expect(db.insertUsageRecords([usage('x1', 'research', 500, 0.75)], { sessionId: 's1' })).toBe(0);

    const roles = db.costAndTokensByRole();
    expect(roles.coding.costUsd).toBeCloseTo(2);
    expect(roles.coding.totalTokens).toBe(1000);
    expect(roles.evaluator.costUsd).toBeCloseTo(0.25);
    expect(roles.research.costUsd).toBeCloseTo(1);
    expect(roles.research.totalTokens).toBe(600);
    const spend = db.sessionSpend('s1');
    expect(spend.total).toBeCloseTo(3.25);
    expect(db.usageRecordTotalsByRole().coding.totalTokens).toBe(1000);
    const ov = db.getOverview();
    expect(ov.costByRole.total).toBeCloseTo(3.25);
    expect(db.listUsageRecords({ role: 'research' })).toHaveLength(2);
    expect(db.listUsageRecords({ role: 'research' })[0].raw).toEqual({ input_tokens: 500 });
  });

  it('records promotions, best history, overview and aggregates', () => {
    const base = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'b', provider: 'p', model: 'm', status: 'verifying' });
    const summary = { configId: 'baseline', runs: 2, passes: 2, passRate: 1, medianTokens: 1000, meanTokens: 1000, tokenVariance: 0, medianVisualScore: 97, totalCostUsd: 0, medianDurationMs: 1, meetsQualityRequirements: true };
    for (const [i, t] of [900, 1100].entries()) {
      db.insertRunStart({ runId: `b${i}`, experimentId: base.id, configId: 'baseline', seed: i, phase: 'verify', suite: 'dev' });
      db.finishRun(`b${i}`, fakeCoding({ runId: `b${i}`, tokens: t }), true);
    }
    db.updateExperiment(base.id, { summary, outcome: 'baseline', status: 'completed' });
    db.ensureConfig({ configId: 'baseline', hash: 'h', parentId: null, path: 'configs/baseline', hypothesis: null });
    db.recordPromotion({ experimentId: base.id, configId: 'baseline', summary });
    expect(() => db.recordPromotion({ experimentId: base.id, configId: 'baseline', summary: { ...summary, usedMockProvider: true } })).toThrow(/mock/);
    expect(() => db.recordPromotion({ experimentId: base.id, configId: 'baseline', summary: { ...summary, meetsQualityRequirements: false } })).toThrow(/quality/);

    const cand = db.insertExperiment({ kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: 'experiments/001', hypothesis: 'h', provider: 'p', model: 'm', status: 'verifying' });
    db.recordPromotion({ experimentId: cand.id, configId: 'experiments/001', summary: { ...summary, configId: 'experiments/001', medianTokens: 800 } });
    const hist = db.getBestHistory();
    expect(hist.map((h) => h.medianTokens)).toEqual([1000, 800]);
    expect(hist[1].previousConfigId).toBe('baseline');
    expect(db.getConfig('baseline')!.promotedAt).not.toBeNull();
    const ov = db.getOverview();
    expect(ov.best!.configId).toBe('experiments/001');
    expect(ov.baseline!.medianTokens).toBe(1000);
    expect(ov.improvementPct).toBeCloseTo(20);
    const list = db.listExperimentsWithAggregates();
    expect(list[0].medianTokens).toBe(1000);
    expect(list[0].verifyRuns).toBe(2);
    expect(list[0].improvementVsBestPct).toBeCloseTo(-25);
    expect(db.getPassRateByConfig()[0]).toMatchObject({ configId: 'baseline', runs: 2, passes: 2 });
    expect(db.getTokensVsQuality()).toHaveLength(2);
    expect(db.getResearchCostOverTime().length).toBe(2);
  });

  it('openDbReadOnly exposes queries but rejects writes', () => {
    db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'b', provider: 'p', model: 'm' });
    const ro = openDbReadOnly(join(dir, 'benchmark.db'));
    expect(ro.listExperimentsWithAggregates()).toHaveLength(1);
    expect(ro.getOverview().experimentsTotal).toBe(1);
    expect(() => ro.insertExperiment({ kind: 'candidate', parentConfigId: null, candidateConfigId: null, hypothesis: 'x', provider: 'p', model: 'm' })).toThrow();
    ro.close();
    expect(() => openDbReadOnly(join(dir, 'missing.db'))).toThrow();
  });

  it('appends experiment state changes to experiments.jsonl', () => {
    const e = db.insertExperiment({ kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: null, hypothesis: 'h', provider: 'p', model: 'm' });
    db.updateExperiment(e.id, { status: 'running' });
    db.updateExperiment(e.id, { status: 'failed', outcome: 'error' });
    const f = join(dir, 'experiments.jsonl');
    expect(existsSync(f)).toBe(true);
    const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(['created', 'status:running', 'status:failed']);
    expect(lines[2].experiment.outcome).toBe('error');
  });

  it('recovers interrupted sessions, experiments and runs', () => {
    db.createSession({ id: 's1', budgets: { maxExperiments: 1, maxResearchCostUsd: 1, maxTokensPerCodingRun: null, maxRuntimePerExperimentSec: 1, maxTotalDurationSec: 1, verificationRuns: 1 } });
    const e = db.insertExperiment({ kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: 'experiments/001', hypothesis: 'h', provider: 'p', model: 'm', status: 'verifying', sessionId: 's1' });
    db.insertRunStart({ runId: 'r1', experimentId: e.id, configId: 'experiments/001', seed: 1, phase: 'verify', suite: 'dev' });
    const r = db.recoverInterrupted();
    expect(r).toEqual({ sessions: 1, experiments: 1, runs: 1 });
    expect(db.getExperiment(e.id)!.status).toBe('interrupted');
    expect(db.getRun('r1')!.status).toBe('interrupted');
    expect(db.getSession('s1')!.status).toBe('interrupted');
  });
});
