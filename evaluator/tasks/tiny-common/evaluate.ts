/**
 * Shared evaluation pipeline for the tiny-* tasks (docs/TASKS.md §4).
 *
 *   launch fresh container (base image) → git apply workspace.patch          [startup.patch]
 *   → npm run build (tsc --noEmit + vite build)                              [startup.build]
 *   → in parallel: vitest (ui) and pytest (python)                           [regression.ui, regression.python]
 *   → app start --no-build (sim + vite preview, API proxied)                 [startup.app]
 *   → host Playwright UI checks (task-specific, usually with a pinned book)  [ui.*]
 *   → visual comparison against the hidden reference screenshots             [visual.*]
 *   → score (evaluator/score.ts; the task's visual check gates on its own calibrated threshold)
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
import { scoreEvaluation, STARTUP_CHECK_ID } from '../../score.js';
import type { CmdResult } from '../../docker.js';
import { TINY_APP_PORT, TinyEvalContainer, type SandboxSpec } from './container.js';

const log = logger('evaluator.tiny');

/** The container surface the pipeline uses (TinyEvalContainer; a fake in unit tests). */
export type EvalContainer = Pick<TinyEvalContainer, 'url' | 'exec' | 'execLogged' | 'writeFile' | 'readFile' | 'state' | 'stop' | 'logs'>;

/** TESTS: replace docker / image resolution / the browser. */
export interface PipelineDeps {
  launch?: (o: { runId: string; image: string; sandbox: SandboxSpec; taskId: string }) => Promise<EvalContainer>;
  resolve?: (taskId: string, image?: string) => Promise<{ image: string; sandbox: SandboxSpec }>;
  launchBrowser?: () => Promise<Browser>;
}

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
  taskId?: string;
  experimentId?: string;
}

/** What a UI check body gets. */
export interface TinyCheckContext {
  /** e.g. http://127.0.0.1:41234 (the UI; the API is proxied under it). */
  url: string;
  browser: Browser;
  outDir: string;
  screenshotDir: string;
  suite: 'dev' | 'holdout';
  seedValue: number;
  /** Per-evaluation scratch space shared by the task's checks (e.g. collected page errors). */
  state: Record<string, unknown>;
}

export interface TaskCheck {
  spec: CheckSpec;
  run: (ctx: TinyCheckContext) => Promise<string | void>;
}

export interface VisualOutcome {
  /** 0..100 */
  score: number;
  details: Record<string, unknown>;
  evidence?: string[];
}

