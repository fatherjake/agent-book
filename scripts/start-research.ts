/**
 * npm run research -- [--max-experiments N] [--max-total-tokens N] [--max-coding-tokens N] [--max-cost USD]
 *                     [--max-duration 8h] [--verification-runs N] [--concurrency N] [--max-tokens-per-run N] [--resume] [--dry-run]
 *                     [--provider mock|anthropic] [--mock-script default|reference-app]
 *                     [--research-provider claude-code|anthropic|mock] [--max-usage-limit-wait 6h]
 *
 * Starts the unattended research loop. Settings come from configs/research.json; flags override.
 * Pause: create results/research.pause (delete it to resume). Ctrl-C / SIGTERM: graceful shutdown.
 * Subscription usage limits: the loop waits for the reset and retries (wait time is not active time).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrExit, ArgError, type CommandSpec } from '../researcher/cli-args.js';
import { fmtDuration, fmtTokens, fmtUsd, MOCK, NO_BROWSER } from '../researcher/format.js';
import { MOCK_SCRIPT_NAMES } from '../researcher/mock-scripts.js';
import type { ResearchSettings } from '../researcher/settings.js';
import type { ResearchAgent } from '../researcher/research-agent.js';
import type { Effort } from '../runner/types.js';

export const RESEARCH_CLI: CommandSpec = {
  command: 'npm run research --',
  summary:
    'Start the autonomous research loop: propose → quick run → verify → promote, within budgets.\n' +
    'Settings: configs/research.json (flags override). Pause by creating results/research.pause; Ctrl-C shuts down gracefully.',
  flags: [
    { name: 'max-experiments', type: 'number', description: 'Max candidate experiments in this session', integer: true, min: 0 },
    { name: 'max-total-tokens', type: 'number', description: 'Max tokens for the session, all roles combined (coding + evaluator + research)', integer: true, min: 1 },
    { name: 'max-coding-tokens', type: 'number', description: 'Max coding-agent tokens for the session (all runs combined)', integer: true, min: 1 },
    {
      name: 'max-cost',
      type: 'number',
      description:
        'Max API-equivalent cost in USD (local price table; nothing is billed per token on a Claude subscription). Off by default',
      min: 0,
    },
    { name: 'max-usage-limit-wait', type: 'string', description: 'Longest wait for a subscription usage-limit reset before stopping, e.g. 6h' },
    { name: 'max-duration', type: 'string', description: 'Max active research time, e.g. 3600, 90m, 8h' },
    { name: 'max-runtime-per-experiment', type: 'string', description: 'Abort an experiment after this long, e.g. 4h' },
    { name: 'verification-runs', type: 'number', description: 'Verification runs per promising candidate', integer: true, min: 1 },
    { name: 'concurrency', type: 'number', description: 'Benchmark runs executed in parallel per batch (default from settings: 5)', integer: true, min: 1 },
    { name: 'max-tokens-per-run', type: 'number', description: "Cap on coding tokens per run (overrides a higher config limit; config files untouched)", integer: true, min: 1000 },
    { name: 'noise-margin', type: 'number', description: 'Required improvement over the best median, in percent', min: 0 },
    { name: 'resume', type: 'boolean', description: "Resume the latest session (its spend and elapsed time count against the budgets)" },
    { name: 'dry-run', type: 'boolean', description: 'Check environment and print effective settings; no paid models, no runs' },
    { name: 'provider', type: 'string', description: `Coding + evaluator provider override (mock: no API calls, results ${MOCK}, never promoted)`, choices: ['mock', 'anthropic'] },
    {
      name: 'mock-script',
      type: 'string',
      description: "INFRA TEST ONLY (needs --provider mock): coding mock script, 'default' (trivial file) or 'reference-app' (pushes the hidden reference app)",
      choices: MOCK_SCRIPT_NAMES,
    },
    {
      name: 'research-provider',
      type: 'string',
      description: `Provider for the research agent itself (claude-code: Claude Code CLI on your subscription, see --research-mode; anthropic: API key; mock: scripted ${MOCK} agent, infra tests only)`,
      choices: ['claude-code', 'anthropic', 'mock'],
    },
    { name: 'research-model', type: 'string', description: 'Research agent model, e.g. claude-sonnet-5-5 or claude-opus-5-5 (default from settings / $RESEARCH_MODEL)' },
    {
      name: 'research-mode',
      type: 'string',
      description: 'claude-code research agent mode: agentic (sandboxed, studies past sessions with Read/Grep/Glob/Bash) or simple (one no-tools call)',
      choices: ['agentic', 'simple'],
    },
    {
      name: 'propose-only',
      type: 'boolean',
      description: 'Ask the research agent for ONE proposal against the current best/baseline and print it; no benchmark runs, nothing written to configs/ or the DB',
    },
    { name: 'prove-isolation', type: 'boolean', description: 'With --propose-only (agentic): run isolation probes inside the research container first and print them' },
    { name: 'keep-workspace', type: 'boolean', description: 'With --propose-only: keep the host research workspace dir and print its path' },
    {
      name: 'skip-browser-agent',
      type: 'boolean',
      description: `Skip the browser-agent evaluation; results are ${NO_BROWSER} and nothing can be promoted. Implied by --provider mock`,
    },
    { name: 'settings', type: 'string', description: 'Research settings file', default: 'configs/research.json' },
    { name: 'db', type: 'string', description: 'SQLite path (default results/benchmark.db or $FRUGAL_DB_PATH)' },
  ],
  examples: [
    'npm run research',
    'npm run research -- --max-experiments 20',
    'npm run research -- --max-total-tokens 50000000 --max-duration 8h',
    'npm run research -- --resume',
    'npm run research -- --dry-run',
    'npm run research -- --propose-only --prove-isolation',
    'npm run research -- --provider mock --mock-script reference-app --research-provider mock --max-experiments 2   # infra test',
  ],
};

/** Parse '3600', '90s', '90m', '8h', '1d' to seconds. */
export function parseDurationSec(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(s.trim());
  if (!m) throw new ArgError(`invalid duration "${s}" (use e.g. 3600, 90m, 8h)`);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Math.round(Number(m[1]) * mult);
}

