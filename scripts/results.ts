/**
 * npm run results -- [--experiment <id>] [--runs] [--json] [--limit N]
 * Terminal view of experiments and runs from results/benchmark.db. [MOCK] marks mock-provider results.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrExit, type CommandSpec } from '../researcher/cli-args.js';
import { flagTags, fmtDuration, fmtPct, fmtScore, fmtTokens, fmtUsd, MOCK, NO_BROWSER, textTable } from '../researcher/format.js';
import type { Db } from '../storage/db.js';

export const RESULTS_CLI: CommandSpec = {
  command: 'npm run results --',
  summary: `Show experiments and runs from the results database. ${MOCK} marks mock-provider (non-real) results; ${NO_BROWSER} marks evaluations that skipped the browser agent (never eligible for promotion).`,
  flags: [
    { name: 'experiment', type: 'string', description: 'Show detail for one experiment (e.g. exp-0003)' },
    { name: 'runs', type: 'boolean', description: 'List individual runs instead of experiments' },
    { name: 'limit', type: 'number', description: 'Show only the last N rows', integer: true, min: 1 },
    { name: 'json', type: 'boolean', description: 'Print JSON instead of tables' },
    { name: 'db', type: 'string', description: 'SQLite path (default results/benchmark.db or $FRUGAL_DB_PATH)' },
  ],
  examples: ['npm run results', 'npm run results -- --experiment exp-0003', 'npm run results -- --runs --limit 20', 'npm run results -- --json'],
};

function overview(db: Db): string {
  const o = db.getOverview();
  const lines = [
    `Best verified config : ${o.best ? `${o.best.configId} (${o.best.experimentId}) — median ${fmtTokens(o.best.medianTokens)} coding tokens, pass ${fmtPct(o.best.passRate * 100, 0)}` : 'none yet'}`,
    `Baseline             : ${o.baseline ? `median ${fmtTokens(o.baseline.medianTokens)}${o.baseline.meetsQuality ? '' : ' (did not meet quality requirements)'}${flagTags(o.baseline.isMock, false)}` : 'not run yet'}`,
    `Improvement          : ${fmtPct(o.improvementPct)}`,
    `Experiments          : ${o.experimentsTotal} (${o.experimentsFinished} finished) · ${Object.entries(o.experimentsByOutcome).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`,
    `Runs                 : ${o.runsTotal} (${o.runsPassed} passed)`,
    `API-equivalent cost  : ${fmtUsd(o.costByRole.total)} total = coding ${fmtUsd(o.costByRole.coding)} + evaluator ${fmtUsd(o.costByRole.evaluator)} + research ${fmtUsd(o.costByRole.research)}`,
    `Tokens               : coding ${fmtTokens(o.tokensByRole.coding)} · evaluator ${fmtTokens(o.tokensByRole.evaluator)} · research ${fmtTokens(o.tokensByRole.research)}`,
  ];
  lines.push('                       (API-equivalent cost = tokens × local price table; nothing is billed per token on a Claude subscription)');
  if (o.activeSession) lines.push(`Active session       : ${o.activeSession.id} (since ${o.activeSession.startedAt})`);
  if (o.anyMock) lines.push(`${MOCK} Some results come from the mock provider and are not real measurements.`);
  if (o.anyBrowserAgentSkipped) lines.push(`${NO_BROWSER} Some evaluations skipped the browser agent; they are incomplete and never count toward promotion.`);
  return lines.join('\n');
}

function experimentsTable(db: Db, limit?: number): string {
  let list = db.listExperimentsWithAggregates();
  if (limit) list = list.slice(-limit);
  if (!list.length) return 'No experiments yet. Run `npm run research` or `npm run benchmark`.';
  return textTable(
    ['id', 'config', 'parent', 'model', 'status', 'outcome', 'pass', 'median tok', 'vs best', 'API-eq. cost', 'visual', 'time', 'hypothesis'],
    list.map((e) => [
      e.id + flagTags(e.anyMock, e.anyBrowserAgentSkipped),
      e.candidateConfigId ?? '—',
      e.parentConfigId ?? '—',
      e.model,
      e.status,
      e.outcome ?? (e.kind === 'manual' ? 'manual' : '—'),
      e.verifyRuns ? `${e.verifyPasses}/${e.verifyRuns}` : e.kind === 'manual' && e.summary ? `${e.summary.passes}/${e.summary.runs}` : e.quickPassed === null ? '—' : e.quickPassed ? 'quick ✓' : 'quick ✗',
      fmtTokens(e.medianTokens),
      fmtPct(e.improvementVsBestPct),
      fmtUsd(e.totalCostUsd),
      fmtScore(e.medianVisualScore),
      fmtDuration(e.medianDurationMs),
      e.hypothesis.length > 50 ? e.hypothesis.slice(0, 49) + '…' : e.hypothesis,
    ]),
  );
}

function runsTable(db: Db, filter: { experimentId?: string; limit?: number }): string {
  let runs = db.listRuns({ experimentId: filter.experimentId });
  if (filter.limit) runs = runs.slice(-filter.limit);
  if (!runs.length) return 'No runs.';
  return textTable(
    ['run', 'experiment', 'config', 'phase', 'suite', 'status', 'passed', 'coding tok', 'in/out/cacheR/cacheW', 'API-eq. cost', 'visual', 'tools', 'time', 'failure'],
    runs.map((r) => {
      const ev = db.listEvaluations(r.runId).find((x) => x.suite === r.suite);
      return [
        r.runId + flagTags(r.usedMockProvider, ev?.browserAgentSkipped),
        r.experimentId ?? '—',
        r.configId,
        r.phase,
        r.suite,
        r.status,
        r.passed === null ? '…' : r.passed ? 'yes' : 'no',
        fmtTokens(r.totalTokens) + (r.usageEstimated ? ' (est.)' : ''),
        `${fmtTokens(r.inputTokens)}/${fmtTokens(r.outputTokens)}/${fmtTokens(r.cacheReadTokens)}/${fmtTokens(r.cacheWriteTokens)}`,
        fmtUsd(r.costUsd),
        fmtScore(ev?.visualScore),
        r.toolCalls,
        fmtDuration(r.durationMs),
        (r.failureReason ?? ev?.failureSummary ?? '').slice(0, 60),
      ];
    }),
  );
}

function experimentDetail(db: Db, id: string): string {
  const d = db.getExperimentDetail(id);
  if (!d) return `Experiment ${id} not found.`;
  const e = d.experiment;
  const lines = [
    `Experiment ${e.id}${flagTags(e.anyMock, e.anyBrowserAgentSkipped)}  [${e.kind}]`,
    `  status/outcome : ${e.status} / ${e.outcome ?? '—'}`,
    `  config         : ${e.candidateConfigId ?? '—'} (parent ${e.parentConfigId ?? '—'})${d.config ? `, hash ${d.config.hash.slice(0, 12)}` : ''}`,
    `  model          : ${e.provider}/${e.model}`,
    `  created        : ${e.createdAt}${e.finishedAt ? ` → ${e.finishedAt}` : ''}`,
    `  hypothesis     : ${e.hypothesis}`,
    `  change         : ${e.changeSummary ?? '—'}`,
    `  eligible       : ${e.summary?.meetsQualityRequirements ? 'yes (all runs passed, real provider, full evaluation)' : `no${e.anyMock ? ` ${MOCK}` : ''}${e.anyBrowserAgentSkipped ? ` ${NO_BROWSER}` : ''}`}`,
    `  quick run      : ${e.quickPassed === null ? '—' : e.quickPassed ? 'passed' : 'failed'}`,
    `  verification   : ${e.verifyRuns ? `${e.verifyPasses}/${e.verifyRuns} passed, median ${fmtTokens(e.medianTokens)}, mean ${fmtTokens(e.meanTokens)}${e.summary ? `, sd ${fmtTokens(Math.sqrt(e.summary.tokenVariance))}` : ''}` : '—'}`,
    `  holdout        : ${e.holdoutPassed === null ? '—' : e.holdoutPassed ? 'passed' : 'failed'}`,
    `  tokens by role : coding ${fmtTokens(d.usageByRole.coding.totalTokens)} (${fmtUsd(d.usageByRole.coding.costUsd)}) · evaluator ${fmtTokens(d.usageByRole.evaluator.totalTokens)} (${fmtUsd(d.usageByRole.evaluator.costUsd)}) · research ${fmtTokens(d.usageByRole.research.totalTokens)} (${fmtUsd(d.usageByRole.research.costUsd)})`,
  ];
  if (e.notes) lines.push(`  notes          : ${e.notes}`);
  if (e.error) lines.push(`  error          : ${e.error}`);
  lines.push('', 'Runs:', runsTable(db, { experimentId: id }));
  const failing = d.runs.flatMap((r) => r.evaluations.flatMap((ev) => ev.checks.filter((c) => c.outcome !== 'pass').map((c) => `  ${r.runId} [${ev.suite}] ${c.id} (${c.outcome})${c.message ? `: ${c.message}` : ''}`)));
  if (failing.length) lines.push('', 'Failed checks:', ...failing.slice(0, 40));
  if (e.changes) lines.push('', 'Changes:', e.changes.length > 6000 ? e.changes.slice(0, 6000) + '\n…(truncated)' : e.changes);
  if (d.artifacts.length) lines.push('', `Artifacts (${d.artifacts.length}):`, ...d.artifacts.slice(0, 30).map((a) => `  ${a.kind.padEnd(16)} ${a.path}  sha256:${a.sha256.slice(0, 12)}`));
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseOrExit(process.argv.slice(2), RESULTS_CLI);
  const { openDb } = await import('../storage/db.js');
  const db = openDb(args.db as string | undefined);
  const limit = args.limit as number | undefined;
  if (args.json) {
    const out = args.experiment
      ? db.getExperimentDetail(args.experiment as string)
      : args.runs
        ? db.listRuns({ limit })
        : { overview: db.getOverview(), experiments: db.listExperimentsWithAggregates(), bestHistory: db.getBestHistory() };
    console.log(JSON.stringify(out, null, 2));
  } else if (args.experiment) {
    console.log(experimentDetail(db, args.experiment as string));
  } else if (args.runs) {
    console.log(runsTable(db, { limit }));
  } else {
    console.log(overview(db) + '\n\n' + experimentsTable(db, limit));
  }
  db.close();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`error: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  });
}