export interface TinyTaskDefinition {
  taskId: string;
  /** Absolute evaluator/tasks/<id> directory. */
  dir: string;
  /** Market-making bots for `app start` (live data for checks that use the real sim). */
  bots: number;
  uiChecks: TaskCheck[];
  /** Visual comparison against the hidden reference; null = no visual phase (score 100). */
  visual: ((ctx: TinyCheckContext) => Promise<VisualOutcome>) | null;
  /** Visual check id, threshold (0..100) and whether it gates the pass. */
  visualCheck?: { id: string; threshold: number; mandatory: boolean };
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

function failAll(checks: TaskCheck[], message: string): CheckResult[] {
  return checks.map((t) => ({ ...t.spec, outcome: 'fail' as const, message, attempts: 1 }));
}

const tail = (r: CmdResult, n = 1500) => (r.stderr + '\n' + r.stdout).trim().slice(-n);

export const BUILD_TIMEOUT_MS = Number(process.env.FRUGAL_TINY_BUILD_TIMEOUT_MS ?? 5 * 60_000);
export const TEST_TIMEOUT_MS = Number(process.env.FRUGAL_TINY_TEST_TIMEOUT_MS ?? 6 * 60_000);
export const APP_READY_TIMEOUT_MS = Number(process.env.FRUGAL_TINY_READY_TIMEOUT_MS ?? 3 * 60_000);

export async function runTinyEvaluation(def: TinyTaskDefinition, opts: EvaluateTaskOptions, deps: PipelineDeps = {}): Promise<EvaluationResult> {
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
  let visual: VisualOutcome | null = null;
  const vc = def.visualCheck;

  const push = (id: string, category: CheckResult['category'], outcome: 'pass' | 'fail', message?: string, mandatory = true) =>
    checks.push({ id, category, mandatory, outcome, message: message ? trunc(message, 1500) : undefined, attempts: 1 });
  const skipRest = (why: string, from: 'build' | 'tests' | 'app') => {
    if (from === 'build') push('startup.build', 'startup', 'fail', why);
    if (from !== 'app') {
      push('regression.ui', 'backend', 'fail', `skipped: ${why}`);
      push('regression.python', 'backend', 'fail', `skipped: ${why}`);
    }
    if (!checks.some((x) => x.id === STARTUP_CHECK_ID)) push(STARTUP_CHECK_ID, 'startup', 'fail', why);
    checks.push(...failAll(def.uiChecks, `skipped: ${why}`));
    if (vc) push(vc.id, 'visual', 'fail', `skipped: ${why}`, vc.mandatory);
  };

  try {
    let ts = Date.now();
    const { image, sandbox } = await (deps.resolve ?? resolveImageAndSandbox)(def.taskId, opts.image);
    let launchErr: unknown;
    for (let attempt = 0; attempt < 2 && !c; attempt++) {
      try {
        c = await (deps.launch ?? ((o) => TinyEvalContainer.launch(o)))({ runId: opts.runId, image, sandbox, taskId: def.taskId });
      } catch (e) {
        launchErr = e;
        log.warn('eval container launch failed', { attempt, error: String(e) });
      }
    }
    if (!c) throw launchErr instanceof Error ? launchErr : new EvaluatorInfraError(String(launchErr));
    const cont = c;
    let r = await cont.execLogged('services', '/opt/frugal/task/services start', { timeoutMs: 120_000 });
    if (r.code !== 0) throw new EvaluatorInfraError(`services start failed (exit ${r.code}): ${tail(r)}`);
    r = await cont.exec(`mkdir -p ${EVAL_DIR_IN_CONTAINER}`);
    if (r.code !== 0) throw new EvaluatorInfraError(`mkdir ${EVAL_DIR_IN_CONTAINER}: ${r.stderr}`);
    mark('launch', ts);

    // ---- patch --------------------------------------------------------------------------------
    ts = Date.now();
    const patch = opts.patchFile && fs.existsSync(opts.patchFile) ? fs.readFileSync(opts.patchFile) : Buffer.alloc(0);
    patchStats = { bytes: patch.length, files: [...patch.toString('utf8').matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]) };
    if (patch.length > 0) {
      await cont.writeFile(`${EVAL_DIR_IN_CONTAINER}/workspace.patch`, patch);
      r = await cont.execLogged('git apply', `git apply --binary --whitespace=nowarn ${EVAL_DIR_IN_CONTAINER}/workspace.patch`, { timeoutMs: 120_000 });
      if (r.code !== 0) {
        push('startup.patch', 'startup', 'fail', `workspace.patch does not apply to the checkpoint: ${tail(r)}`);
        skipRest('the patch did not apply', 'build');
        return finish();
      }
    }
    push('startup.patch', 'startup', 'pass', patch.length ? `${patchStats.files.length} file(s) changed` : 'empty patch (bare checkpoint)');
    mark('patch', ts);

    // ---- build ----------------------------------------------------------------------------------
    ts = Date.now();
    r = await cont.execLogged('build', 'cd ui && npm run build', { timeoutMs: BUILD_TIMEOUT_MS });
    mark('build', ts);
    if (r.code !== 0) {
      skipRest(`npm run build failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${tail(r)}`, 'build');
      return finish();
    }
    push('startup.build', 'startup', 'pass');

    // ---- tests (parallel) and app start ----------------------------------------------------------
    ts = Date.now();
    const uiTests = cont.execLogged('vitest', 'cd ui && npx vitest run --reporter=dot', { timeoutMs: TEST_TIMEOUT_MS });
    const pyTests = cont.execLogged('pytest', '.venv/bin/python -m pytest -q -p no:cacheprovider', { timeoutMs: TEST_TIMEOUT_MS });
    const [ui, py] = await Promise.all([uiTests, pyTests]);
    mark('tests', ts);
    const testMsg = (res: CmdResult) => (res.stdout.replace(/\x1b\[[0-9;]*m/g, '').match(/(Tests\s+.*passed.*|\d+ passed.*|\d+ failed.*)$/m)?.[0] ?? '').trim();
    if (ui.code === 0) push('regression.ui', 'backend', 'pass', testMsg(ui));
    else push('regression.ui', 'backend', 'fail', `vitest failed (exit ${ui.code}${ui.timedOut ? ', timed out' : ''}): ${tail(ui)}`);
    if (py.code === 0) push('regression.python', 'backend', 'pass', testMsg(py));
    else push('regression.python', 'backend', 'fail', `pytest failed (exit ${py.code}${py.timedOut ? ', timed out' : ''}): ${tail(py)}`);

    ts = Date.now();
    const app = await startApp(cont, def.bots);
    mark('app', ts);
    push(STARTUP_CHECK_ID, 'startup', app.ok ? 'pass' : 'fail', app.message);
    if (!app.ok) {
      skipRest('the app did not start', 'app');
      return finish();
    }

    // ---- UI checks --------------------------------------------------------------------------------
    ts = Date.now();
    try {
      browser = await (deps.launchBrowser ?? (() => chromium.launch({ headless: true })))();
      const ctx: TinyCheckContext = { url: cont.url, browser, outDir, screenshotDir, suite, seedValue: opts.seed, state: {} };
      for (const t of def.uiChecks) {
        let res = await runCheck(t.spec, () => t.run(ctx));
        if (res.outcome === 'error') res = { ...(await runCheck(t.spec, () => t.run(ctx))), attempts: 2 };
        checks.push(res);
      }
      mark('ui', ts);

      if (def.visual && vc) {
        ts = Date.now();
        try {
          visual = await def.visual(ctx);
          const ok = visual.score >= vc.threshold;
          checks.push({
            id: vc.id,
            category: 'visual',
            mandatory: vc.mandatory,
            outcome: ok ? 'pass' : 'fail',
            message: `visual score ${visual.score.toFixed(2)} ${ok ? '>=' : '<'} ${vc.threshold}`,
            evidence: visual.evidence,
            attempts: 1,
          });
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const infra = e instanceof EvaluatorInfraError;
          checks.push({ id: vc.id, category: 'visual', mandatory: vc.mandatory, outcome: infra ? 'error' : 'fail', message: trunc(`${infra ? 'evaluator error: ' : ''}${msg}`, 1500), attempts: 1 });
          visual = { score: 0, details: { error: msg } };
        }
        mark('visual', ts);
      }
    } catch (e) {
      const msg = `evaluator error: browser: ${trunc(String(e), 800)}`;
      checks.push(...def.uiChecks.filter((t) => !checks.some((x) => x.id === t.spec.id)).map((t) => ({ ...t.spec, outcome: 'error' as const, message: msg, attempts: 1 })));
      if (vc && !checks.some((x) => x.id === vc.id)) checks.push({ id: vc.id, category: 'visual', mandatory: vc.mandatory, outcome: 'error', message: msg, attempts: 1 });
    }
  } catch (e) {
    const msg = e instanceof EvaluatorInfraError ? e.message : `${(e as Error)?.stack ?? e}`;
    log.error('tiny evaluation internal error', { runId: opts.runId, error: msg });
    const id = checks.some((x) => x.id === STARTUP_CHECK_ID) ? 'evaluator.internal' : STARTUP_CHECK_ID;
    checks.push({ id, category: 'startup', mandatory: true, outcome: 'error', message: `evaluator error: ${trunc(msg, 1500)}`, attempts: 1 });
  }
  return finish();

  async function finish(): Promise<EvaluationResult> {
    await browser?.close().catch(() => undefined);
    const appLogs = c?.logs() ?? '';
    await c?.stop().catch(() => undefined);
    timings.total = Math.round((Date.now() - t0) / 100) / 10;
    // The visual gate is the task's own check (calibrated threshold), so the global gate gets 100.
    const score = scoreEvaluation(checks, 100);
    const summary = notes.length ? `${score.summary} [${notes.join('; ')}]` : score.summary;
    const visualScore = visual ? Math.round(visual.score * 100) / 100 : def.visual ? 0 : 100;
    const result: EvaluationResult = {
      runId: opts.runId,
      suite,
      seed: opts.seed,
      startedAt,
      finishedAt: new Date().toISOString(),
      appStarted: score.appStarted,
      checks,
      visualScore,
      visualThreshold: vc?.threshold ?? score.effectiveThreshold,
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
          visual: visual?.details ?? null,
          mandatory: { total: checks.filter((x) => x.mandatory).length, passed: checks.filter((x) => x.mandatory && x.outcome === 'pass').length },
          optional: { total: checks.filter((x) => !x.mandatory).length, passed: checks.filter((x) => !x.mandatory && x.outcome === 'pass').length },
          appLog: appLogs ? relOrAbs(path.join(outDir, 'app.log')) : null,
        },
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    } catch (e) {
      log.error('could not write evaluation report', { file: reportPath, error: String(e) });
    }
    log.info('tiny evaluation finished', { runId: opts.runId, task: def.taskId, passed: result.passed, timings });
    return result;
  }
}