/** The claude-code research agent (researcher/research-agent-claude-code.ts), loaded lazily. */
async function createClaudeCodeResearchAgentLazy(
  settings: ResearchSettings,
  opts: { usageFile?: string; onSandboxReady?: import('../researcher/research-agent-claude-code.js').CreateAgenticResearchAgentOptions['onSandboxReady']; keepWorkspace?: boolean },
): Promise<ResearchAgent> {
  const mod = await import('../researcher/research-agent-claude-code.js');
  const common = { model: settings.researchModel, effort: settings.researchEffort ?? undefined, usageFile: opts.usageFile };
  if (settings.researchMode === 'simple') return mod.createClaudeCodeResearchAgent({ ...common, maxOutputTokens: settings.researchMaxOutputTokens });
  return mod.createAgenticResearchAgent({
    ...common,
    maxRuntimeSec: settings.researchMaxRuntimeSec,
    maxTotalTokens: settings.researchMaxTotalTokens,
    workspaceLimits: {
      maxExperiments: settings.researchWorkspace.maxExperiments,
      maxRuns: settings.researchWorkspace.maxRuns,
      maxRunBytes: settings.researchWorkspace.maxRunMB * 1024 * 1024,
    },
    onSandboxReady: opts.onSandboxReady,
    keepWorkspace: opts.keepWorkspace,
  });
}

