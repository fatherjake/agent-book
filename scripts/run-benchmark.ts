/**
 * npm run benchmark -- [--config baseline] [--task todo] [--runs N] [--suite dev|holdout] [--provider mock|anthropic]
 *                      [--mock-script default|reference-app] [--skip-browser-agent] [--dry-run]
 *
 * Runs a coding-agent configuration against the benchmark (sequentially), evaluates every app
 * snapshot and stores everything in results/benchmark.db. --dry-run checks the environment
 * without invoking any paid model.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrExit, type CommandSpec } from '../researcher/cli-args.js';
import { flagTags, fmtDuration, fmtScore, fmtTokens, fmtUsd, MOCK, NO_BROWSER, textTable } from '../researcher/format.js';
import { MOCK_SCRIPT_NAMES } from '../researcher/mock-scripts.js';

export const BENCHMARK_CLI: CommandSpec = {
  command: 'npm run benchmark --',
  summary: 'Run a coding-agent configuration against a benchmark task (default: the todo app) and evaluate the result.',
  flags: [
    { name: 'config', type: 'string', description: "Config id under configs/ ('baseline' or 'experiments/NNN')", default: 'baseline' },
    { name: 'task', type: 'string', description: 'Benchmark task id (benchmark/tasks/<id>, e.g. todo, mastodon-bookmarks)', default: 'todo' },
    { name: 'runs', type: 'number', description: 'Number of runs', default: 1, integer: true, min: 1 },
    { name: 'concurrency', type: 'number', description: 'Runs executed in parallel (each fully isolated)', default: 1, integer: true, min: 1 },
    { name: 'suite', type: 'string', description: 'Evaluation suite', default: 'dev', choices: ['dev', 'holdout'] },
    { name: 'provider', type: 'string', description: "Override the config's model provider (mock = no API calls, results flagged [MOCK])", choices: ['mock', 'anthropic'] },
    {
      name: 'mock-script',
      type: 'string',
      description:
        "INFRA TEST ONLY (needs --provider mock): 'default' writes one trivial file (expected: clean app failure); 'reference-app' pushes the hidden reference app through the real pipeline (expected: deterministic + visual checks pass). Always [MOCK], never promotable",
      choices: MOCK_SCRIPT_NAMES,
    },
    {
      name: 'skip-browser-agent',
      type: 'boolean',
      description: `Skip the LLM browser-agent evaluation (deterministic + visual checks only). Results are marked ${NO_BROWSER} and never count toward promotion. Implied by --provider mock`,
    },
    { name: 'dry-run', type: 'boolean', description: 'Verify node, docker, image, config, spec hashes, Playwright, DB and API key; no paid models' },
    { name: 'db', type: 'string', description: 'SQLite path (default results/benchmark.db or $FRUGAL_DB_PATH)' },
  ],
  examples: [
    'npm run benchmark -- --config baseline',
    'npm run benchmark -- --config experiments/001 --runs 3',
    'npm run benchmark -- --task mastodon-bookmarks --config baseline',
    'npm run benchmark -- --dry-run',
    'npm run benchmark -- --provider mock                              # infra test, trivial file',
    'npm run benchmark -- --provider mock --mock-script reference-app  # infra test, full pipeline',
  ],
};

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  /** Non-fatal: shown as a warning, doesn't fail the dry run. */
  warnOnly?: boolean;
}

function printChecklist(items: CheckItem[]): boolean {
  let ok = true;
  for (const c of items) {
    const mark = c.ok ? '✓' : c.warnOnly ? '!' : '✗';
    if (!c.ok && !c.warnOnly) ok = false;
    console.log(`${mark} ${c.name.padEnd(28)} ${c.detail}`);
  }
  return ok;
}

async function check(name: string, fn: () => Promise<string> | string, warnOnly = false): Promise<CheckItem> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: (e as Error)?.message?.split('\n')[0] ?? String(e), warnOnly };
  }
}

