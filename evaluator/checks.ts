/**
 * Check helpers shared by the evaluator suites.
 *
 * Classification of thrown errors:
 *  - EvaluatorInfraError, or Playwright browser/context crashes → outcome 'error' (evaluator failure)
 *  - everything else (assertion failures, timeouts waiting for app elements, bad API responses,
 *    AppDbError, SeedError) → outcome 'fail' (the app's fault)
 */
import type { CheckResult } from '../runner/types.js';
import { EvaluatorInfraError } from './app-launcher.js';

export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionFailure(message);
}

export function assertEq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionFailure(`${what}: expected ${trunc(e)}, got ${trunc(a)}`);
}

export const trunc = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

const BROWSER_INFRA_PATTERNS = [
  /Target page, context or browser has been closed/i,
  /Browser has been closed/i,
  /browserType\.launch/i,
  /Executable doesn't exist/i,
  /Protocol error/i,
];

export function isInfraError(err: unknown): boolean {
  if (err instanceof EvaluatorInfraError) return true;
  const msg = String((err as Error)?.message ?? err);
  return BROWSER_INFRA_PATTERNS.some((p) => p.test(msg));
}

export interface CheckSpec {
  id: string;
  category: CheckResult['category'];
  mandatory: boolean;
}

/** Runs one check body and converts the outcome into a CheckResult. Never throws. */
export async function runCheck(
  spec: CheckSpec,
  body: () => Promise<string | void>,
  opts: { evidence?: string[]; attempts?: number } = {},
): Promise<CheckResult> {
  try {
    const msg = await body();
    return { ...spec, outcome: 'pass', message: msg || undefined, evidence: opts.evidence, attempts: opts.attempts ?? 1 };
  } catch (err) {
    const infra = isInfraError(err);
    return {
      ...spec,
      outcome: infra ? 'error' : 'fail',
      message: trunc(`${infra ? 'evaluator error: ' : ''}${(err as Error)?.message ?? String(err)}`, 1500),
      evidence: opts.evidence,
      attempts: opts.attempts ?? 1,
    };
  }
}

/** Collects check results; infra errors are re-thrown at the end of a suite when requested. */
export class CheckCollector {
  readonly results: CheckResult[] = [];
  add(r: CheckResult): CheckResult {
    this.results.push(r);
    return r;
  }
  async run(spec: CheckSpec, body: () => Promise<string | void>, evidence?: string[]): Promise<CheckResult> {
    return this.add(await runCheck(spec, body, { evidence }));
  }
  hasInfraError(): boolean {
    return this.results.some((r) => r.outcome === 'error');
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `fn` until it returns a truthy value or the timeout elapses. Errors thrown by fn count as
 * "not yet". On timeout throws AssertionFailure with `message` (+ the last error / value).
 */
export async function waitFor<T>(
  fn: () => Promise<T>,
  message: string,
  opts: { timeoutMs?: number; intervalMs?: number; describe?: (v: T | undefined) => string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  let last: T | undefined;
  let lastErr: unknown;
  for (;;) {
    try {
      last = await fn();
      lastErr = undefined;
      if (last) return last;
    } catch (e) {
      if (isInfraError(e)) throw e;
      lastErr = e;
    }
    if (Date.now() >= deadline) break;
    await sleep(opts.intervalMs ?? 150);
  }
  const detail = lastErr
    ? ` (last error: ${(lastErr as Error).message})`
    : opts.describe
      ? ` (last: ${opts.describe(last)})`
      : '';
  throw new AssertionFailure(`${message}${trunc(detail, 600)}`);
}