/** Isolation probes run inside the research container (as user node) before the agent starts. */
export const ISOLATION_PROBES: { name: string; cmd: string }[] = [
  { name: 'whoami / id', cmd: 'id' },
  { name: 'ls /', cmd: 'ls /' },
  { name: 'mounts (non-proc)', cmd: "grep -v -E ' /(proc|sys|dev)' /proc/mounts | awk '{print $2, $3, $4}' | cut -c1-120" },
  { name: 'read a host path', cmd: `cat ${JSON.stringify(resolve('.env'))} 2>&1; ls ${JSON.stringify(resolve('evaluator'))} 2>&1; ls /Users 2>&1 | head -3` },
  { name: 'evaluator files anywhere?', cmd: "find / -xdev \\( -path /proc -prune \\) -o \\( -name 'reference-app' -o -name 'ui-scenarios.ts' -o -name 'benchmark.db' -o -path '*evaluator/holdout*' \\) -print 2>/dev/null | head -5; echo \"(end of find)\"" },
  {
    name: 'internet egress (https://example.com)',
    cmd: "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('REACHABLE',r.status)).catch(e=>console.log('BLOCKED:',e.cause?.code||e.message))\"",
  },
  {
    name: 'gateway reachable (only allowed egress)',
    cmd: "node -e \"fetch('http://frugal-gateway:8080/',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('gateway answered HTTP',r.status)).catch(e=>console.log('gateway error:',e.cause?.code||e.message))\"",
  },
  { name: 'write outside scratch', cmd: 'touch /research/README.md 2>&1; touch /research/x 2>&1; touch /etc/x 2>&1; touch /research/scratch/ok && echo scratch-writable' },
  { name: 'docker socket', cmd: 'ls -l /var/run/docker.sock 2>&1' },
  { name: 'env (token placeholder only)', cmd: 'env | grep -E "ANTHROPIC|OAUTH|TOKEN" | sed -E "s/(TOKEN=.{20}).*/\\1.../" ; echo "(env checked in claude exec only)"' },
  { name: 'workspace contents', cmd: 'cd /research && find . -maxdepth 3 | sort | head -80 && du -sh /research' },
];

