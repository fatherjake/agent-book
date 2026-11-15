/**
 * npm run results -- [--experiment <id>] [--runs] [--json] [--limit N] [--task <id>]
 * npm run results -- --flag-cheating <run|experiment|config> --reason "..."   (or --clear-flag, --flags)
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
    { name: 'task', type: 'string', description: 'Only this benchmark task (e.g. todo, mastodon-bookmarks); best/baseline are per task (default view: todo best, all experiments)' },
    { name: 'db', type: 'string', description: 'SQLite path (default results/benchmark.db or $FRUGAL_DB_PATH)' },
    {
      name: 'flag-cheating',
      type: 'string',
      description:
        'Mark the config behind a run id, experiment id or config id as CHEATING (needs --reason). It is rejected (a running candidate stops before its next run), removed from best together with configs derived from it, and shown to the research agent',
    },
    { name: 'clear-flag', type: 'string', description: 'Undo a cheating flag for a run/experiment/config (needs --reason; the flag history is kept)' },
    { name: 'reason', type: 'string', description: 'Why (required with --flag-cheating / --clear-flag; shown to the research agent)' },
    { name: 'flags', type: 'boolean', description: 'List all cheating flags' },
  ],
  examples: [
    'npm run results',
    'npm run results -- --experiment exp-0003',
    'npm run results -- --runs --limit 20',
    'npm run results -- --json',
    'npm run results -- --task mastodon-bookmarks',
    'npm run results -- --flag-cheating exp-0012 --reason "skill embeds a prebuilt server.js"',
    'npm run results -- --clear-flag exp-0012 --reason "false alarm: the helper only runs curl"',
  ],
};

function overview(db: Db, taskId?: string): string {
  const o = db.getOverview(taskId);
  const tasks = db.listTaskIds();
  const lines = [
    ...(taskId || tasks.length > 1 ? [`Task                 : ${taskId ?? 'todo'}${taskId ? '' : ` (best/baseline; other tasks: ${tasks.filter((t) => t !== 'todo').join(', ')}; use --task)`}`] : []),
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

function experimentsTable(db: Db, limit?: number, taskId?: string): string {
  let list = db.listExperimentsWithAggregates(taskId ? { taskId } : {});
  if (limit) list = list.slice(-limit);
  if (!list.length) return 'No experiments yet. Run `npm run research` or `npm run benchmark`.';
  // The task column appears once more than one task has data.
  const showTask = db.listTaskIds().length > 1;
  return textTable(
    [...(showTask ? ['task'] : []), 'id', 'config', 'parent', 'model', 'status', 'outcome', 'pass', 'median tok', 'vs best', 'API-eq. cost', 'visual', 'time', 'hypothesis'],
    list.map((e) => [
      ...(showTask ? [e.taskId] : []),
      e.id + flagTags(e.anyMock, e.anyBrowserAgentSkipped) + (e.cheating ? ' [CHEATING]' : ''),
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

function runsTable(db: Db, filter: { experimentId?: string; limit?: number; taskId?: string }): string {
  let runs = db.listRuns({ experimentId: filter.experimentId, ...(filter.taskId ? { taskId: filter.taskId } : {}) });
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
    `Experiment ${e.id}${flagTags(e.anyMock, e.anyBrowserAgentSkipped)}${e.cheating ? ' [CHEATING]' : ''}  [${e.kind}]`,
    `  task           : ${e.taskId}`,
    `  status/outcome : ${e.status} / ${e.outcome ?? '—'}`,
    ...(e.cheating
      ? [`  CHEATING       : flagged by ${e.cheating.source} ${e.cheating.flaggedAt}${e.cheating.inherited ? ` (inherited from ${e.cheating.flaggedConfigId})` : ''}: ${e.cheating.reason}`]
      : []),
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
  const taskId = args.task as string | undefined;
  const flagTarget = (args['flag-cheating'] ?? args['clear-flag']) as string | undefined;
  if (flagTarget) {
    const fail = (msg: string): never => {
      console.error(`error: ${msg}`);
      db.close();
      process.exit(2);
    };
    if (args['flag-cheating'] && args['clear-flag']) fail('use either --flag-cheating or --clear-flag, not both');
    const reason = (args.reason as string | undefined)?.trim();
    if (!reason) fail('--reason "..." is required (it is recorded and shown to the research agent)');
    const taskIds = db.listTaskIds();
    const before = new Map(taskIds.map((t) => [t, db.getBestVerified(t)]));
    let f: import('../storage/db.js').FlagRow;
    try {
      f = db.insertFlag({ target: flagTarget, kind: args['flag-cheating'] ? 'cheating' : 'cleared', reason: reason!, source: 'human' });
    } catch (e) {
      return fail((e as Error).message);
    }
    const derived = db
      .listExperimentsWithAggregates()
      .filter((e) => e.cheating?.inherited && e.cheating.flaggedConfigId === f.configId)
      .map((e) => e.id);
    console.log(`${f.kind === 'cheating' ? 'Flagged as CHEATING' : 'Cleared flag on'}: ${f.configId}${f.experimentId ? ` (${f.experimentId})` : ''} — ${f.reason}`);
    if (derived.length) console.log(`  also excluded (derived from it): ${derived.join(', ')}`);
    const { syncPublishedBest, bestConfigDirFor } = await import('../researcher/loop.js');
    const { resultsDir, CONFIGS_DIR } = await import('../runner/env.js');
    const { join, relative } = await import('node:path');
    // Bests are per task: report and republish each task whose best changed.
    for (const t of taskIds) {
      const b0 = before.get(t) ?? null;
      const after = db.getBestVerified(t);
      const label = taskIds.length > 1 ? ` (task ${t})` : '';
      if (b0?.configId !== after?.configId)
        console.log(`  best verified config${label}: ${b0?.configId ?? 'none'} → ${after ? `${after.configId} (${after.experimentId}, median ${fmtTokens(after.medianTokens)})` : 'none'}`);
      const republished = syncPublishedBest(db, { bestConfigDir: join(resultsDir(), 'best-config'), configsRoot: CONFIGS_DIR }, t);
      if (republished) console.log(`  ${relative(process.cwd(), bestConfigDirFor(join(resultsDir(), 'best-config'), t)) || 'best-config'}/ now holds ${republished}`);
    }
    console.log('  A running research session picks this up before its next run.');
    db.close();
    return;
  }
  if (args.flags) {
    const flags = db.listFlags();
    console.log(
      flags.length
        ? textTable(['#', 'when', 'kind', 'config', 'experiment', 'run', 'by', 'reason'], flags.map((f) => [f.id, f.createdAt, f.kind, f.configId, f.experimentId ?? '—', f.runId ?? '—', f.source, f.reason]))
        : 'No flags.',
    );
    db.close();
    return;
  }
  if (args.json) {
    const out = args.experiment
      ? db.getExperimentDetail(args.experiment as string)
      : args.runs
        ? db.listRuns({ limit, ...(taskId ? { taskId } : {}) })
        : {
            overview: db.getOverview(taskId),
            experiments: db.listExperimentsWithAggregates(taskId ? { taskId } : {}),
            bestHistory: db.getBestHistory(taskId),
          };
    console.log(JSON.stringify(out, null, 2));
  } else if (args.experiment) {
    console.log(experimentDetail(db, args.experiment as string));
  } else if (args.runs) {
    console.log(runsTable(db, { limit, taskId }));
  } else {
    console.log(overview(db, taskId) + '\n\n' + experimentsTable(db, limit, taskId));
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
