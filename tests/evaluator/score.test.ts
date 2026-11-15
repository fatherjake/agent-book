import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../runner/types.js';
import { scoreEvaluation, STARTUP_CHECK_ID, VISUAL_THRESHOLD } from '../../evaluator/score.js';

const chk = (id: string, outcome: CheckResult['outcome'], mandatory = true, category: CheckResult['category'] = 'backend'): CheckResult => ({
  id,
  category,
  mandatory,
  outcome,
  attempts: 1,
});
const started = chk(STARTUP_CHECK_ID, 'pass', true, 'startup');

describe('scoreEvaluation', () => {
  it('exports the fixed visual threshold of 95', () => {
    expect(VISUAL_THRESHOLD).toBe(95);
  });

  it('passes when the app started, all mandatory checks pass and visual >= threshold', () => {
    const r = scoreEvaluation([started, chk('a', 'pass'), chk('b', 'pass')], 95, 95);
    expect(r.passed).toBe(true);
    expect(r.evaluatorFailure).toBe(false);
    expect(r.appStarted).toBe(true);
    expect(r.summary).toMatch(/^PASS/);
  });

  it('fails on any failed mandatory check', () => {
    const r = scoreEvaluation([started, chk('a', 'pass'), chk('b', 'fail')], 100, 95);
    expect(r.passed).toBe(false);
    expect(r.evaluatorFailure).toBe(false);
    expect(r.failedMandatory).toEqual(['b']);
    expect(r.summary).toMatch(/FAIL.*b/);
  });

  it('ignores failures/errors of optional checks', () => {
    const r = scoreEvaluation([started, chk('a', 'pass'), chk('opt', 'fail', false), chk('opt2', 'error', false)], 99, 95);
    expect(r.passed).toBe(true);
    expect(r.evaluatorFailure).toBe(false);
  });

  it('an error on a mandatory check is an evaluator failure and never a pass', () => {
    const r = scoreEvaluation([started, chk('a', 'pass'), chk('browser.create', 'error', true, 'browser')], 100, 95);
    expect(r.passed).toBe(false);
    expect(r.evaluatorFailure).toBe(true);
    expect(r.erroredMandatory).toEqual(['browser.create']);
    expect(r.summary).toMatch(/INCOMPLETE/);
  });

  it('fails when the visual score is below the threshold', () => {
    const r = scoreEvaluation([started, chk('a', 'pass')], 94.99, 95);
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/visual score 94\.99 < threshold 95/);
  });

  it('fails when the app did not start', () => {
    const r = scoreEvaluation([chk(STARTUP_CHECK_ID, 'fail', true, 'startup')], 0, 95);
    expect(r.passed).toBe(false);
    expect(r.appStarted).toBe(false);
    expect(r.evaluatorFailure).toBe(false);
    expect(r.summary).toMatch(/app did not start/);
  });

  it('a missing startup check means the evaluation is incomplete', () => {
    const r = scoreEvaluation([chk('a', 'pass')], 100, 95);
    expect(r.passed).toBe(false);
    expect(r.evaluatorFailure).toBe(true);
  });

  it('never passes with no checks at all', () => {
    expect(scoreEvaluation([], 100, 95).passed).toBe(false);
  });

  it('clamps a more lenient threshold up to VISUAL_THRESHOLD but accepts a stricter one', () => {
    const lenient = scoreEvaluation([started, chk('a', 'pass')], 90, 50);
    expect(lenient.effectiveThreshold).toBe(95);
    expect(lenient.passed).toBe(false);
    const strict = scoreEvaluation([started, chk('a', 'pass')], 97, 98);
    expect(strict.effectiveThreshold).toBe(98);
    expect(strict.passed).toBe(false);
    expect(scoreEvaluation([started, chk('a', 'pass')], 97, Number.NaN).effectiveThreshold).toBe(95);
  });

  it('treats a non-finite visual score as 0', () => {
    expect(scoreEvaluation([started, chk('a', 'pass')], Number.NaN, 95).passed).toBe(false);
  });
});
