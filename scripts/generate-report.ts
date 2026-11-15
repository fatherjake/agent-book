/**
 * npm run report -- [--out <dir>] [--db <path>]
 * Writes results/reports/<timestamp>.md and .json: overview, best config, history, token breakdown
 * by role, cost and pass rates. Mock-provider results are marked [MOCK].
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrExit, type CommandSpec } from '../researcher/cli-args.js';
import { flagTags, fmtDuration, fmtPct, fmtScore, fmtTokens, fmtUsd, MOCK, mdTable, mockTag, NO_BROWSER } from '../researcher/format.js';
import type { Db } from '../storage/db.js';

export const REPORT_CLI: CommandSpec = {
  command: 'npm run report --',
  summary: 'Write a Markdown + JSON research report to results/reports/<timestamp>.{md,json}.',
  flags: [
    { name: 'out', type: 'string', description: 'Output directory (default results/reports)' },
    { name: 'db', type: 'string', description: 'SQLite path (default results/benchmark.db or $FRUGAL_DB_PATH)' },
  ],
  examples: ['npm run report'],
};

export function buildReport(db: Db, opts: { bestConfigDir?: string; now?: Date } = {}): { markdown: string; json: Record<string, unknown> } {
  const now = opts.now ?? new Date();
  const o = db.getOverview();
  const exps = db.listExperimentsWithAggregates();
  const bestHistory = db.getBestHistory();
  const roles = db.costAndTokensByRole();
  const passRates = db.getPassRateByConfig();
  const sessions = db.listSessions();
  const md: string[] = [];

  md.push(`# Token-efficiency research report`, '', `Generated ${now.toISOString()}`, '');
  const realRuns = db.listRuns().filter((r) => !r.usedMockProvider).length;
  if (o.anyMock) md.push(`> ${MOCK} Some results come from the **mock provider**. They are infrastructure tests, not real measurements, and can never be promoted.`, '');
  if (o.anyBrowserAgentSkipped)
    md.push(`> ${NO_BROWSER} Some evaluations **skipped the LLM browser agent**. They are incomplete and never count toward promotion.`, '');
  if (realRuns === 0) md.push('> **No real (non-mock) benchmark run has been recorded yet.**', '');

  md.push('## Overview', '');
  md.push(
    mdTable(
      ['metric', 'value'],
      [
        ['Best verified config', o.best ? `${o.best.configId} (${o.best.experimentId})` : 'none yet'],
        ['Lowest verified median coding tokens', fmtTokens(o.best?.medianTokens)],
        ['Baseline median coding tokens', o.baseline ? `${fmtTokens(o.baseline.medianTokens)}${o.baseline.meetsQuality ? '' : ' (did not qualify)'}${mockTag(o.baseline.isMock)}` : '—'],
        ['Improvement over baseline', fmtPct(o.improvementPct)],
        ['Experiments (finished / total)', `${o.experimentsFinished} / ${o.experimentsTotal}`],
        ['Outcomes', Object.entries(o.experimentsByOutcome).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'],
        ['Runs (passed / total)', `${o.runsPassed} / ${o.runsTotal}`],
        ['Total tokens (coding / evaluator / research)', `${fmtTokens(o.tokensByRole.total)} (${fmtTokens(o.tokensByRole.coding)} / ${fmtTokens(o.tokensByRole.evaluator)} / ${fmtTokens(o.tokensByRole.research)})`],
        ['API-equivalent cost (all roles)', fmtUsd(o.costByRole.total)],
        ['Research sessions', String(sessions.length)],
      ],
    ),
    '',
  );

  md.push('## Best configuration', '');
  if (o.best) {
    const s = o.best.summary;
    md.push(
      `**${o.best.configId}** promoted ${o.best.promotedAt} from ${o.best.experimentId}.`,
      '',
      mdTable(
        ['runs', 'pass rate', 'median tokens', 'mean tokens', 'sd', 'median visual', 'cost (verification)', 'median time'],
        [[s.runs, fmtPct(s.passRate * 100, 0), fmtTokens(s.medianTokens), fmtTokens(s.meanTokens), fmtTokens(Math.sqrt(s.tokenVariance)), fmtScore(s.medianVisualScore), fmtUsd(s.totalCostUsd), fmtDuration(s.medianDurationMs)]],
      ),
      '',
    );
    const exp = db.getExperiment(o.best.experimentId);
    if (exp?.hypothesis) md.push(`Hypothesis: ${exp.hypothesis}`, '');
    if (exp?.holdoutPassed !== null && exp?.holdoutPassed !== undefined) md.push(`Holdout: ${exp.holdoutPassed ? 'passed' : 'failed'}`, '');
    const dir = opts.bestConfigDir ?? join('results', 'best-config');
    if (existsSync(dir)) md.push(`Files: \`${dir}/\` (${readdirSync(dir).join(', ')})`, '');
  } else md.push('No configuration has passed all verification runs yet.', '');

  md.push('## Best verified token usage over time', '');
  md.push(
    bestHistory.length
      ? mdTable(['#', 'promoted', 'config', 'experiment', 'median tokens', 'previous'], bestHistory.map((b, i) => [i + 1, b.promotedAt, b.configId, b.experimentId, fmtTokens(b.medianTokens), b.previousConfigId ? `${b.previousConfigId} (${fmtTokens(b.previousMedianTokens)})` : '—']))
      : 'No promotions yet.',
    '',
  );

  md.push('## Experiment history', '');
  md.push(
    exps.length
      ? mdTable(
          ['id', 'model', 'config', 'outcome', 'pass', 'median tokens', 'vs best', 'cost', 'visual', 'time', 'hypothesis'],
          exps.map((e) => [
            e.id + flagTags(e.anyMock, e.anyBrowserAgentSkipped),
            e.model,
            e.candidateConfigId ?? '—',
            e.outcome ?? (e.kind === 'manual' ? `manual (${e.status})` : e.status),
            e.verifyRuns ? `${e.verifyPasses}/${e.verifyRuns}` : e.kind === 'manual' && e.summary ? `${e.summary.passes}/${e.summary.runs}` : e.quickPassed === null ? '—' : e.quickPassed ? 'quick ✓' : 'quick ✗',
            fmtTokens(e.medianTokens),
            fmtPct(e.improvementVsBestPct),
            fmtUsd(e.totalCostUsd),
            fmtScore(e.medianVisualScore),
            fmtDuration(e.medianDurationMs),
            e.hypothesis.length > 90 ? e.hypothesis.slice(0, 89) + '…' : e.hypothesis,
          ]),
        )
      : 'No experiments yet.',
    '',
  );

  md.push('## Token breakdown by role', '');
  md.push(
    mdTable(
      ['role', 'input', 'output', 'reasoning', 'cache read', 'cache write', 'total', 'calls', 'API-equiv. cost', 'estimated?'],
      (['coding', 'evaluator', 'research'] as const).map((r) => {
        const t = roles[r];
        return [r, fmtTokens(t.inputTokens), fmtTokens(t.outputTokens), fmtTokens(t.reasoningTokens), fmtTokens(t.cacheReadTokens), fmtTokens(t.cacheWriteTokens), fmtTokens(t.totalTokens), t.modelCalls, fmtUsd(t.costUsd), t.anyEstimated ? 'some' : 'no'];
      }),
    ),
    '',
    'Coding tokens are the optimization metric. Costs are API-equivalent: computed from a local price table. On a Claude subscription (claude-code) nothing is billed per token, so they only indicate what the same usage would cost on the API.',
    '',
  );

  md.push('## Pass rate by configuration (dev suite)', '');
  md.push(
    passRates.length
      ? mdTable(['config', 'runs', 'passes', 'pass rate', 'median tokens'], passRates.map((p) => [p.configId + mockTag(p.anyMock), p.runs, p.passes, fmtPct(p.passRate * 100, 0), fmtTokens(p.medianTokens)]))
      : 'No runs yet.',
    '',
  );

  md.push('## API-equivalent cost', '');
  const series = db.getResearchCostOverTime();
  md.push(`API-equivalent total ${fmtUsd(o.costByRole.total)}: coding ${fmtUsd(o.costByRole.coding)}, evaluator ${fmtUsd(o.costByRole.evaluator)}, research ${fmtUsd(o.costByRole.research)}.`, '');
  if (sessions.length)
    md.push(
      mdTable(
        ['session', 'started', 'status', 'stop reason', 'experiments', 'tokens', 'token budget', 'API-equiv. cost', 'cost budget', 'usage-limit waits'],
        sessions.map((s) => {
          const waits = db.listUsageLimitWaits({ sessionId: s.id });
          const waitedMs = waits.reduce((a, w) => a + w.waitedMs, 0);
          return [
            s.id + mockTag(s.isMock),
            s.startedAt,
            s.status,
            s.stopReason ?? '—',
            s.experimentsRun,
            fmtTokens(db.sessionTokens(s.id).total),
            s.budgets.maxTotalTokens ? fmtTokens(s.budgets.maxTotalTokens) : '—',
            fmtUsd(db.sessionSpend(s.id).total),
            s.budgets.maxResearchCostUsd === null || s.budgets.maxResearchCostUsd === undefined ? 'off' : fmtUsd(s.budgets.maxResearchCostUsd),
            waits.length ? `${waits.length} (${fmtDuration(waitedMs)})` : '—',
          ];
        }),
      ),
      '',
    );

  const json = {
    generatedAt: now.toISOString(),
    overview: o,
    best: o.best,
    bestHistory,
    experiments: exps.map(({ changes, ...rest }) => ({ ...rest, changesBytes: changes.length })),
    tokensByRole: roles,
    passRateByConfig: passRates,
    costOverTime: series,
    sessions: sessions.map((s) => ({ ...s, spent: db.sessionSpend(s.id) })),
    realRuns,
  };
  return { markdown: md.join('\n'), json };
}

async function main(): Promise<void> {
  const args = parseOrExit(process.argv.slice(2), REPORT_CLI);
  const { openDb } = await import('../storage/db.js');
  const { resultsDir } = await import('../runner/env.js');
  const db = openDb(args.db as string | undefined);
  const outDir = (args.out as string | undefined) ?? join(resultsDir(), 'reports');
  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const { markdown, json } = buildReport(db, { now, bestConfigDir: join(resultsDir(), 'best-config') });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let base = join(outDir, stamp);
  for (let i = 1; existsSync(base + '.md'); i++) base = join(outDir, `${stamp}-${i}`); // never overwrite
  writeFileSync(base + '.md', markdown + '\n');
  writeFileSync(base + '.json', JSON.stringify(json, null, 2) + '\n');
  db.close();
  console.log(`Report written:\n  ${base}.md\n  ${base}.json`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`error: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  });
}
