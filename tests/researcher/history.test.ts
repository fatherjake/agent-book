// History digest tests (FAKE data). Key property: holdout details never leak to the research agent.
import { describe, expect, it } from 'vitest';
import { buildHistoryDigest } from '../../researcher/history.js';
import { openDb } from '../../storage/db.js';
import { fakeCoding, fakeEval } from './helpers.js';

describe('history digest', () => {
  it('summarizes experiments, dev failures, and reduces holdout to one bit', () => {
    const db = openDb(':memory:');
    const summary = { configId: 'baseline', runs: 1, passes: 1, passRate: 1, medianTokens: 1000, meanTokens: 1000, tokenVariance: 0, medianVisualScore: 97, totalCostUsd: 0, medianDurationMs: 1, meetsQualityRequirements: true };
    const base = db.insertExperiment({ kind: 'baseline', parentConfigId: null, candidateConfigId: 'baseline', hypothesis: 'Baseline verification', provider: 'anthropic', model: 'm', status: 'verifying' });
    db.insertRunStart({ runId: 'b0', experimentId: base.id, configId: 'baseline', seed: 1, phase: 'verify', suite: 'dev' });
    db.finishRun('b0', fakeCoding({ runId: 'b0', tokens: 1000 }), true);
    db.insertEvaluation(fakeEval({ runId: 'b0', passed: true }));
    // holdout run with a secret scenario message
    db.insertRunStart({ runId: 'h0', experimentId: base.id, configId: 'baseline', seed: 2, phase: 'holdout', suite: 'holdout' });
    db.finishRun('h0', fakeCoding({ runId: 'h0' }), false);
    db.insertEvaluation(
      fakeEval({
        runId: 'h0',
        suite: 'holdout',
        passed: false,
        checks: [{ id: 'holdout.secret-check', category: 'browser', mandatory: true, outcome: 'fail', message: 'SECRET HOLDOUT SCENARIO: rename "Walk the llama"', attempts: 1 }],
      }),
    );
    db.updateExperiment(base.id, { summary, outcome: 'baseline', holdoutPassed: false, status: 'completed' });
    db.recordPromotion({ experimentId: base.id, configId: 'baseline', summary });

    const cand = db.insertExperiment({ kind: 'candidate', parentConfigId: 'baseline', candidateConfigId: 'experiments/001', hypothesis: 'drop list_dir to save tokens', changeSummary: 'disabled list_dir', provider: 'anthropic', model: 'm', status: 'running' });
    db.insertRunStart({ runId: 'c0', experimentId: cand.id, configId: 'experiments/001', seed: 1, phase: 'quick', suite: 'dev' });
    db.finishRun('c0', fakeCoding({ runId: 'c0', tokens: 700 }), false);
    db.insertEvaluation(
      fakeEval({
        runId: 'c0',
        passed: false,
        checks: [
          { id: 'api.patch.validation', category: 'backend', mandatory: true, outcome: 'fail', message: 'PATCH with completed:"yes" returned 200, expected 400', attempts: 1 },
          { id: 'browser.edit', category: 'browser', mandatory: true, outcome: 'fail', message: 'scenario goal: edit "Buy groceries" to something hidden', attempts: 1 },
        ],
      }),
    );
    db.updateExperiment(cand.id, { status: 'rejected', outcome: 'failed_quick_run', quickPassed: false });

    const d = buildHistoryDigest(db);
    expect(d).toContain('BEST VERIFIED: baseline');
    expect(d).toContain('exp-0002');
    expect(d).toContain('drop list_dir to save tokens');
    expect(d).toContain('outcome=failed_quick_run');
    expect(d).toContain('quick: FAIL 700 tok');
    expect(d).toContain('api.patch.validation×1 ("PATCH with completed:"yes" returned 200, expected 400")');
    expect(d).toContain('browser.edit×1');
    expect(d).not.toContain('Buy groceries'); // browser messages dropped
    expect(d).toContain('holdout: failed');
    expect(d).not.toContain('SECRET');
    expect(d).not.toContain('holdout.secret-check');
    expect(d).not.toContain('llama');
    expect(d).toContain('MOST FREQUENT DEV CHECK FAILURES');
    db.close();
  });

  it('handles an empty history', () => {
    const db = openDb(':memory:');
    expect(buildHistoryDigest(db)).toContain('none yet');
    db.close();
  });
});