/** Environment checks shared by run-benchmark and start-research dry runs. Invokes no paid model. */
export async function environmentChecks(opts: { configId: string; provider?: string; dbPath?: string; needImage?: boolean }): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  items.push(
    await check('Node.js >= 22', () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 22) throw new Error(`found ${process.versions.node}`);
      return process.versions.node;
    }),
  );
  const sandbox = await import('../runner/sandbox.js');
  const dockerOk = await sandbox.isDockerAvailable();
  items.push({ name: 'Docker daemon', ok: dockerOk, detail: dockerOk ? 'reachable' : 'not reachable (start Docker Desktop / dockerd)' });
  if (opts.needImage !== false) {
    items.push(
      dockerOk
        ? await check('Benchmark image', async () => {
            const img = await sandbox.ensureImage();
            return `${img.image} (${img.imageId.slice(0, 19)})`;
          })
        : { name: 'Benchmark image', ok: false, detail: 'skipped: docker unavailable' },
    );
  }
  let cfgProvider = opts.provider;
  let cfgBackend: string | undefined;
  items.push(
    await check(`Config ${opts.configId}`, async () => {
      const { loadConfig, hashConfig } = await import('../runner/config.js');
      const cfg = loadConfig(opts.configId);
      cfgProvider = opts.provider ?? cfg.provider;
      cfgBackend = cfg.backend;
      if (cfg.backend === 'claude-code')
        return `claude-code/${cfg.model}, ${cfg.claudeCode?.tools ? cfg.claudeCode.tools.length + ' tools' : 'default tools'}, ${cfg.skills.length} skills, hash ${hashConfig(cfg).slice(0, 12)}`;
      return `${cfg.provider}/${cfg.model}, ${cfg.tools.filter((t) => t.enabled).length} tools, ${cfg.skills.length} skills, hash ${hashConfig(cfg).slice(0, 12)}`;
    }),
  );
  items.push(
    await check('Config anti-cheat guard', async () => {
      const { GUARD_EXEMPT_CONFIG_IDS, loadConfig, hashConfig } = await import('../runner/config.js');
      if ((GUARD_EXEMPT_CONFIG_IDS as readonly string[]).includes(opts.configId)) return 'exempt (api reference baseline)';
      const { guardConfig } = await import('../researcher/config-guard.js');
      const { CONFIGS_DIR } = await import('../runner/env.js');
      const dir = /^(\/|\.\.?\/)/.test(opts.configId) ? resolve(opts.configId) : join(CONFIGS_DIR, opts.configId);
      const hash = hashConfig(loadConfig(opts.configId, { guard: false }));
      const r = guardConfig(dir, { excludeConfigHashes: [hash] });
      if (!r.ok) throw new Error(`REJECTED: ${r.violations.map((v) => `${v.file} [${v.rule}]`).join(', ')}`);
      const top = [...r.similarity].sort((a, b) => b.coveredTokens - a.coveredTokens)[0];
      return `passed (size, app-code heuristics, similarity vs past snapshots${top ? `; max overlap ${top.coveredTokens} tokens in ${top.file}` : '; no overlap'})`;
    }),
  );
  items.push(
    await check('Spec files + FROZEN.json', () => {
      const specDir = resolve('benchmark', 'spec');
      const frozenPath = join(specDir, 'FROZEN.json');
      if (!existsSync(frozenPath)) throw new Error('benchmark/spec/FROZEN.json missing (spec not frozen)');
      const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as { files?: Record<string, string> };
      const files = frozen.files ?? {};
      const required = ['requirements.md', 'api-contract.yaml', 'design.png', 'fixtures.json'];
      for (const f of required) if (!existsSync(join(specDir, f))) throw new Error(`missing benchmark/spec/${f}`);
      const bad: string[] = [];
      for (const [f, want] of Object.entries(files)) {
        const p = join(specDir, f);
        if (!existsSync(p)) bad.push(`${f} (missing)`);
        else if (createHash('sha256').update(readFileSync(p)).digest('hex') !== want) bad.push(`${f} (hash mismatch)`);
      }
      if (bad.length) throw new Error(`frozen spec modified: ${bad.join(', ')}`);
      if (!Object.keys(files).length) throw new Error('FROZEN.json lists no files');
      return `${Object.keys(files).length} frozen files verified`;
    }),
  );
  items.push(
    await check('Playwright chromium', async () => {
      const pw = await import('playwright');
      const exe = pw.chromium.executablePath();
      if (!exe || !existsSync(exe)) throw new Error('not installed — run: npx playwright install chromium');
      return exe.length > 60 ? '…' + exe.slice(-57) : exe;
    }),
  );
  items.push(
    await check('Results DB', async () => {
      const { openDb } = await import('../storage/db.js');
      const db = openDb(opts.dbPath);
      const v = db.schemaVersion();
      const n = db.listExperiments().length;
      db.close();
      return `${db.path} (schema v${v}, ${n} experiments)`;
    }),
  );
  const { loadDotEnv } = await import('../runner/env.js');
  loadDotEnv();
  if (cfgBackend === 'claude-code' && cfgProvider !== 'mock') {
    const { hasSubscriptionToken } = await import('../runner/gateway.js');
    const { hostClaudeBin, CLAUDE_CODE_VERSION } = await import('../runner/claude-code.js');
    const has = hasSubscriptionToken();
    items.push({
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      ok: has,
      detail: has ? 'present (subscription; used only by the host gateway, never enters a container)' : 'missing — run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN=... to .env',
    });
    items.push(
      await check('Host Claude Code', async () => {
        const { execFileSync } = await import('node:child_process');
        const v = execFileSync(hostClaudeBin(), ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
        if (!v.startsWith(CLAUDE_CODE_VERSION)) throw new Error(`${v}; the coding image pins ${CLAUDE_CODE_VERSION}`);
        return v;
      }),
    );
    if (dockerOk)
      items.push(
        await check('Claude Code coding image', async () => {
          const { ensureClaudeCodeImage } = await import('../runner/claude-code-image.js');
          const img = await ensureClaudeCodeImage();
          return `${img.image} (${img.imageId.slice(0, 19)})`;
        }),
      );
    return items;
  }
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const needsKey = cfgProvider !== 'mock';
  items.push({
    name: 'ANTHROPIC_API_KEY',
    ok: hasKey,
    warnOnly: !needsKey,
    detail: hasKey ? 'present (not validated: dry-run makes no API calls)' : needsKey ? 'missing — set it in .env (or use --provider mock)' : `missing (ok for --provider mock; results will be ${MOCK})`,
  });
  return items;
}

