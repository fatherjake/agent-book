/**
 * Shared evaluation pipeline for the brownfield Mastodon tasks (docs/TASKS.md §4).
 *
 *   launch fresh container (base image) → services start → git apply workspace.patch
 *   → copy hidden upstream specs → bin/rails db:migrate                      [startup.patch, startup.migrate]
 *   → in parallel: app start (+ readiness, web UI served)                    [startup.app]
 *                  test DB schema load, then (after app start: memory) rspec [upstream.*, regression.*]
 *                  seed script (rails runner, development DB)
 *   → backend API checks (host fetch)                                        [api.*]
 *   → Playwright UI checks                                                   [ui.*]
 *   → score (evaluator/score.ts decides pass/fail; there is no visual phase, visualScore = 100)
 *
 * Never throws for app failures (they are 'fail' checks). Evaluator infrastructure problems are
 * 'error' checks (evaluatorFailure). The container is always removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { CheckResult, EvaluationResult, TokenTotals } from '../../../runner/types.js';
import { logger } from '../../../runner/logger.js';
import { EvaluatorInfraError } from '../../app-launcher.js';
import { runCheck, sleep, trunc, type CheckSpec } from '../../checks.js';
import { REPO_ROOT } from '../../../runner/env.js';
import { scoreEvaluation, STARTUP_CHECK_ID, VISUAL_THRESHOLD } from '../../score.js';
import type { CmdResult } from '../../docker.js';
import { MASTODON_APP_PORT, MastodonEvalContainer, shq, type SandboxSpec } from './container.js';

/** The container surface the pipeline uses (MastodonEvalContainer; a fake in unit tests). */
export type EvalContainer = Pick<
  MastodonEvalContainer,
  'url' | 'exec' | 'execLogged' | 'spawnBackground' | 'writeFile' | 'copyFileIn' | 'readFile' | 'state' | 'stop' | 'logs'
>;

/** TESTS: replace docker / image resolution / the browser. */
export interface PipelineDeps {
  launch?: (o: { runId: string; image: string; sandbox: SandboxSpec; taskId: string }) => Promise<EvalContainer>;
  resolve?: (taskId: string, image?: string) => Promise<{ image: string; sandbox: SandboxSpec }>;
  launchBrowser?: () => Promise<Browser>;
}
import { MastodonApi } from './http.js';
import { parseRspecJson, regressionChecks, upstreamChecks, type ExpectedExample, type RegressionSpec, type RspecRunInfo } from './rspec.js';

const log = logger('evaluator.mastodon');

export const EVAL_DIR_IN_CONTAINER = '/tmp/frugal-eval';
const zeroUsage = (): TokenTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  modelCalls: 0,
  anyEstimated: false,
});

export interface EvaluateTaskOptions {
  runId: string;
  /** results/runs/<id>/workspace.patch; null or a missing/empty file = the bare checkpoint. */
  patchFile: string | null;
  suite: 'dev' | 'holdout';
  seed: number;
  outDir?: string;
  /** Base image tag (no Claude Code layer). Default: the task's image builder. */
  image?: string;
  /** Passed by the dispatcher (evaluator/index.ts); informational. */
  taskId?: string;
  experimentId?: string;
}

