/**
 * The ONLY place where an evaluation's pass/fail is decided.
 *
 * Pass ⇔ the app started
 *       ∧ every mandatory check has outcome 'pass'
 *       ∧ no mandatory check has outcome 'error' (an error = evaluator infrastructure failure: the
 *         evaluation is incomplete → passed=false, classified separately via evaluatorFailure)
 *       ∧ visualScore ≥ threshold
 *
 * The threshold is fixed here (VISUAL_THRESHOLD). Callers may pass a stricter threshold but never a
 * more lenient one: a lower value is clamped up to VISUAL_THRESHOLD, so the research agent can't
 * relax the quality bar through configuration.
 */
import type { CheckResult } from '../runner/types.js';

export const VISUAL_THRESHOLD = 95;

/** Check ids that represent "the app started" (startup category). */
export const STARTUP_CHECK_ID = 'startup.app';

export interface ScoreResult {
  passed: boolean;
  summary: string;
  appStarted: boolean;
  /** True if any mandatory check errored (evaluation incomplete; not the app's fault). */
  evaluatorFailure: boolean;
  effectiveThreshold: number;
  failedMandatory: string[];
  erroredMandatory: string[];
}

export function scoreEvaluation(checks: CheckResult[], visualScore: number, threshold: number = VISUAL_THRESHOLD): ScoreResult {
  const effectiveThreshold = Number.isFinite(threshold) ? Math.max(threshold, VISUAL_THRESHOLD) : VISUAL_THRESHOLD;
  const startup = checks.find((c) => c.id === STARTUP_CHECK_ID);
  const appStarted = startup?.outcome === 'pass';
  const mandatory = checks.filter((c) => c.mandatory);
  const failedMandatory = mandatory.filter((c) => c.outcome === 'fail').map((c) => c.id);
  const erroredMandatory = mandatory.filter((c) => c.outcome === 'error').map((c) => c.id);
  const evaluatorFailure = erroredMandatory.length > 0 || !startup;
  const visual = Number.isFinite(visualScore) ? visualScore : 0;
  const visualOk = visual >= effectiveThreshold;
  const noChecks = mandatory.length === 0;

  const passed = appStarted && !noChecks && failedMandatory.length === 0 && erroredMandatory.length === 0 && visualOk;

  const parts: string[] = [];
  if (!startup) parts.push('no startup check recorded (evaluation incomplete)');
  else if (!appStarted) parts.push(`app did not start${startup.message ? `: ${startup.message.split('\n')[0]}` : ''}`);
  if (noChecks) parts.push('no mandatory checks were run');
  if (failedMandatory.length) parts.push(`${failedMandatory.length} mandatory check(s) failed: ${failedMandatory.join(', ')}`);
  if (erroredMandatory.length)
    parts.push(`evaluator error on ${erroredMandatory.length} mandatory check(s): ${erroredMandatory.join(', ')}`);
  if (!visualOk) parts.push(`visual score ${visual.toFixed(2)} < threshold ${effectiveThreshold}`);
  const passedCount = mandatory.filter((c) => c.outcome === 'pass').length;
  const summary = passed
    ? `PASS: ${passedCount}/${mandatory.length} mandatory checks passed, visual ${visual.toFixed(2)} ≥ ${effectiveThreshold}`
    : `${evaluatorFailure ? 'INCOMPLETE (evaluator failure)' : 'FAIL'}: ${parts.join('; ')}`;

  return { passed, summary, appStarted, evaluatorFailure, effectiveThreshold, failedMandatory, erroredMandatory };
}
