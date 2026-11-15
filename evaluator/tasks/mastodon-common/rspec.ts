/**
 * RSpec JSON report → CheckResults (pure; unit-tested in rspec.test.ts).
 *
 * Two kinds of checks come out of an rspec run:
 *  - upstream.<spec>:<example>: one check per EXPECTED upstream example (listed by the task with its
 *    full description). An example that is missing from the report (the file failed to load, the
 *    run crashed or timed out) is a 'fail' with the load error as the message.
 *  - regression.<spec>: one check per regression spec file, aggregated: passes iff the file ran at
 *    least one example and none failed. Examples of an upstream file that are not in the expected
 *    upstream list (e.g. the pre-existing examples of a spec file the upstream PR extended) are
 *    aggregated into that file's regression check.
 */
import type { CheckResult } from '../../../runner/types.js';

export interface RspecExample {
  id?: string;
  description?: string;
  full_description: string;
  status: 'passed' | 'failed' | 'pending' | string;
  file_path: string;
  line_number?: number;
  exception?: { class?: string; message?: string; backtrace?: string[] };
}

export interface RspecReport {
  examples: RspecExample[];
  summary?: { example_count?: number; failure_count?: number; pending_count?: number; errors_outside_of_examples_count?: number };
  summary_line?: string;
  messages?: string[];
}

export interface ExpectedExample {
  /** Check id, e.g. 'upstream.bookmarks_controller:index.unauthorized'. */
  id: string;
  /** Spec file relative to the repo root, e.g. 'spec/controllers/api/v1/bookmarks_controller_spec.rb'. */
  file: string;
  /** RSpec full_description (describe/context/it strings joined by spaces). */
  fullDescription: string;
  mandatory: boolean;
}

export interface RegressionSpec {
  file: string;
  mandatory: boolean;
}

const MAX_MSG = 1500;
const trunc = (s: string, n = MAX_MSG) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Normalise './spec/x_spec.rb' → 'spec/x_spec.rb'. */
export const normFile = (f: string) => f.replace(/^\.\//, '');

/** 'spec/controllers/api/v1/favourites_controller_spec.rb' → 'regression.controllers/api/v1/favourites_controller'. */
export function regressionCheckId(file: string): string {
  return `regression.${normFile(file).replace(/^spec\//, '').replace(/_spec\.rb$/, '')}`;
}

/** Extract the JSON object from rspec's --out file content (tolerates leading/trailing noise). */
export function parseRspecJson(text: string): RspecReport | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as RspecReport;
    if (!obj || !Array.isArray(obj.examples)) return null;
    return obj;
  } catch {
    return null;
  }
}

function exampleFailureMessage(e: RspecExample): string {
  const ex = e.exception;
  const where = `${normFile(e.file_path)}:${e.line_number ?? '?'}`;
  if (!ex) return `${where}: ${e.status}`;
  const bt = (ex.backtrace ?? []).filter((l) => !/\/gems\//.test(l)).slice(0, 3).join(' | ');
  return `${where}: ${ex.class ?? 'Error'}: ${ex.message ?? ''}${bt ? ` [${bt}]` : ''}`;
}

/** Errors that happened outside examples (load errors), compacted for check messages. */
export function loadErrors(report: RspecReport | null): string {
  if (!report) return '';
  const msgs = (report.messages ?? []).filter((m) => /error|exception|uninitialized|undefined|NameError|NoMethodError|LoadError/i.test(m));
  return trunc(msgs.join('\n').replace(/\n{2,}/g, '\n'), 1000);
}

export interface RspecRunInfo {
  /** Parsed report, or null if the run produced none. */
  report: RspecReport | null;
  /** Why the report is missing / incomplete (timeout, crash, exit code), for messages. */
  note?: string;
}

/** Build upstream checks for the expected examples from one or more rspec runs (merged). */
export function upstreamChecks(expected: ExpectedExample[], runs: RspecRunInfo[]): CheckResult[] {
  const all = runs.flatMap((r) => r.report?.examples ?? []);
  const byKey = new Map<string, RspecExample>();
  for (const e of all) byKey.set(`${normFile(e.file_path)}\u0000${e.full_description}`, e);
  const loadMsg = runs
    .map((r) => [r.note, loadErrors(r.report)].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('\n');
  return expected.map((x) => {
    const e = byKey.get(`${x.file}\u0000${x.fullDescription}`);
    const base = { id: x.id, category: 'backend' as const, mandatory: x.mandatory, attempts: 1 };
    if (!e) {
      return { ...base, outcome: 'fail' as const, message: trunc(`example did not run (spec file failed to load or the run aborted)${loadMsg ? `: ${loadMsg}` : ''}`) };
    }
    if (e.status === 'passed') return { ...base, outcome: 'pass' as const };
    return { ...base, outcome: 'fail' as const, message: trunc(exampleFailureMessage(e)) };
  });
}

/**
 * Aggregated regression checks per file. `exclude` = full descriptions (per file) that are upstream
 * checks and therefore not part of the regression aggregate.
 */
export function regressionChecks(specs: RegressionSpec[], runs: RspecRunInfo[], exclude: ExpectedExample[] = []): CheckResult[] {
  const all = runs.flatMap((r) => r.report?.examples ?? []);
  const excluded = new Set(exclude.map((x) => `${x.file}\u0000${x.fullDescription}`));
  const loadMsg = runs
    .map((r) => [r.note, loadErrors(r.report)].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('\n');
  return specs.map((s) => {
    const file = normFile(s.file);
    const ex = all.filter((e) => normFile(e.file_path) === file && !excluded.has(`${file}\u0000${e.full_description}`));
    const base = { id: regressionCheckId(file), category: 'backend' as const, mandatory: s.mandatory, attempts: 1 };
    if (ex.length === 0) {
      return { ...base, outcome: 'fail' as const, message: trunc(`no examples ran for ${file}${loadMsg ? `: ${loadMsg}` : ''}`) };
    }
    const failed = ex.filter((e) => e.status === 'failed');
    const passed = ex.filter((e) => e.status === 'passed').length;
    if (failed.length === 0) return { ...base, outcome: 'pass' as const, message: `${passed}/${ex.length} examples passed${ex.length > passed ? ' (rest pending)' : ''}` };
    return {
      ...base,
      outcome: 'fail' as const,
      message: trunc(`${failed.length}/${ex.length} examples failed: ${failed.slice(0, 4).map((e) => `${e.full_description} — ${exampleFailureMessage(e)}`).join('\n')}`),
    };
  });
}
