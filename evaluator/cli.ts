/**
 * Standalone evaluator CLI (manual use).
 *
 *   tsx evaluator/cli.ts --app <dir> [--suite dev|holdout] [--seed N] [--run-id ID]
 *                        [--out <dir>] [--skip-browser-agent] [--json]
 *
 * Exit code: 0 = passed, 1 = app failed, 2 = evaluator failure / usage error.
 */
import path from 'node:path';
import { evaluateRun } from './index.js';
import { seedFromString } from './fixtures.js';

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    'usage: tsx evaluator/cli.ts --app <dir> [--suite dev|holdout] [--seed N] [--run-id ID] [--out <dir>] [--skip-browser-agent] [--json]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) usage(`${flag} needs a value`);
  return v;
};
if (args.includes('--help') || args.includes('-h')) usage();

const appDir = get('--app');
if (!appDir) usage('--app is required');
const suite = (get('--suite') ?? 'dev') as 'dev' | 'holdout';
if (suite !== 'dev' && suite !== 'holdout') usage('--suite must be dev or holdout');
const runId = get('--run-id') ?? `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const seedArg = get('--seed');
const seed = seedArg !== undefined ? Number(seedArg) : seedFromString(runId);
if (!Number.isFinite(seed)) usage('--seed must be a number');
const out = get('--out');

const result = await evaluateRun({
  runId,
  appDir: path.resolve(appDir),
  suite,
  seed,
  skipBrowserAgent: args.includes('--skip-browser-agent'),
  outDir: out ? path.resolve(out) : undefined,
});

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const c of result.checks) {
    const tag = c.outcome === 'pass' ? 'PASS ' : c.outcome === 'fail' ? 'FAIL ' : 'ERROR';
    console.log(`${tag} ${c.mandatory ? '*' : ' '} ${c.id}${c.attempts > 1 ? ` (attempts ${c.attempts})` : ''}${c.outcome !== 'pass' && c.message ? `\n        ${c.message.split('\n')[0]}` : ''}`);
  }
  console.log('');
  console.log(`visual score: ${result.visualScore} (threshold ${result.visualThreshold})`);
  const u = result.evaluatorUsage;
  console.log(
    `evaluator tokens: ${u.totalTokens} in ${u.modelCalls} model calls (input ${u.inputTokens}, output ${u.outputTokens}, cache read ${u.cacheReadTokens}, cache write ${u.cacheWriteTokens}; API-equivalent cost $${u.costUsd.toFixed(4)})`,
  );
  if (result.usageLimitResetAt !== undefined) console.log(`subscription usage limit reached (resets ${result.usageLimitResetAt || 'unknown'})`);
  console.log(`result: ${result.passed ? 'PASSED' : result.evaluatorFailure ? 'EVALUATOR FAILURE (incomplete)' : 'FAILED'}`);
  if (result.failureSummary) console.log(result.failureSummary);
  console.log(`report: ${result.reportFile}`);
}
process.exit(result.passed ? 0 : result.evaluatorFailure ? 2 : 1);
