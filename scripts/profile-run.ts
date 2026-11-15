/**
 * Write profile.json + profile.md (session token profile) into run dirs.
 *
 *   tsx scripts/profile-run.ts --all            every run under results/runs with usage/stream/trace data
 *   tsx scripts/profile-run.ts <runId> [...]    specific runs
 *   options: --print (print profile.md), --max-chars N
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resultsDir } from '../runner/env.js';
import { listProfilableRuns, renderProfileMarkdown, writeSessionProfile } from '../researcher/session-profile.js';

function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const print = args.includes('--print');
  const mi = args.indexOf('--max-chars');
  const maxChars = mi >= 0 ? Number(args[mi + 1]) : undefined;
  const ids = args.filter((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1));
  if (!all && !ids.length) {
    console.error('usage: tsx scripts/profile-run.ts [--all | <runId> ...] [--print] [--max-chars N]');
    process.exit(2);
  }
  const root = resultsDir();
  const dirs = all ? listProfilableRuns(root) : ids.map((id) => join(root, 'runs', id));
  let failed = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      console.error(`skip ${dir}: not found`);
      failed++;
      continue;
    }
    try {
      const p = writeSessionProfile(dir, { maxChars });
      console.log(`${p.runId}: ${p.backend}, ${p.totals.modelCalls} calls, ${p.totals.totalTokens} tokens, ${p.tools.length} tool calls, ${p.waste.length} waste signals → profile.json, profile.md`);
      if (print) console.log('\n' + renderProfileMarkdown(p, { maxChars }) + '\n');
    } catch (e) {
      failed++;
      console.error(`failed ${dir}: ${(e as Error)?.stack ?? e}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main();