async function proposeOnly(args: Record<string, unknown>, settings: ResearchSettings, db: import('../storage/db.js').Db): Promise<number> {
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resultsDir } = await import('../runner/env.js');
  const { buildHistoryDigest } = await import('../researcher/history.js');
  const { readConfigFiles, applyProposal, configDir } = await import('../researcher/optimizer.js');
  const { ResearchProposalError } = await import('../researcher/research-agent.js');
  const configsRoot = resolve('configs');
  const best = db.getBestVerified();
  const parent = best?.configId ?? 'baseline';
  const files = readConfigFiles(parent, configsRoot);
  const experimentIndex = db.listExperiments().filter((e) => e.kind === 'candidate').length + 1;
  const usageFile = join(resultsDir(), 'research', 'usage.jsonl');
  const probes: { name: string; out: string }[] = [];
  let workspaceDir: string | undefined;
  const agent =
    settings.researchProvider === 'claude-code'
      ? await createClaudeCodeResearchAgentLazy(settings, {
          usageFile,
          keepWorkspace: Boolean(args['keep-workspace']),
          onSandboxReady: async (s, ws) => {
            workspaceDir = ws.dir;
            if (!args['prove-isolation']) return;
            console.log('\n=== Isolation probes (inside the research container, user node) ===');
            for (const p of ISOLATION_PROBES) {
              const r = await s.exec(p.cmd, 60);
              const out = (r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : '')).trim();
              probes.push({ name: p.name, out });
              console.log(`\n$ ${p.name}\n${out}`);
            }
          },
        })
      : null;
  if (!agent) {
    console.error('error: --propose-only needs researchProvider claude-code');
    return 2;
  }
  console.log(`Proposing candidate #${experimentIndex} on top of ${parent} (${settings.researchMode} mode, ${settings.researchModel}, effort ${settings.researchEffort ?? 'default'})…`);
  const t0 = Date.now();
  const sumTokens = (u: { totalTokens: number }[]) => u.reduce((n, r) => n + r.totalTokens, 0);
  const out: Record<string, unknown> = { at: new Date().toISOString(), parent, experimentIndex, mode: settings.researchMode, model: settings.researchModel, probes };
  let code = 0;
  try {
    const res = await agent.propose({
      context: { db, resultsDir: resultsDir(), configsRoot, verificationRuns: settings.verificationRuns },
      bestConfigId: parent,
      bestConfigFiles: files,
      history: buildHistoryDigest(db, { maxExperiments: settings.historyMaxExperiments }),
      experimentIndex,
      singleVariableExperiments: settings.singleVariableExperiments,
      whitelist: { allowModelChange: settings.allowModelChange, allowedModels: settings.allowedModels },
      experimentId: `propose-only-${Date.now().toString(36)}`,
    });
    const tokens = sumTokens(res.usage);
    console.log('\n=== Proposal ===');
    console.log(`hypothesis:       ${res.proposal.hypothesis}`);
    console.log(`change:           ${res.proposal.changeSummary}`);
    console.log(`evidence:         ${res.research?.evidence ?? '(none)'}`);
    console.log(`expected savings: ${res.research?.expectedSavings ?? '(none)'}`);
    console.log(`files:\n${JSON.stringify(res.proposal.files, null, 2)}`);
    console.log(`\nattempts ${res.attempts} (guard + validation passed inside the agent), ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`research tokens  ${fmtTokens(tokens)} over ${res.usage.length} calls (role research; ${usageFile})`);
    if (res.workspace) console.log(`workspace        ${res.workspace.runs.length} runs, ${res.workspace.experiments.length} experiments, ${(res.workspace.bytes / 1e6).toFixed(1)} MB${workspaceDir && args['keep-workspace'] ? ` (kept at ${workspaceDir})` : ''}`);
    // Dry apply into a TEMP configs root (configs/experiments stays untouched): runs the optimizer + guard path.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'frugal-propose-configs-'));
    cpSync(configDir(parent, configsRoot), join(tmpRoot, parent), { recursive: true });
    let applyVerdict: Record<string, unknown>;
    try {
      const applied = applyProposal({ parentConfigId: parent, proposal: res.proposal, whitelist: { allowModelChange: settings.allowModelChange, allowedModels: settings.allowedModels }, configsRoot: tmpRoot, ...(res.research ? { research: res.research } : {}) } as Parameters<typeof applyProposal>[0]);
      applyVerdict = { ok: true, configDir: applied.dir, diff: applied.diff };
      console.log(`dry apply        ACCEPTED by optimizer/guard → ${applied.dir}`);
      console.log(applied.diff.slice(0, 6000));
    } catch (e) {
      applyVerdict = { ok: false, error: (e as Error).message };
      console.log(`dry apply        REJECTED: ${(e as Error).message}`);
      code = 1;
    }
    Object.assign(out, { proposal: res.proposal, research: res.research, attempts: res.attempts, researchTokens: tokens, researchCalls: res.usage.length, workspace: res.workspace, apply: applyVerdict });
  } catch (e) {
    const err = e as InstanceType<typeof ResearchProposalError>;
    console.error(`\nproposal FAILED: ${err.message}`);
    if (err.usage) console.error(`research tokens  ${fmtTokens(sumTokens(err.usage))} over ${err.usage.length} calls`);
    Object.assign(out, { error: err.message, errors: err.errors, researchTokens: err.usage ? sumTokens(err.usage) : null });
    code = 1;
  }
  const dir = join(resultsDir(), 'research', 'proposals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(out.at).replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nsaved            ${file}`);
  return code;
}

/** `backend` of a config dir's config.json ('api' when absent or unreadable). */
function configBackend(configId: string): 'api' | 'claude-code' {
  try {
    const cfg = JSON.parse(readFileSync(join(resolve('configs'), configId, 'config.json'), 'utf8')) as { backend?: string };
    return cfg.backend === 'claude-code' ? 'claude-code' : 'api';
  } catch {
    return 'api';
  }
}