/** What a check body gets. */
export interface MastodonCheckContext {
  c: EvalContainer;
  api: MastodonApi;
  /** Parsed JSON written by the seed script. */
  seed: Record<string, any>;
  /** Run a hidden ruby script from the task dir with `bin/rails runner`; returns its FRUGAL_JSON output. */
  rails: (script: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  browser: Browser | null;
  outDir: string;
  screenshotDir: string;
  suite: 'dev' | 'holdout';
  seedValue: number;
}

export interface TaskCheck {
  spec: CheckSpec;
  run: (ctx: MastodonCheckContext) => Promise<string | void>;
}

export interface MastodonTaskDefinition {
  taskId: string;
  /** Absolute evaluator/tasks/<id> directory. */
  dir: string;
  /** Hidden upstream spec files: src relative to <dir>/upstream, dest relative to /workspace. */
  upstreamFiles: Array<{ src: string; dest: string }>;
  /**
   * Upstream fabricators, copied to `dest` unless another file under spec/fabricators already defines
   * `Fabricator(:<name>` (then the run's own fabricator is used).
   */
  fabricators: Array<{ src: string; dest: string; name: string }>;
  expectedUpstream: ExpectedExample[];
  regression: RegressionSpec[];
  /** Ruby helper files (in <dir>) copied to EVAL_DIR_IN_CONTAINER, e.g. seed.rb, probes. */
  rubyFiles: string[];
  seedScript: string;
  apiChecks: TaskCheck[];
  uiChecks: TaskCheck[];
}

export interface Timings {
  [phase: string]: number;
}

async function resolveImageAndSandbox(taskId: string, image?: string): Promise<{ image: string; sandbox: SandboxSpec }> {
  const tasks = await import('../../../runner/tasks.js');
  const task = tasks.getTask(taskId);
  const sandbox: SandboxSpec = { ...task.sandbox };
  if (image) return { image, sandbox };
  const info = await tasks.ensureTaskImage(task);
  return { image: info.baseImage, sandbox };
}

/** Last `FRUGAL_JSON:<json>` line of a script's stdout. */
export function extractFrugalJson(stdout: string): unknown {
  const lines = stdout.split('\n').filter((l) => l.startsWith('FRUGAL_JSON:'));
  if (!lines.length) return undefined;
  return JSON.parse(lines[lines.length - 1].slice('FRUGAL_JSON:'.length));
}

/** rspec / test DB commands: RAILS_ENV only; .env.test provides LOCAL_DOMAIN, NODE_ENV etc. (dotenv never overrides). */
const RAILS_TEST_ENV = { RAILS_ENV: 'test', DISABLE_DATABASE_ENVIRONMENT_CHECK: '1' };

function failAll(checks: TaskCheck[], message: string): CheckResult[] {
  return checks.map((t) => ({ ...t.spec, outcome: 'fail' as const, message, attempts: 1 }));
}

export async function runMastodonEvaluation(def: MastodonTaskDefinition, opts: EvaluateTaskOptions, deps: PipelineDeps = {}): Promise<EvaluationResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const suite = opts.suite === 'holdout' ? 'holdout' : 'dev';
  const outDir = path.resolve(opts.outDir ?? path.join(REPO_ROOT, 'results', 'runs', opts.runId, 'eval', suite));
  const screenshotDir = path.join(outDir, 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.json');
  const timings: Timings = {};
  const mark = (phase: string, since: number) => (timings[phase] = Math.round((Date.now() - since) / 100) / 10);
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  let c: EvalContainer | null = null;
  let browser: Browser | null = null;
  let patchStats: { bytes: number; files: string[] } = { bytes: 0, files: [] };

  const startupFail = (id: string, message: string, mandatory = true) =>
    checks.push({ id, category: 'startup', mandatory, outcome: 'fail', message: trunc(message, 1500), attempts: 1 });
  const startupPass = (id: string, message?: string) => checks.push({ id, category: 'startup', mandatory: true, outcome: 'pass', message, attempts: 1 });
  const skipRest = (why: string) => {
    if (!checks.some((x) => x.id === STARTUP_CHECK_ID)) startupFail(STARTUP_CHECK_ID, why);
    const rs: RspecRunInfo[] = [{ report: null, note: why }];
    checks.push(...upstreamChecks(def.expectedUpstream, rs), ...regressionChecks(def.regression, rs, def.expectedUpstream));
    checks.push(...failAll(def.apiChecks, `skipped: ${why}`), ...failAll(def.uiChecks, `skipped: ${why}`));
  };

  try {
    // ---------------------------------------------------------------- launch
    let ts = Date.now();
    const { image, sandbox } = await (deps.resolve ?? resolveImageAndSandbox)(def.taskId, opts.image);
    let launchErr: unknown;
    for (let attempt = 0; attempt < 2 && !c; attempt++) {
      try {
        c = await (deps.launch ?? ((o) => MastodonEvalContainer.launch(o)))({ runId: opts.runId, image, sandbox, taskId: def.taskId });
      } catch (e) {
        launchErr = e;
        log.warn('eval container launch failed', { attempt, error: String(e) });
      }
    }
    if (!c) throw launchErr instanceof Error ? launchErr : new EvaluatorInfraError(String(launchErr));
    const cont = c;
    let r = await cont.execLogged('services', '/opt/frugal/task/services start', { timeoutMs: 180_000 });
    if (r.code !== 0) throw new EvaluatorInfraError(`services start failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
    r = await cont.exec(`mkdir -p ${EVAL_DIR_IN_CONTAINER}`);
    if (r.code !== 0) throw new EvaluatorInfraError(`mkdir ${EVAL_DIR_IN_CONTAINER}: ${r.stderr}`);
    mark('launch', ts);

    // ---------------------------------------------------------------- patch
    ts = Date.now();
    const patch = opts.patchFile && fs.existsSync(opts.patchFile) ? fs.readFileSync(opts.patchFile) : Buffer.alloc(0);
    patchStats = { bytes: patch.length, files: [...patch.toString('utf8').matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]) };
    if (patch.length > 0) {
      await cont.writeFile(`${EVAL_DIR_IN_CONTAINER}/workspace.patch`, patch);
      r = await cont.execLogged('git apply', `git apply --binary --whitespace=nowarn ${EVAL_DIR_IN_CONTAINER}/workspace.patch`, { timeoutMs: 120_000 });
      if (r.code !== 0) {
        startupFail('startup.patch', `workspace.patch does not apply to the checkpoint: ${(r.stderr || r.stdout).trim()}`);
        skipRest('the patch did not apply');
        return finish();
      }
    }
    startupPass('startup.patch', patch.length ? `${patchStats.files.length} file(s) changed` : 'empty patch (bare checkpoint)');

    // Hidden upstream material (copied AFTER the patch, so the hidden copies win).
    for (const f of def.upstreamFiles) await cont.copyFileIn(path.join(def.dir, 'upstream', f.src), `/workspace/${f.dest}`);
    for (const f of def.fabricators) {
      const own = await cont.exec(
        `grep -rlE ${shq(`Fabricator\\(:${f.name}\\b`)} spec/fabricators 2>/dev/null | grep -vx ${shq(f.dest)} || true`,
      );
      if (own.stdout.trim()) notes.push(`using the run's own :${f.name} fabricator (${own.stdout.trim().split('\n')[0]})`);
      else await cont.copyFileIn(path.join(def.dir, 'upstream', f.src), `/workspace/${f.dest}`);
    }
    for (const rb of def.rubyFiles) await cont.copyFileIn(path.resolve(def.dir, rb), `${EVAL_DIR_IN_CONTAINER}/${path.basename(rb)}`);
    mark('patch', ts);

    // ---------------------------------------------------------------- migrate
    ts = Date.now();
    r = await cont.execLogged('db:migrate', 'bin/rails db:migrate', { timeoutMs: 300_000 });
    mark('migrate', ts);
    if (r.code !== 0) {
      startupFail('startup.migrate', `bin/rails db:migrate failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
      skipRest('migrations failed');
      return finish();
    }
    startupPass('startup.migrate');

    // ---------------------------------------------------------------- parallel: app / rspec / seed
    const rails = async (script: string, args: Record<string, unknown> = {}, timeoutMs = 240_000) => {
      const res = await cont.execLogged(`rails runner ${script}`, `bin/rails runner ${EVAL_DIR_IN_CONTAINER}/${script}`, {
        timeoutMs,
        env: { FRUGAL_ARGS: JSON.stringify(args), FRUGAL_EVAL_DIR: EVAL_DIR_IN_CONTAINER },
      });
      let out: unknown;
      try {
        out = extractFrugalJson(res.stdout);
      } catch (e) {
        throw new Error(`${script}: unparsable output: ${(e as Error).message}`);
      }
      if (res.code !== 0 || out === undefined) {
        throw new Error(`${script} failed (exit ${res.code}${res.timedOut ? ', timed out' : ''}): ${(res.stderr || res.stdout).trim().slice(-1200)}`);
      }
      return out as any;
    };

    const appPhase = (async () => {
      const t = Date.now();
      const res = await startApp(cont);
      mark('app', t);
      return res;
    })();
    // Memory: the dev webpack compile peaks at 3-4 GB, so rspec waits until `app start` returned
    // (the test DB schema load is small and runs right away). rspec then overlaps the API/UI checks.
    const rspecPhase = (async () => {
      const prep = await prepareTestDb(cont);
      await appPhase.catch(() => undefined);
      const t = Date.now();
      const res = await runSpecs(cont, def, prep);
      mark('rspec', t);
      return res;
    })();
    const seedPhase = (async () => {
      const t = Date.now();
      try {
        return { seed: (await rails(def.seedScript, { suite, seed: opts.seed }, 300_000)) as Record<string, any>, error: null as string | null };
      } catch (e) {
        return { seed: null, error: (e as Error).message };
      } finally {
        mark('seed', t);
      }
    })();

    const app = await appPhase;
    if (app.ok) startupPass(STARTUP_CHECK_ID, app.message);
    else startupFail(STARTUP_CHECK_ID, app.message);
    const seeded = await seedPhase;

    const api = new MastodonApi(cont.url);
    if (!app.ok || !seeded.seed) {
      const why = !app.ok ? 'the app did not start' : `seeding failed: ${seeded.error}`;
      checks.push(...failAll(def.apiChecks, `skipped: ${why}`), ...failAll(def.uiChecks, `skipped: ${why}`));
    } else {
      const ctx: MastodonCheckContext = {
        c: cont,
        api,
        seed: seeded.seed,
        rails,
        browser: null,
        outDir,
        screenshotDir,
        suite,
        seedValue: opts.seed,
      };
      ts = Date.now();
      for (const t of def.apiChecks) checks.push(await runCheck(t.spec, () => t.run(ctx)));
      mark('api', ts);

      ts = Date.now();
      try {
        browser = await (deps.launchBrowser ?? (() => chromium.launch({ headless: true })))();
        ctx.browser = browser;
        for (const t of def.uiChecks) {
          let res = await runCheck(t.spec, () => t.run(ctx));
          if (res.outcome === 'error') res = { ...(await runCheck(t.spec, () => t.run(ctx))), attempts: 2 };
          checks.push(res);
        }
      } catch (e) {
        checks.push(...def.uiChecks.map((t) => ({ ...t.spec, outcome: 'error' as const, message: `evaluator error: browser: ${trunc(String(e), 800)}`, attempts: 1 })));
      }
      mark('ui', ts);
    }

    const specs = await rspecPhase;
    checks.push(...upstreamChecks(def.expectedUpstream, specs.upstream));
    checks.push(...regressionChecks(def.regression, [...specs.regression, ...specs.upstream], def.expectedUpstream));
    if (specs.note) notes.push(specs.note);
  } catch (e) {
    const msg = e instanceof EvaluatorInfraError ? e.message : `${(e as Error)?.stack ?? e}`;
    log.error('mastodon evaluation internal error', { runId: opts.runId, error: msg });
    const id = checks.some((x) => x.id === STARTUP_CHECK_ID) ? 'evaluator.internal' : STARTUP_CHECK_ID;
    checks.push({ id, category: 'startup', mandatory: true, outcome: 'error', message: `evaluator error: ${trunc(msg, 1500)}`, attempts: 1 });
  }
  return finish();

  // Hoisted: closes over the state above.
  async function finish(): Promise<EvaluationResult> {
    await browser?.close().catch(() => undefined);
    const appLogs = c?.logs() ?? '';
    await c?.stop().catch(() => undefined);
    timings.total = Math.round((Date.now() - t0) / 100) / 10;
    const score = scoreEvaluation(checks, 100, VISUAL_THRESHOLD);
    const summary = notes.length ? `${score.summary} [${notes.join('; ')}]` : score.summary;
    const result: EvaluationResult = {
      runId: opts.runId,
      suite,
      seed: opts.seed,
      startedAt,
      finishedAt: new Date().toISOString(),
      appStarted: score.appStarted,
      checks,
      visualScore: 100,
      visualThreshold: score.effectiveThreshold,
      passed: score.passed,
      evaluatorFailure: score.evaluatorFailure,
      failureSummary: score.passed ? undefined : summary,
      evaluatorUsage: zeroUsage(),
      reportFile: relOrAbs(reportPath),
      browserAgentSkipped: false,
    };
    try {
      if (appLogs) fs.writeFileSync(path.join(outDir, 'app.log'), appLogs);
      const report = {
        ...result,
        summary,
        details: {
          task: def.taskId,
          timingsSec: timings,
          patch: patchStats,
          mandatory: { total: checks.filter((x) => x.mandatory).length, passed: checks.filter((x) => x.mandatory && x.outcome === 'pass').length },
          optional: { total: checks.filter((x) => !x.mandatory).length, passed: checks.filter((x) => !x.mandatory && x.outcome === 'pass').length },
          appLog: appLogs ? relOrAbs(path.join(outDir, 'app.log')) : null,
        },
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    } catch (e) {
      log.error('could not write evaluation report', { file: reportPath, error: String(e) });
    }
    log.info('mastodon evaluation finished', { runId: opts.runId, task: def.taskId, passed: result.passed, timings });
    return result;
  }
}

const relOrAbs = (p: string) => {
  const r = path.relative(REPO_ROOT, p);
  return r.startsWith('..') || path.isAbsolute(r) ? p : r;
};

/** Readiness budget for `/opt/frugal/task/app start` (migrations are already done; mostly asset precompile). */
export const APP_READY_TIMEOUT_MS = Number(process.env.FRUGAL_MASTODON_READY_TIMEOUT_MS ?? 9 * 60_000);

async function startApp(c: EvalContainer): Promise<{ ok: boolean; message: string }> {
  // Compiles the dev packs, starts puma (+ sidekiq) in the background, returns once ready. Migrations ran
  // already (startup.migrate); skipping them here also avoids rewriting db/schema.rb while the test DB loads it.
  const bg = c.spawnBackground('app start', `/opt/frugal/task/app start --port ${MASTODON_APP_PORT} --skip-migrate`);
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const code = bg.exited();
    if (code !== null && code !== 0) {
      const st = await c.state();
      if (!st?.running) throw new EvaluatorInfraError(`app container stopped during app start${st?.oomKilled ? ' (OOM killed)' : ''}`);
      return { ok: false, message: `/opt/frugal/task/app start exited with ${code}: ${c.logs().slice(-1500)}` };
    }
    try {
      const res = await fetch(`${c.url}/api/v1/instance`, { signal: AbortSignal.timeout(10_000) });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200) break;
      last = `GET /api/v1/instance → ${res.status}`;
    } catch (e) {
      last = String((e as Error).message);
    }
    await sleep(2000);
  }
  if (Date.now() >= deadline) return { ok: false, message: `app not ready within ${APP_READY_TIMEOUT_MS / 1000}s (${last || 'no response'})` };

  // The web UI must be served: the sign-in page renders and its JS pack loads.
  try {
    const page = await fetch(`${c.url}/auth/sign_in`, { signal: AbortSignal.timeout(60_000) });
    const html = await page.text();
    if (page.status !== 200) return { ok: false, message: `GET /auth/sign_in → ${page.status}` };
    const packs = [...html.matchAll(/<script[^>]+src="([^"]*\/packs\/[^"]+\.js)"/g)].map((m) => m[1]);
    if (!packs.length) return { ok: false, message: 'GET /auth/sign_in: no /packs/*.js script tag (web UI assets not served)' };
    for (const src of packs.slice(0, 3)) {
      const u = new URL(src, c.url);
      const js = await fetch(`${c.url}${u.pathname}${u.search}`, { signal: AbortSignal.timeout(60_000) });
      await js.arrayBuffer().catch(() => undefined);
      if (js.status !== 200) return { ok: false, message: `web UI asset ${u.pathname} → ${js.status}` };
    }
    return { ok: true, message: `ready; ${packs.length} pack script(s) served` };
  } catch (e) {
    return { ok: false, message: `web UI check failed: ${(e as Error).message}` };
  }
}

export const RSPEC_TIMEOUT_MS = Number(process.env.FRUGAL_MASTODON_RSPEC_TIMEOUT_MS ?? 6 * 60_000);

async function runRspec(c: EvalContainer, name: string, files: string[]): Promise<RspecRunInfo> {
  const out = `${EVAL_DIR_IN_CONTAINER}/rspec-${name}.json`;
  const r = await c.execLogged(
    `rspec ${name}`,
    `rm -f ${out}; bundle exec rspec --no-color --format json --out ${out} --format progress ${files.map(shq).join(' ')}`,
    { timeoutMs: RSPEC_TIMEOUT_MS, env: RAILS_TEST_ENV, noDevEnv: true },
  );
  const text = await c.readFile(out);
  const report = text ? parseRspecJson(text) : null;
  const note = r.timedOut
    ? `rspec ${name} timed out after ${RSPEC_TIMEOUT_MS / 1000}s`
    : !report
      ? `rspec ${name} produced no report (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-600)}`
      : undefined;
  return { report, note };
}

/** Load the (just re-dumped) db/schema.rb into the test DB. */
async function prepareTestDb(c: EvalContainer): Promise<CmdResult> {
  return c.execLogged('test db', 'bin/rails db:schema:load', { timeoutMs: 300_000, env: RAILS_TEST_ENV, noDevEnv: true });
}

async function runSpecs(
  c: EvalContainer,
  def: MastodonTaskDefinition,
  prep: CmdResult,
): Promise<{ upstream: RspecRunInfo[]; regression: RspecRunInfo[]; note?: string }> {
  if (prep.code !== 0) {
    const note = `test database schema load failed (exit ${prep.code}): ${(prep.stderr || prep.stdout).trim().slice(-800)}`;
    return { upstream: [{ report: null, note }], regression: [{ report: null, note }], note };
  }
  const upstreamFiles = [...new Set(def.expectedUpstream.map((x) => x.file))];
  // Upstream files together; RSpec runs no examples at all when any file fails to load, so on a load
  // error rerun each upstream file on its own to keep the others' results.
  let upstream: RspecRunInfo[] = [await runRspec(c, 'upstream', upstreamFiles)];
  const u = upstream[0].report;
  if (upstreamFiles.length > 1 && (!u || (u.summary?.errors_outside_of_examples_count ?? 0) > 0)) {
    upstream = [];
    for (const [i, f] of upstreamFiles.entries()) upstream.push(await runRspec(c, `upstream-${i}`, [f]));
  }
  const upstreamSet = new Set(upstreamFiles);
  const regressionFiles = def.regression.map((s) => s.file).filter((f) => !upstreamSet.has(f));
  const regression = regressionFiles.length ? [await runRspec(c, 'regression', regressionFiles)] : [];
  return { upstream, regression };
}
