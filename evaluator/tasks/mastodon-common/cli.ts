/**
 * Manual / validation entry point for the hidden Mastodon evaluators.
 *
 *   npx tsx evaluator/tasks/mastodon-common/cli.ts <taskId> --reference        # upstream reference.diff
 *   npx tsx evaluator/tasks/mastodon-common/cli.ts <taskId> --bare             # bare checkpoint (empty patch)
 *   npx tsx evaluator/tasks/mastodon-common/cli.ts <taskId> --patch <file>     # any workspace.patch
 *   options: --out <dir> (default /tmp/frugal-mastodon-eval/<taskId>-<mode>), --image <base image tag>
 *
 * Prints one line per check and the summary; exit code 0 iff the evaluation passed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const taskId = argv[0];
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!taskId || !/^mastodon-[a-z-]+$/.test(taskId)) {
  console.error('usage: cli.ts <mastodon-taskId> (--reference | --bare | --patch <file>) [--out dir] [--image tag]');
  process.exit(2);
}
const mode = argv.includes('--reference') ? 'reference' : argv.includes('--bare') ? 'bare' : opt('--patch') ? 'patch' : null;
if (!mode) {
  console.error('one of --reference, --bare, --patch <file> is required');
  process.exit(2);
}
const patchFile = mode === 'reference' ? path.join(here, '..', taskId, 'reference.diff') : mode === 'bare' ? null : path.resolve(opt('--patch')!);
const outDir = path.resolve(opt('--out') ?? path.join(os.tmpdir(), 'frugal-mastodon-eval', `${taskId}-${mode}`));
const mod = (await import(path.join(here, '..', taskId, 'index.ts'))) as typeof import('../mastodon-bookmarks/index.js');
const t0 = Date.now();
const r = await mod.evaluateTask({ runId: `validate-${taskId}-${mode}-${Date.now()}`, patchFile, suite: 'dev', seed: 1, outDir, image: opt('--image') });
for (const c of r.checks) console.log(`${c.outcome.padEnd(5)} ${c.mandatory ? 'M' : 'o'} ${c.id}${c.outcome !== 'pass' && c.message ? `  — ${c.message.split('\n')[0].slice(0, 220)}` : ''}`);
const m = r.checks.filter((c) => c.mandatory);
console.log(`\nmandatory ${m.filter((c) => c.outcome === 'pass').length}/${m.length}, optional ${r.checks.filter((c) => !c.mandatory && c.outcome === 'pass').length}/${r.checks.filter((c) => !c.mandatory).length}`);
console.log(`passed=${r.passed} evaluatorFailure=${r.evaluatorFailure} wall=${((Date.now() - t0) / 1000).toFixed(0)}s report=${r.reportFile}`);
if (r.failureSummary) console.log(r.failureSummary);
process.exit(r.passed ? 0 : 1);
