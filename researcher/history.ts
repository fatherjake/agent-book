/**
 * Compact, token-efficient history digest for the research agent.
 *
 * Information-flow rules (TASK §7, §11):
 *  - Holdout results are reduced to a single passed/failed bit per experiment. Holdout runs,
 *    evaluations, check ids and messages are never read here.
 *  - Dev failures include check ids and short, truncated messages. Messages of 'browser'
 *    checks are dropped (they may paraphrase hidden scenario goals); only their ids are shown.
 *  - No evaluator source, scenario text, report paths or screenshots are included.
 */
import type { CheckResult } from '../runner/types.js';
import type { Db, ExperimentListItem } from '../storage/db.js';

export interface HistoryOptions {
  maxExperiments?: number;
  maxMessageChars?: number;
  maxFailedChecksPerExperiment?: number;
}

export interface ExperimentFailureInfo {
  checks: Map<string, { count: number; message?: string; category: CheckResult['category'] }>;
  runStatuses: Map<string, number>;
}

/**
 * The experiments table has no dedicated columns for the agentic researcher's `evidence` and
 * `expectedSavings`; they are stored in the hypothesis text after these markers (shown as-is in the
 * dashboard/CLI experiment detail) and split back out here.
 */
export const EVIDENCE_MARKER = '\n\nEvidence: ';
export const SAVINGS_MARKER = '\n\nExpected savings: ';

export function joinResearchText(hypothesis: string, evidence?: string | null, expectedSavings?: string | null): string {
  let t = hypothesis.trim();
  if (evidence?.trim()) t += EVIDENCE_MARKER + evidence.trim();
  if (expectedSavings?.trim()) t += SAVINGS_MARKER + expectedSavings.trim();
  return t;
}

export function splitResearchText(text: string): { hypothesis: string; evidence?: string; expectedSavings?: string } {
  let rest = text;
  let expectedSavings: string | undefined;
  let evidence: string | undefined;
  const s = rest.indexOf(SAVINGS_MARKER);
  if (s >= 0) {
    expectedSavings = rest.slice(s + SAVINGS_MARKER.length).trim();
    rest = rest.slice(0, s);
  }
  const e = rest.indexOf(EVIDENCE_MARKER);
  if (e >= 0) {
    evidence = rest.slice(e + EVIDENCE_MARKER.length).trim();
    rest = rest.slice(0, e);
  }
  return { hypothesis: rest.trim(), ...(evidence ? { evidence } : {}), ...(expectedSavings ? { expectedSavings } : {}) };
}

const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** Collect dev-suite failure info for one experiment (holdout data is never touched). */
export function devFailures(db: Db, experimentId: string, maxMessageChars = 100): ExperimentFailureInfo {
  const info: ExperimentFailureInfo = { checks: new Map(), runStatuses: new Map() };
  for (const run of db.listRuns({ experimentId })) {
    if (run.phase === 'holdout' || run.suite !== 'dev') continue;
    if (run.status !== 'completed' && run.status !== 'running') info.runStatuses.set(run.status, (info.runStatuses.get(run.status) ?? 0) + 1);
    for (const ev of db.listEvaluations(run.runId)) {
      if (ev.suite !== 'dev') continue;
      if (ev.evaluatorFailure) info.runStatuses.set('evaluator_failure', (info.runStatuses.get('evaluator_failure') ?? 0) + 1);
      if (!ev.appStarted) info.runStatuses.set('app_did_not_start', (info.runStatuses.get('app_did_not_start') ?? 0) + 1);
      for (const c of ev.checks) {
        if (c.outcome === 'pass') continue;
        const cur = info.checks.get(c.id) ?? { count: 0, category: c.category };
        cur.count++;
        if (!cur.message && c.message && c.category !== 'browser') cur.message = oneLine(c.message, maxMessageChars);
        info.checks.set(c.id, cur);
      }
    }
  }
  return info;
}

