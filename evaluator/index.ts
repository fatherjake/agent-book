/**
 * evaluateRun: launch → backend tests → deterministic UI scenarios → browser agent → visual → score.
 *
 * - Runs entirely outside the coding container, against a FRESH eval container built from the
 *   run's app snapshot (see app-launcher.ts).
 * - Never throws for app failures; app failures are 'fail' checks. Evaluator infrastructure
 *   failures are 'error' checks and are retried up to 2 times (attempts recorded per check).
 * - Containers are always stopped in a finally block.
 * - pass/fail is decided ONLY by score.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { logger } from '../runner/logger.js';
import { sumUsage, TokenTracker } from '../runner/token-tracker.js';
import type { CheckResult, Effort, EvaluationResult, ModelProvider } from '../runner/types.js';
import type { GatewayHandle } from '../runner/gateway.js';
import type { ClaudeCodeBrowserBackend, RunHeadlessFn } from './browser-agent-cc.js';
import { AppStartupError, EvaluatorInfraError, launchApp, type LaunchedApp } from './app-launcher.js';
import { runBackendTests } from './backend-tests.js';
import { DEFAULT_BROWSER_AGENT_MODEL, runBrowserAgentScenarios } from './browser-agent.js';
import { trunc } from './checks.js';
import { buildVariant, REPO_ROOT, seedFromString, type ScenarioVariant, type Suite } from './fixtures.js';
import { runUiScenarios } from './scenarios/ui-scenarios.js';
import { scoreEvaluation, STARTUP_CHECK_ID, VISUAL_THRESHOLD } from './score.js';
import { runVisualTests, type ViewportScore } from './visual-tests.js';

export { scoreEvaluation, VISUAL_THRESHOLD } from './score.js';
export { launchApp } from './app-launcher.js';

const log = logger('evaluator');

/** Infrastructure retries per phase (so up to 3 attempts in total). */
export const MAX_INFRA_RETRIES = 2;

export interface EvaluateRunOptions {
  runId: string;
  appDir: string;
  suite: Suite;
  seed: number;
  /**
   * api backend for the browser agent (raw; the evaluator wraps it in a TokenTracker). When omitted
   * (the normal case) the browser agent runs on Claude Code + Playwright MCP with the subscription.
   */
  provider?: ModelProvider;
  /** TESTS: replace the claude-code backend's gateway / headless runner / token check. */
  claudeCodeDeps?: {
    startGateway?: (o: Parameters<typeof import('../runner/gateway.js').startGateway>[0]) => Promise<GatewayHandle>;
    runHeadless?: RunHeadlessFn;
    hasSubscriptionToken?: () => boolean;
  };
  skipBrowserAgent?: boolean;
  /** Default: results/runs/<runId>/eval/<suite> */
  outDir?: string;
  /** Benchmark image (default: ensureImage()). */
  image?: string;
  /** Model for the browser agent (default claude-sonnet-5-5 or $FRUGAL_EVALUATOR_MODEL). */
  browserAgentModel?: string;
  /** Infra tests only: allow the mock provider for the browser agent. */
  allowMockBrowserAgent?: boolean;
  experimentId?: string;
}

async function resolveImage(image?: string): Promise<string> {
  if (image) return image;
  const mod = await import('../benchmark/docker/image.js');
  return (await mod.ensureImage()).image;
}

/** Effort for the browser agent ($FRUGAL_EVALUATOR_EFFORT, default: the model's default). */
function evaluatorEffort(): Effort | undefined {
  const e = process.env.FRUGAL_EVALUATOR_EFFORT;
  return e && ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? (e as Effort) : undefined;
}

const relOrAbs = (p: string) => {
  const r = path.relative(REPO_ROOT, p);
  return r.startsWith('..') || path.isAbsolute(r) ? p : r;
};