async function main(): Promise<void> {
  const args = parseOrExit(process.argv.slice(2), RESEARCH_CLI);
  const { loadDotEnv, resultsDir } = await import('../runner/env.js');
  loadDotEnv();
  const { loadResearchSettings, budgetsOf } = await import('../researcher/settings.js');
  const { openDb } = await import('../storage/db.js');

  let overrides: Partial<ResearchSettings>;
  try {
    overrides = {
      maxExperiments: args['max-experiments'] as number | undefined,
      maxResearchCostUsd: args['max-cost'] as number | undefined,
      maxTotalTokens: args['max-total-tokens'] as number | undefined,
      maxCodingTokens: args['max-coding-tokens'] as number | undefined,
      maxUsageLimitWaitSec: args['max-usage-limit-wait'] ? parseDurationSec(args['max-usage-limit-wait'] as string) : undefined,
      maxTotalDurationSec: args['max-duration'] ? parseDurationSec(args['max-duration'] as string) : undefined,
      maxRuntimePerExperimentSec: args['max-runtime-per-experiment'] ? parseDurationSec(args['max-runtime-per-experiment'] as string) : undefined,
      verificationRuns: args['verification-runs'] as number | undefined,
      runConcurrency: args.concurrency as number | undefined,
      maxTokensPerCodingRun: args['max-tokens-per-run'] as number | undefined,
      noiseMarginPct: args['noise-margin'] as number | undefined,
      codingProvider: (args.provider as string | undefined) ?? undefined,
      researchProvider: args['research-provider'] as string | undefined,
      researchModel: args['research-model'] as string | undefined,
      researchMode: args['research-mode'] as ResearchSettings['researchMode'] | undefined,
      skipBrowserAgent: args['skip-browser-agent'] ? true : undefined,
    };
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }

  const db = openDb(args.db as string | undefined);
  // On --resume, the stored session budgets are the base; explicit flags still override them.
  if (args.resume) {
    const prev = db.latestSession();
    if (prev) {
      const explicit = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      overrides = { ...prev.budgets, ...explicit } as Partial<ResearchSettings>;
    }
  }
  let settings = loadResearchSettings(args.settings as string, overrides);
  const codingProviderName = settings.codingProvider;
  const isMock = codingProviderName === 'mock';
  const mockScriptName = args['mock-script'] as string | undefined;
  if (mockScriptName && !isMock) {
    console.error('error: --mock-script requires --provider mock (it is an infrastructure-test option).');
    process.exit(2);
  }
  if (isMock && !settings.skipBrowserAgent) {
    settings = { ...settings, skipBrowserAgent: true };
    console.warn(`warning: --provider mock implies --skip-browser-agent (a mock model cannot judge a UI); results are ${MOCK} ${NO_BROWSER}.`);
  }

  const describe = () => {
    const b = budgetsOf(settings);
    console.log('Effective research settings:');
    console.log(`  research agent      ${settings.researchProvider}/${settings.researchModel} (effort ${settings.researchEffort ?? 'default'})`);
    if (settings.researchProvider === 'claude-code')
      console.log(
        settings.researchMode === 'agentic'
          ? `  research mode       agentic (sandboxed; ${settings.researchMaxRuntimeSec}s, ${fmtTokens(settings.researchMaxTotalTokens)} research tokens per proposal)`
          : '  research mode       simple (one no-tools call)',
      );
    console.log(`  coding provider     ${codingProviderName ?? "each config's own"}${isMock ? ` ${MOCK} (script: ${mockScriptName ?? 'default'})` : ''}`);
    console.log(`  browser agent       ${settings.skipBrowserAgent ? `SKIPPED ${NO_BROWSER} (nothing can be promoted)` : 'on'}`);
    console.log(`  max experiments     ${b.maxExperiments}`);
    console.log(`  max total tokens    ${b.maxTotalTokens ? fmtTokens(b.maxTotalTokens) : 'no cap'} (coding + evaluator + research)`);
    console.log(`  max coding tokens   ${b.maxCodingTokens ? fmtTokens(b.maxCodingTokens) : 'no cap'}`);
    console.log(`  max API-equiv. cost ${b.maxResearchCostUsd === null ? 'off' : fmtUsd(b.maxResearchCostUsd)} (local price table; not billed on a subscription)`);
    console.log(`  usage-limit waits   up to ${fmtDuration(settings.maxUsageLimitWaitSec * 1000)} per reset (+${settings.usageLimitMarginSec}s margin; not counted as active time)`);
    console.log(`  max duration        ${fmtDuration(b.maxTotalDurationSec * 1000)} active`);
    console.log(`  per experiment      ${fmtDuration(b.maxRuntimePerExperimentSec * 1000)}`);
    console.log(`  tokens per run cap  ${b.maxTokensPerCodingRun ? fmtTokens(b.maxTokensPerCodingRun) : 'config limit'}`);
    console.log(`  verification runs   ${b.verificationRuns} (quick runs: ${settings.quickRuns}, noise margin ${settings.noiseMarginPct}%, ${settings.runConcurrency} in parallel)`);
    console.log(`  holdout             ${settings.holdout.onPromotion ? `${settings.holdout.runs} run(s) on each promotion` : 'off'}`);
    console.log(`  single-variable     first ${settings.singleVariableExperiments} experiments`);
    console.log(`  pause file          ${join(resultsDir(), 'research.pause')}`);
    if (args.resume) {
      const prev = db.latestSession();
      console.log(
        prev
          ? `  resume              ${prev.id} (${fmtTokens(db.sessionTokens(prev.id).total)} tokens, API-equivalent ${fmtUsd(db.sessionSpend(prev.id).total)}, ${prev.experimentsRun} experiments)`
          : '  resume              no previous session; a new one will start',
      );
    }
  };

  if (args['propose-only']) {
    const code = await proposeOnly(args, settings, db);
    db.close();
    process.exit(code);
  }

  if (args['dry-run']) {
    describe();
    console.log('\nEnvironment (no paid models are invoked):');
    const { environmentChecks } = await import('./run-benchmark.js');
    const best = db.getBestVerified();
    const items = await environmentChecks({ configId: best?.configId ?? 'baseline', provider: codingProviderName ?? undefined, dbPath: args.db as string | undefined });
    if (settings.researchProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY)
      items.push({ name: 'Research agent key', ok: false, detail: 'ANTHROPIC_API_KEY missing (research agent uses anthropic)' });
    if (settings.researchProvider === 'claude-code') {
      const gw = await import('../runner/gateway.js');
      items.push(
        gw.hasSubscriptionToken()
          ? { name: 'Research agent (claude-code)', ok: true, detail: 'CLAUDE_CODE_OAUTH_TOKEN set (subscription via local gateway)' }
          : { name: 'Research agent (claude-code)', ok: false, detail: gw.SETUP_TOKEN_HELP },
      );
    }
    let ok = true;
    for (const c of items) {
      const mark = c.ok ? '✓' : c.warnOnly ? '!' : '✗';
      if (!c.ok && !c.warnOnly) ok = false;
      console.log(`${mark} ${c.name.padEnd(28)} ${c.detail}`);
    }
    db.close();
    console.log(ok ? '\nReady to start research.' : '\nSome checks failed.');
    process.exit(ok ? 0 : 1);
  }

  // Credentials: claude-code (subscription) needs CLAUDE_CODE_OAUTH_TOKEN; anthropic (API) needs ANTHROPIC_API_KEY.
  {
    const gw = await import('../runner/gateway.js');
    const codingNeedsKey = codingProviderName === 'anthropic' || (codingProviderName === null && configBackend(db.getBestVerified()?.configId ?? 'baseline') === 'api');
    if ((settings.researchProvider === 'anthropic' || codingNeedsKey) && !process.env.ANTHROPIC_API_KEY) {
      console.error('error: ANTHROPIC_API_KEY is not set (needed for the anthropic research agent and/or api-backend coding runs). Use --dry-run to check the setup.');
      process.exit(1);
    }
    if (settings.researchProvider === 'claude-code' && !gw.hasSubscriptionToken()) {
      console.error(`error: ${gw.SETUP_TOKEN_HELP}`);
      process.exit(1);
    }
  }

  const [{ runResearchLoop }, { runBenchmark }, { createResearchAgent }, { createProvider }, sandbox, launcher, { resolveMockScript }, { MockResearchProvider }] =
    await Promise.all([
      import('../researcher/loop.js'),
      import('../researcher/experiment.js'),
      import('../researcher/research-agent.js'),
      import('../runner/providers/index.js'),
      import('../runner/sandbox.js'),
      import('../evaluator/app-launcher.js'),
      import('../researcher/mock-scripts.js'),
      import('../researcher/mock-research-provider.js'),
    ]);

  // Runs that were 'running' when a previous process died: their containers are removed by label.
  const orphanRunIds = db.listRuns().filter((r) => r.status === 'running').map((r) => r.runId);
  const cleanupContainers = async () => {
    let n = 0;
    for (const id of orphanRunIds) n += await sandbox.cleanupAbandonedContainers({ all: true, label: `frugal.runId=${id}` });
    n += await sandbox.cleanupAbandonedContainers();
    // Eval containers + per-run eval networks left by a crashed process (research is single-writer).
    n += await launcher.cleanupEvalResources();
    return n;
  };

  const ctrl = new AbortController();
  let stopping = false;
  const onSig = (sig: string) => {
    if (stopping) {
      console.error('Second interrupt: exiting immediately (experiment will be recovered as interrupted on next start).');
      process.exit(130);
    }
    stopping = true;
    console.error(`\n${sig} received: aborting the current run and shutting down gracefully (again to force quit)…`);
    ctrl.abort();
  };
  process.on('SIGINT', () => onSig('SIGINT'));
  process.on('SIGTERM', () => onSig('SIGTERM'));

  describe();
  if ((await import('../runner/keep-awake.js')).keepAwake())
    console.log('  keep awake          caffeinate -i -s while running (lid-close sleep is NOT prevented; FRUGAL_NO_CAFFEINATE=1 disables)');
  if (isMock) console.log(`\n${MOCK} Coding runs use the mock provider: no real benchmark results; nothing can be promoted.`);
  if (settings.researchProvider === 'mock')
    console.log(`${MOCK} The research agent is a scripted mock: its proposals are trivial placeholders, not research.`);
  console.log('');

  const researchUsageFile = join(resultsDir(), 'research', 'usage.jsonl');
  const researchAgent: ResearchAgent =
    settings.researchProvider === 'claude-code'
      ? await createClaudeCodeResearchAgentLazy(settings, { usageFile: researchUsageFile })
      : createResearchAgent({
          provider: settings.researchProvider === 'mock' ? new MockResearchProvider() : createProvider(settings.researchProvider),
          model: settings.researchModel,
          effort: settings.researchEffort ?? undefined,
          maxOutputTokens: settings.researchMaxOutputTokens,
          usageFile: researchUsageFile,
        });
  const res = await runResearchLoop(
    {
      db,
      runBenchmark,
      researchAgent,
      cleanupContainers,
      // Fresh provider per run: the mock is a stateful script.
      codingProviderFactory: codingProviderName
        ? () => createProvider(codingProviderName, isMock ? { mockScript: resolveMockScript(mockScriptName ?? 'default') } : {})
        : undefined,
    },
    { settings, resume: Boolean(args.resume), signal: ctrl.signal, paths: { resultsDir: resultsDir(), configsRoot: resolve('configs') } },
  );

  console.log(`\nResearch stopped: ${res.stopReason}`);
  console.log(`  session      ${res.sessionId}`);
  console.log(`  experiments  ${res.experimentsRun}`);
  console.log(`  tokens       ${fmtTokens(res.totalTokens)} (all roles)`);
  console.log(`  API-equiv.   ${fmtUsd(res.spentUsd)} (local price table; not billed on a subscription)`);
  if (res.usageLimitWaitMs) console.log(`  usage-limit  waited ${fmtDuration(res.usageLimitWaitMs)} for subscription resets (not counted as active time)`);
  console.log(res.best ? `  best         ${res.best.configId} — median ${fmtTokens(res.best.medianTokens)} coding tokens (results/best-config/)` : '  best         none verified yet');
  db.close();
  process.exit(res.stopReason === 'interrupted' ? 130 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`error: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  });
}