function describeExperiment(db: Db, e: ExperimentListItem, opts: Required<HistoryOptions>): string {
  const lines: string[] = [];
  const mock = (e.anyMock ? ' [MOCK]' : '') + (e.anyBrowserAgentSkipped ? ' [NO-BROWSER-AGENT]' : '');
  lines.push(
    `- ${e.id}${mock} ${e.kind === 'baseline' ? 'BASELINE ' : e.kind === 'manual' ? 'MANUAL ' : ''}cfg=${e.candidateConfigId ?? '—'} parent=${e.parentConfigId ?? '—'} status=${e.status} outcome=${e.outcome ?? '—'}`,
  );
  if (e.kind !== 'baseline') {
    const r = splitResearchText(e.hypothesis);
    lines.push(`  hypothesis: ${oneLine(r.hypothesis, 300)}`);
    if (r.expectedSavings) lines.push(`  expected savings: ${oneLine(r.expectedSavings, 160)}`);
  }
  if (e.changeSummary) lines.push(`  change: ${oneLine(e.changeSummary, 300)}`);
  const quick = db.listRuns({ experimentId: e.id, phase: 'quick' }).filter((r) => r.status !== 'running');
  const parts: string[] = [];
  if (quick.length) parts.push(`quick: ${quick[0].passed ? 'PASS' : 'FAIL'} ${fmtInt(quick[0].totalTokens)} tok`);
  if (e.verifyRuns) {
    const s = e.summary;
    parts.push(
      `verify: ${e.verifyPasses}/${e.verifyRuns} pass, median ${fmtInt(e.medianTokens)} tok` +
        (s ? `, sd ${fmtInt(Math.sqrt(s.tokenVariance))}` : '') +
        (e.medianVisualScore !== null ? `, visual ${e.medianVisualScore.toFixed(1)}` : ''),
    );
  }
  if (e.meanToolCalls !== null) parts.push(`tool calls ~${Math.round(e.meanToolCalls)}`);
  if (parts.length) lines.push(`  ${parts.join(' | ')}`);
  const f = devFailures(db, e.id, opts.maxMessageChars);
  if (f.runStatuses.size) lines.push(`  run problems: ${[...f.runStatuses].map(([k, n]) => `${k}×${n}`).join(', ')}`);
  if (f.checks.size) {
    const items = [...f.checks.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, opts.maxFailedChecksPerExperiment)
      .map(([id, c]) => `${id}×${c.count}${c.message ? ` ("${c.message}")` : ''}`);
    lines.push(`  failed checks: ${items.join('; ')}`);
  }
  if (e.holdoutPassed !== null) lines.push(`  holdout: ${e.holdoutPassed ? 'passed' : 'failed'}`);
  if (e.error) lines.push(`  error: ${oneLine(e.error, 240)}`);
  return lines.join('\n');
}

/** Build the digest string fed to the research agent. */
export function buildHistoryDigest(db: Db, options: HistoryOptions = {}): string {
  const opts: Required<HistoryOptions> = {
    maxExperiments: options.maxExperiments ?? 40,
    maxMessageChars: options.maxMessageChars ?? 100,
    maxFailedChecksPerExperiment: options.maxFailedChecksPerExperiment ?? 6,
  };
  const all = db.listExperimentsWithAggregates();
  const best = db.getBestVerified();
  const out: string[] = [];

  if (best) {
    const s = best.summary;
    out.push(
      `BEST VERIFIED: ${best.configId} (${best.experimentId}) median ${fmtInt(best.medianTokens)} coding tokens, ${s.passes}/${s.runs} pass, visual ${s.medianVisualScore?.toFixed?.(1) ?? '—'}`,
    );
  } else out.push('BEST VERIFIED: none yet (no configuration has passed all verification runs)');

  const baseline = [...all].reverse().find((e) => e.kind === 'baseline' && e.status === 'completed');
  if (baseline) {
    out.push(
      `BASELINE: median ${fmtInt(baseline.medianTokens)} tokens, ${baseline.verifyPasses}/${baseline.verifyRuns} pass${baseline.summary?.meetsQualityRequirements ? '' : ' (did NOT meet quality requirements)'}${baseline.anyMock ? ' [MOCK]' : ''}`,
    );
    if (best && baseline.medianTokens) out.push(`IMPROVEMENT vs baseline: ${(((baseline.medianTokens - best.medianTokens) / baseline.medianTokens) * 100).toFixed(1)}%`);
  }

  // Aggregate failing dev checks across all experiments.
  const agg = new Map<string, number>();
  for (const e of all) for (const [id, c] of devFailures(db, e.id, opts.maxMessageChars).checks) agg.set(id, (agg.get(id) ?? 0) + c.count);
  if (agg.size) {
    out.push(
      `MOST FREQUENT DEV CHECK FAILURES: ${[...agg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, n]) => `${id}×${n}`)
        .join(', ')}`,
    );
  }
  const outcomes = new Map<string, number>();
  for (const e of all) outcomes.set(e.outcome ?? e.status, (outcomes.get(e.outcome ?? e.status) ?? 0) + 1);
  if (all.length) out.push(`OUTCOMES: ${[...outcomes].map(([k, n]) => `${k} ${n}`).join(', ')} (total ${all.length})`);

  const shown = all.slice(-opts.maxExperiments);
  if (all.length > shown.length) out.push(`(${all.length - shown.length} older experiments omitted)`);
  out.push('EXPERIMENTS (oldest first):');
  if (!shown.length) out.push('- none yet');
  for (const e of shown) out.push(describeExperiment(db, e, opts));
  return out.join('\n');
}