async function main(): Promise<void> {
  const args = parseOrExit(process.argv.slice(2), BENCHMARK_CLI);
  const configId = args.config as string;
  const provider = args.provider as string | undefined;
  const dbPath = args.db as string | undefined;

  if (args['dry-run']) {
    console.log(`Dry run for config '${configId}' (no paid models are invoked)\n`);
    const ok = printChecklist(await environmentChecks({ configId, provider, dbPath }));
    console.log(ok ? '\nAll checks passed.' : '\nSome checks failed.');
    process.exit(ok ? 0 : 1);
  }

  const { loadDotEnv } = await import('../runner/env.js');
  loadDotEnv();
  const [{ openDb }, { runBenchmark, summarize }, { createProvider }, { loadConfig, hashConfig }, { resolveMockScript }, sandbox, launcher] =
    await Promise.all([
      import('../storage/db.js'),
      import('../researcher/experiment.js'),
      import('../runner/providers/index.js'),
      import('../runner/config.js'),
      import('../researcher/mock-scripts.js'),
      import('../runner/sandbox.js'),
      import('../evaluator/app-launcher.js'),
    ]);
  const cfg = loadConfig(configId);
  const taskId = String(args.task ?? 'todo');
  const { getTask } = await import('../runner/tasks.js');
  let task;
  try {
    task = getTask(taskId);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }
  const effectiveProvider = provider ?? cfg.provider;
  const isMock = effectiveProvider === 'mock';
  const mockScriptName = args['mock-script'] as string | undefined;
  if (mockScriptName && !isMock) {
    console.error('error: --mock-script requires --provider mock (it is an infrastructure-test option).');
    process.exit(2);
  }
  if (mockScriptName === 'reference-app' && taskId !== 'todo') {
    console.error("error: --mock-script reference-app pushes the todo reference app; it only works with --task todo.");
    process.exit(2);
  }
  let skipBrowserAgent = Boolean(args['skip-browser-agent']);
  if (isMock && !skipBrowserAgent) {
    skipBrowserAgent = true;
    console.warn(
      `warning: --provider mock implies --skip-browser-agent (a mock model cannot judge a UI). Results are ${MOCK} ${NO_BROWSER} and never eligible for promotion.`,
    );
  }
  if (effectiveProvider !== 'mock' && cfg.backend === 'claude-code') {
    // Claude Code backend: the coding agent runs on the Claude subscription through the host gateway.
    const { hasSubscriptionToken, SETUP_TOKEN_HELP } = await import('../runner/gateway.js');
    if (!hasSubscriptionToken()) {
      console.error(`error: ${SETUP_TOKEN_HELP}`);
      process.exit(1);
    }
  } else if (effectiveProvider !== 'mock' && !process.env.ANTHROPIC_API_KEY) {
    console.error('error: ANTHROPIC_API_KEY is not set. Put it in .env, or run with --provider mock (results flagged [MOCK]).');
    process.exit(1);
  }
  if ((await import('../runner/keep-awake.js')).keepAwake()) console.log('Keeping the Mac awake while this runs (caffeinate -i -s; FRUGAL_NO_CAFFEINATE=1 to disable).');
  const db = openDb(dbPath);
  db.ensureConfig({ configId, hash: hashConfig(cfg), parentId: cfg.parentId ?? null, path: join('configs', configId), hypothesis: null });
  // A fresh provider per run: the mock is a stateful script that would be exhausted after run 1.
  const mockScript = isMock ? resolveMockScript(mockScriptName ?? 'default') : undefined;
  const providerFactory = provider ? () => createProvider(provider, mockScript ? { mockScript } : {}) : undefined;
  // Leftovers of crashed processes: coding containers older than the default age, and all eval
  // containers/networks (benchmark and research are single-writer; don't run them concurrently).
  try {
    const n = (await sandbox.cleanupAbandonedContainers()) + (await launcher.cleanupEvalResources());
    if (n) console.log(`Removed ${n} abandoned container(s) from earlier runs.`);
  } catch (e) {
    console.warn(`warning: startup container cleanup failed: ${(e as Error).message}`);
  }

  const ctrl = new AbortController();
  let stopping = false;
  const onSig = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error('\nInterrupt received: aborting the current run (press Ctrl-C again to force quit)…');
    ctrl.abort();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  console.log(
    `Running ${args.runs} run(s) of '${configId}' on task '${taskId}' (${!isMock && cfg.backend === 'claude-code' ? 'claude-code' : effectiveProvider}/${cfg.model}, suite ${args.suite})${flagTags(isMock, skipBrowserAgent && task.browserAgent === 'required')}`,
  );
  if (isMock) {
    console.log(`${MOCK} The mock provider makes no real model calls. These results are NOT a real benchmark.`);
    console.log(`${MOCK} infra-test script: ${mockScriptName ?? 'default'}`);
  }
  if (skipBrowserAgent) console.log(`${NO_BROWSER} Browser-agent scenarios are skipped: the evaluation is incomplete and can never qualify a config.`);
  // Group this batch as a 'manual' experiment so it shows up in `npm run results` and the dashboard.
  const exp = db.insertExperiment({
    kind: 'manual',
    parentConfigId: null,
    candidateConfigId: configId,
    hypothesis: isMock
      ? `${MOCK} Infrastructure test (mock script '${mockScriptName ?? 'default'}'): npm run benchmark --config ${configId}`
      : `Manual benchmark: npm run benchmark --config ${configId}${taskId === 'todo' ? '' : ` --task ${taskId}`} --runs ${args.runs} --suite ${args.suite}`,
    changeSummary: null,
    provider: effectiveProvider,
    model: cfg.model,
    isMock,
    status: 'running',
    taskId,
  });
  const results = await runBenchmark({
    configId,
    taskId,
    experimentId: exp.id,
    runs: args.runs as number,
    concurrency: args.concurrency as number,
    suite: args.suite as 'dev' | 'holdout',
    phase: args.suite === 'holdout' ? 'holdout' : 'manual',
    providerFactory,
    skipBrowserAgent,
    signal: ctrl.signal,
    db,
  });
  // Shutdown: remove anything of OUR runs that is still around (e.g. after Ctrl-C).
  try {
    for (const r of results) {
      await sandbox.cleanupAbandonedContainers({ all: true, label: `frugal.runId=${r.coding.runId}` });
    }
    await launcher.cleanupEvalResources({ runIds: results.map((r) => r.coding.runId) });
  } catch (e) {
    console.warn(`warning: shutdown container cleanup failed: ${(e as Error).message}`);
  }

  const rows = results.map((r) => {
    const failed = r.evaluation?.checks.filter((c) => c.mandatory && c.outcome !== 'pass').map((c) => c.id) ?? [];
    return [
      r.coding.runId + flagTags(r.coding.usedMockProvider, r.evaluation?.browserAgentSkipped),
      r.coding.status,
      r.evaluation ? (r.evaluation.evaluatorFailure ? 'EVAL-ERROR' : r.evaluation.passed ? 'PASS' : 'FAIL') : '—',
      r.passed ? 'yes' : 'no',
      fmtTokens(r.coding.usage.totalTokens) + (r.coding.usage.anyEstimated ? ' (est.)' : ''),
      fmtUsd(r.coding.usage.costUsd),
      fmtScore(r.evaluation?.visualScore),
      String(r.coding.toolCalls),
      fmtDuration(r.coding.durationMs),
      (r.error ?? (failed.length ? `failed: ${failed.slice(0, 4).join(', ')}${failed.length > 4 ? '…' : ''}` : '')).slice(0, 80),
    ];
  });
  console.log('\n' + textTable(['run', 'status', 'eval', 'passed', 'coding tokens', 'API-equiv cost', 'visual', 'tools', 'time', 'notes'], rows));
  const s = summarize(results, configId, { minPassRate: task.minPassRate, taskId });
  db.updateExperiment(exp.id, {
    summary: { ...s, phase: args.suite === 'holdout' ? 'holdout' : 'manual' },
    isMock: isMock || !!s.usedMockProvider,
    status: ctrl.signal.aborted ? 'interrupted' : 'completed',
    notes: [isMock ? `${MOCK} mock provider` : '', s.browserAgentSkipped ? `${NO_BROWSER} browser agent skipped` : ''].filter(Boolean).join('; ') || null,
  });
  console.log(
    `\nSummary${flagTags(s.usedMockProvider, s.browserAgentSkipped)}: ${s.passes}/${s.runs} passed · median ${fmtTokens(s.medianTokens)} coding tokens · mean ${fmtTokens(s.meanTokens)} · ` +
      `API-equivalent cost ${fmtUsd(s.totalCostUsd)} (coding + evaluator; local price table, not a bill) · median visual ${fmtScore(s.medianVisualScore)}`,
  );
  const why = [
    s.usedMockProvider ? `${MOCK} mock provider` : '',
    s.browserAgentSkipped ? `${NO_BROWSER} browser agent skipped` : '',
    s.passes < s.runs ? `${s.runs - s.passes} run(s) failed${task.minPassRate < 1 ? ` (task minPassRate ${task.minPassRate})` : ''}` : '',
  ].filter(Boolean);
  console.log(`  experiment: ${exp.id} (npm run results -- --experiment ${exp.id})`);
  console.log(`  meets quality requirements / eligible for promotion: ${s.meetsQualityRequirements ? 'yes' : `no (${why.join('; ') || 'no runs'})`}`);
  for (const r of results) {
    if (r.evaluation?.reportFile) console.log(`  report: ${r.evaluation.reportFile}`);
  }
  db.close();
  process.exit(ctrl.signal.aborted ? 130 : s.passes === s.runs && s.runs > 0 ? 0 : 2);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`error: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  });
}