export async function evaluateRun(opts: EvaluateRunOptions): Promise<EvaluationResult> {
  const startedAt = new Date().toISOString();
  const suite: Suite = opts.suite === 'holdout' ? 'holdout' : 'dev';
  const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : seedFromString(opts.runId);
  const outDir = path.resolve(opts.outDir ?? path.join(REPO_ROOT, 'results', 'runs', opts.runId, 'eval', suite));
  const screenshotDir = path.join(outDir, 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.json');
  const tracker = new TokenTracker({
    role: 'evaluator',
    runId: opts.runId,
    experimentId: opts.experimentId,
    usageFile: path.join(outDir, 'usage.jsonl'),
  });

  let gateway: GatewayHandle | null = null;
  const checks: CheckResult[] = [];
  let visualScore = 0;
  let visualDetails: ViewportScore[] = [];
  let app: LaunchedApp | null = null;
  let browser: Browser | null = null;
  let variant: ScenarioVariant | null = null;
  const notes: string[] = [];
  let appLogs = '';

  const stopApp = async () => {
    if (app) {
      appLogs += app.logs();
      await app.stop().catch(() => undefined);
      app = null;
    }
  };

  try {
    variant = buildVariant(suite, seed);
    if (variant.fixtureSource.startsWith('builtin-fallback')) notes.push(`fixtures: ${variant.fixtureSource}`);
    const image = await resolveImage(opts.image);

    // ---------------------------------------------------------------- launch
    const launch = async (): Promise<CheckResult> => {
      let lastErr = '';
      for (let attempt = 1; attempt <= MAX_INFRA_RETRIES + 1; attempt++) {
        try {
          app = await launchApp({ appDir: opts.appDir, runId: opts.runId, image });
          return { id: STARTUP_CHECK_ID, category: 'startup', mandatory: true, outcome: 'pass', message: `app ready at ${app.url}`, attempts: attempt };
        } catch (e) {
          if (e instanceof AppStartupError) {
            appLogs += e.logs;
            return {
              id: STARTUP_CHECK_ID,
              category: 'startup',
              mandatory: true,
              outcome: 'fail',
              message: trunc(`${e.message}\n--- last log lines ---\n${e.logs.slice(-1500)}`, 2000),
              attempts: attempt,
            };
          }
          lastErr = (e as Error).message;
          log.warn('launch infrastructure failure, retrying', { runId: opts.runId, attempt, error: lastErr });
        }
      }
      return { id: STARTUP_CHECK_ID, category: 'startup', mandatory: true, outcome: 'error', message: `evaluator error: ${lastErr}`, attempts: MAX_INFRA_RETRIES + 1 };
    };
    const ensureBrowser = async () => {
      if (browser?.isConnected()) return browser;
      await browser?.close().catch(() => undefined);
      // Playwright's default SIGINT/SIGTERM handlers kill the browser and call process.exit(130),
      // which bypasses the CLIs' graceful shutdown (experiment bookkeeping, container cleanup).
      // The evaluator always closes the browser itself in its finally block.
      browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      return browser;
    };

    const startup = await launch();
    checks.push(startup);
    if (startup.outcome === 'pass') {
      /**
       * Run a phase; for checks with outcome 'error' relaunch app + browser and re-run (only the
       * errored ids when the phase supports it), up to MAX_INFRA_RETRIES times.
       */
      const phase = async (
        name: string,
        run: (only?: string[]) => Promise<CheckResult[]>,
        opts2: { rerunAll?: boolean; retryable?: (c: CheckResult) => boolean } = {},
      ): Promise<CheckResult[]> => {
        let results = await run();
        const retryable = opts2.retryable ?? (() => true);
        for (let retry = 1; retry <= MAX_INFRA_RETRIES; retry++) {
          const errored = results.filter((c) => c.outcome === 'error' && retryable(c));
          if (!errored.length) break;
          log.warn(`${name}: evaluator errors, retrying`, { runId: opts.runId, retry, ids: errored.map((c) => c.id) });
          await stopApp();
          const relaunch = await launch();
          if (relaunch.outcome !== 'pass') {
            notes.push(`relaunch for ${name} retry failed: ${relaunch.message}`);
            break;
          }
          await ensureBrowser();
          const again = await run(opts2.rerunAll ? undefined : errored.map((c) => c.id));
          const byId = new Map(again.map((c) => [c.id, { ...c, attempts: retry + 1 }]));
          results = opts2.rerunAll
            ? again.map((c) => ({ ...c, attempts: retry + 1 }))
            : results.map((c) => byId.get(c.id) ?? c);
        }
        return results;
      };

      await ensureBrowser();
      const v = variant;

      checks.push(...(await phase('backend', () => runBackendTests(app!, v), { rerunAll: true })));

      checks.push(
        ...(await phase('ui', (only) => runUiScenarios({ app: app!, browser: browser!, variant: v, screenshotDir, only }))),
      );

      if (opts.skipBrowserAgent) {
        notes.push('browser agent skipped (skipBrowserAgent): deterministic + visual evaluation only');
      } else {
        const model = opts.browserAgentModel ?? process.env.FRUGAL_EVALUATOR_MODEL ?? DEFAULT_BROWSER_AGENT_MODEL;
        let provider: ModelProvider | null = null;
        let claudeCode: ClaudeCodeBrowserBackend | null = null;
        let reason: string | undefined;
        if (opts.provider) {
          provider = tracker.wrap(opts.provider, 'browser-agent');
        } else {
          const gw = await import('../runner/gateway.js');
          const hasToken = opts.claudeCodeDeps?.hasSubscriptionToken ?? gw.hasSubscriptionToken;
          if (!hasToken()) {
            reason = `no Claude subscription token, so the browser agent cannot run (no real model available). ${gw.SETUP_TOKEN_HELP}`;
          } else {
            const start = opts.claudeCodeDeps?.startGateway ?? gw.startGateway;
            gateway = await start({ role: 'evaluator', runId: opts.runId, experimentId: opts.experimentId, usageFile: path.join(outDir, 'usage.jsonl'), mainModel: model });
            const runHeadless = opts.claudeCodeDeps?.runHeadless ?? (await import('../runner/claude-code.js')).runClaudeHeadless;
            claudeCode = { gateway, model, effort: evaluatorEffort(), runHeadless };
          }
        }
        checks.push(
          ...(await phase(
            'browser-agent',
            (only) =>
              runBrowserAgentScenarios({
                app: app!,
                browser: browser!,
                variant: v,
                provider,
                claudeCode,
                unavailableReason: reason,
                allowMock: opts.allowMockBrowserAgent,
                model,
                outDir,
                only: only?.map((id) => id.replace(/^browser\./, '')),
              }),
            // Never retry: unavailable backends, or an exhausted subscription (the loop waits for the reset).
            { retryable: (c) => !/unavailable|usage limit/.test(c.message ?? '') && gateway?.usageLimitResetAt() == null },
          )),
        );
      }

      const visualChecks = await phase(
        'visual',
        async () => {
          const r = await runVisualTests({ app: app!, browser: browser!, screenshotDir });
          visualScore = r.visualScore;
          visualDetails = r.viewports;
          return r.checks;
        },
        { rerunAll: true },
      );
      checks.push(...visualChecks);
    }
  } catch (e) {
    // Unexpected evaluator crash: record as an evaluator failure (never blame the app).
    const msg = e instanceof EvaluatorInfraError ? e.message : `${(e as Error)?.stack ?? e}`;
    log.error('evaluateRun internal error', { runId: opts.runId, error: msg });
    if (!checks.some((c) => c.id === STARTUP_CHECK_ID)) {
      checks.push({ id: STARTUP_CHECK_ID, category: 'startup', mandatory: true, outcome: 'error', message: `evaluator error: ${trunc(msg, 1500)}`, attempts: 1 });
    } else {
      checks.push({ id: 'evaluator.internal', category: 'startup', mandatory: true, outcome: 'error', message: `evaluator error: ${trunc(msg, 1500)}`, attempts: 1 });
    }
  } finally {
    await stopApp();
    await (browser as Browser | null)?.close().catch(() => undefined);
  }
  const gw = gateway as GatewayHandle | null;
  const usageLimitResetAt = gw?.usageLimitResetAt() ?? null;
  const usageRecords = [...tracker.records(), ...(gw?.tracker.records() ?? [])];
  await gw?.stop().catch(() => undefined);

  const score = scoreEvaluation(checks, visualScore, VISUAL_THRESHOLD);
  const finishedAt = new Date().toISOString();
  const summary = notes.length ? `${score.summary} [${notes.join('; ')}]` : score.summary;
  const result: EvaluationResult = {
    runId: opts.runId,
    suite,
    seed,
    startedAt,
    finishedAt,
    appStarted: score.appStarted,
    checks,
    visualScore,
    visualThreshold: score.effectiveThreshold,
    passed: score.passed,
    evaluatorFailure: score.evaluatorFailure,
    failureSummary: score.passed ? undefined : summary,
    evaluatorUsage: gw ? sumUsage(usageRecords) : tracker.totals(),
    reportFile: relOrAbs(reportPath),
    browserAgentSkipped: !!opts.skipBrowserAgent,
    ...(usageLimitResetAt !== null ? { usageLimitResetAt } : {}),
  };

  try {
    if (appLogs) fs.writeFileSync(path.join(outDir, 'app.log'), appLogs);
    const report = {
      ...result,
      summary,
      details: {
        variant: variant
          ? {
              suite: variant.suite,
              seed: variant.seed,
              fixtureSource: variant.fixtureSource,
              baseSetName: variant.baseSetName,
              titles: variant.titles,
              sequenceOrder: variant.sequenceOrder,
              browserScenarioOrder: variant.browserScenarioOrder,
            }
          : null,
        visual: visualDetails,
        usageRecords: usageRecords.length,
        browserAgentBackend: opts.skipBrowserAgent ? null : opts.provider ? 'api' : gw ? 'claude-code' : 'unavailable',
        appLog: appLogs ? relOrAbs(path.join(outDir, 'app.log')) : null,
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  } catch (e) {
    log.error('could not write evaluation report', { file: reportPath, error: String(e) });
  }
  log.info('evaluation finished', { runId: opts.runId, suite, passed: result.passed, evaluatorFailure: result.evaluatorFailure, visualScore });
  return result;
}