const relOrAbs = (p: string) => {
  const r = path.relative(REPO_ROOT, p);
  return r.startsWith('..') || path.isAbsolute(r) ? p : r;
};

/** `app start --no-build` (the build already ran), then readiness through the forwarder. */
async function startApp(c: EvalContainer, bots: number): Promise<{ ok: boolean; message: string }> {
  const r = await c.execLogged('app start', `APP_START_TIMEOUT=${Math.round(APP_READY_TIMEOUT_MS / 1000)} /opt/frugal/task/app start --no-build --port ${TINY_APP_PORT} --bots ${bots}`, {
    timeoutMs: APP_READY_TIMEOUT_MS + 30_000,
  });
  if (r.code !== 0) {
    const st = await c.state();
    if (!st?.running) throw new EvaluatorInfraError(`app container stopped during app start${st?.oomKilled ? ' (OOM killed)' : ''}`);
    return { ok: false, message: `/opt/frugal/task/app start exited with ${r.code}: ${tail(r)}` };
  }
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const page = await fetch(`${c.url}/`, { signal: AbortSignal.timeout(10_000) });
      const html = await page.text();
      const api = await fetch(`${c.url}/markets`, { signal: AbortSignal.timeout(10_000) });
      const markets = (await api.json().catch(() => null)) as unknown;
      if (page.status === 200 && /<div id="root"/.test(html) && api.status === 200 && Array.isArray(markets) && markets.length > 0)
        return { ok: true, message: `ready; ${markets.length} market(s)` };
      last = `GET / → ${page.status}, GET /markets → ${api.status}`;
    } catch (e) {
      last = String((e as Error).message);
    }
    await sleep(1000);
  }
  return { ok: false, message: `UI or API not reachable through the forwarder (${last || 'no response'})` };
}
