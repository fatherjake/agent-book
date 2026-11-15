/**
 * runCodingAgent: one complete, isolated coding run.
 *   ensure image → create sandbox (+ /spec) → agent loop → snapshot /workspace (no node_modules)
 *   → run.json → destroy container (always).
 * Never throws for run failures (docker, API, broken agent); they are recorded in the result.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { AgentConfig, CodingRunResult, ModelProvider, RunLimits, RunStatus, Sandbox, TokenTotals } from './types.js';
import type { StartGatewayOptions } from './gateway.js';
import { hashConfig, snapshotConfig } from './config.js';
import { REPO_ROOT, SPEC_DIR, resultsDir } from './env.js';
import { TokenTracker, emptyTotals } from './token-tracker.js';
import { createProvider } from './providers/index.js';
import { runAgent, type SpecFile } from './agent.js';
import { logger } from './logger.js';

const log = logger('run');

export interface ImageInfo {
  image: string;
  imageId: string;
  starterHash: string;
}

export interface RunCodingAgentOptions {
  config: AgentConfig;
  runId?: string;
  experimentId?: string;
  seed: number;
  /** Defaults to createProvider(config.provider). */
  provider?: ModelProvider;
  signal?: AbortSignal;
  /** Defaults to results/ (or $FRUGAL_RESULTS_DIR). */
  resultsDir?: string;
  /** Defaults to benchmark/spec. */
  specDir?: string;
  /** Test hooks: skip ensureImage / docker. */
  image?: ImageInfo;
  sandboxFactory?: (opts: { image: ImageInfo; runId: string; specDir: string }) => Promise<Sandbox>;
  /** Observer for each usage record (e.g. SQLite). */
  onUsageRecord?: (r: import('./types.js').UsageRecord) => void;
  diskLimitMB?: number;
  /** Tighten limits for this run only: min(config limit, override) per field. Never loosens. Does not change configHash. */
  limitsOverride?: Partial<RunLimits>;
  /** claude-code backend, TESTS ONLY: extra gateway options (e.g. a loopback fake upstream + token). */
  gatewayOptions?: Pick<StartGatewayOptions, 'upstreamUrl' | 'token'>;
  /** claude-code backend: replace the whole task prompt (smoke tests). Default: the benchmark task + inline spec files. */
  taskPrompt?: string;
}

/**
 * Which backend a run uses. 'claude-code' only when the config asks for it AND the run is not a
 * mock run (a mock provider or provider 'mock' falls back to the api loop so `--provider mock`
 * infra tests keep working with any config). A non-mock provider passed in is ignored by claude-code.
 */
export function selectBackend(config: AgentConfig, provider?: ModelProvider): 'api' | 'claude-code' {
  if (config.backend !== 'claude-code') return 'api';
  if (provider?.isMock || config.provider === 'mock') return 'api';
  return 'claude-code';
}

/** min(config limit, override) per field; invalid/missing override values are ignored. */
export function effectiveLimits(base: RunLimits, override?: Partial<RunLimits>): RunLimits {
  const pick = (b: number, o: unknown) => (typeof o === 'number' && Number.isFinite(o) && o > 0 ? Math.min(b, o) : b);
  return {
    maxTotalTokens: pick(base.maxTotalTokens, override?.maxTotalTokens),
    maxModelCalls: pick(base.maxModelCalls, override?.maxModelCalls),
    maxRuntimeSec: pick(base.maxRuntimeSec, override?.maxRuntimeSec),
  };
}

export function newRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `run_${ts}_${randomBytes(3).toString('hex')}`;
}

const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg'> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** Read a spec file from disk as text or image. Returns undefined when missing. */
export function readSpecFile(specDir: string, name: string): SpecFile | undefined {
  const p = join(specDir, name);
  if (!existsSync(p)) return undefined;
  const mt = IMAGE_TYPES[extname(name).toLowerCase()];
  if (mt) return { name, image: { mediaType: mt, dataBase64: readFileSync(p).toString('base64') } };
  return { name, content: readFileSync(p, 'utf8') };
}

const rel = (p: string) => relative(REPO_ROOT, p).split('\\').join('/');

export async function runCodingAgent(opts: RunCodingAgentOptions): Promise<CodingRunResult> {
  const result = await runCodingAgentInner(opts);
  // Session token profile (profile.json + profile.md in the run dir). Best effort: never fails a run.
  try {
    const { writeSessionProfile } = await import('../researcher/session-profile.js');
    writeSessionProfile(join(opts.resultsDir ?? resultsDir(), 'runs', result.runId));
  } catch (e) {
    log.warn('session profile failed', { runId: result.runId, error: String((e as Error)?.message ?? e) });
  }
  return result;
}

async function runCodingAgentInner(opts: RunCodingAgentOptions): Promise<CodingRunResult> {
  const { config } = opts;
  const limits = effectiveLimits(config.limits, opts.limitsOverride);
  const runId = opts.runId ?? newRunId();
  const startedAt = new Date();
  const runDir = join(opts.resultsDir ?? resultsDir(), 'runs', runId);
  const specDir = opts.specDir ?? SPEC_DIR;
  const paths = {
    appSnapshotDir: join(runDir, 'app'),
    traceFile: join(runDir, 'trace.jsonl'),
    usageFile: join(runDir, 'usage.jsonl'),
    configSnapshotDir: join(runDir, 'config'),
  };
  mkdirSync(runDir, { recursive: true });

  const backend = selectBackend(config, opts.provider);
  if (backend === 'claude-code') return runClaudeCodeBackend(opts, { runId, runDir, startedAt, limits, specDir, paths });
  if (config.backend === 'claude-code') log.warn('claude-code config run with the mock provider: using the api agent loop', { runId });

  const tracker = new TokenTracker({ role: 'coding', runId, experimentId: opts.experimentId, usageFile: paths.usageFile, onRecord: opts.onUsageRecord });
  let status: RunStatus = 'infra_error';
  let failureReason: string | undefined;
  let toolCalls = 0;
  let image: ImageInfo = { image: '', imageId: '', starterHash: '' };
  let configHash = '';
  let usedMock = config.provider === 'mock';
  let sandbox: Sandbox | undefined;

  try {
    configHash = hashConfig(config);
    snapshotConfig(config, paths.configSnapshotDir);

    const provider = opts.provider ?? createProvider(config.provider);
    usedMock = provider.isMock;

    image = opts.image ?? (await (await import('./sandbox.js')).ensureImage());

    const inlineSpec: SpecFile[] = [];
    for (const name of config.inlineSpecFiles) {
      const f = readSpecFile(specDir, name);
      if (f) inlineSpec.push(f);
      else log.warn('inline spec file not found; skipping', { name, specDir });
    }
    const designImage = config.designDelivery === 'inline-image' ? readSpecFile(specDir, 'design.png') : undefined;
    if (config.designDelivery === 'inline-image' && !designImage) log.warn('design.png not found in spec dir', { specDir });

    if (opts.sandboxFactory) sandbox = await opts.sandboxFactory({ image, runId, specDir });
    else {
      const { createSandbox } = await import('./sandbox.js');
      sandbox = await createSandbox({ image: image.image, imageId: image.imageId, runId, role: 'coding', network: 'none', specDir });
    }

    const result = await runAgent({
      config: { ...config, limits },
      provider,
      tracker,
      sandbox,
      inlineSpec,
      designImage,
      traceFile: paths.traceFile,
      signal: opts.signal,
      diskLimitMB: opts.diskLimitMB,
    });
    status = result.status;
    failureReason = result.failureReason;
    toolCalls = result.toolCalls;

    try {
      await sandbox.copyOut('/workspace', paths.appSnapshotDir);
    } catch (e) {
      const msg = `app snapshot failed: ${String((e as Error)?.message ?? e)}`;
      log.error(msg, { runId });
      failureReason = failureReason ? `${failureReason}; ${msg}` : msg;
      status = 'infra_error';
    }
  } catch (e) {
    status = opts.signal?.aborted ? 'interrupted' : 'infra_error';
    failureReason = String((e as Error)?.message ?? e);
    log.error('coding run failed', { runId, error: failureReason });
  } finally {
    if (sandbox) {
      try {
        await sandbox.destroy();
      } catch (e) {
        log.warn('sandbox destroy failed', { runId, error: String(e) });
      }
    }
  }

  const finishedAt = new Date();
  const result: CodingRunResult = {
    runId,
    experimentId: opts.experimentId,
    configId: config.id,
    seed: opts.seed,
    status,
    ...(failureReason ? { failureReason } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    imageId: image.imageId,
    starterHash: image.starterHash,
    configHash,
    usage: tracker.records().length ? tracker.totals() : emptyTotals(),
    toolCalls,
    artifacts: {
      appSnapshotDir: rel(paths.appSnapshotDir),
      traceFile: rel(paths.traceFile),
      usageFile: rel(paths.usageFile),
      configSnapshotDir: rel(paths.configSnapshotDir),
    },
    usedMockProvider: usedMock,
    effectiveLimits: limits,
  };
  try {
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    log.error('failed to write run.json', { runId, error: String(e) });
  }
  log.info(`run ${runId} finished: ${status}`, { runId, status, failureReason, totalTokens: result.usage.totalTokens, usedMock });
  return result;
}

// ---------------------------------------------------------------------------
// claude-code backend
// ---------------------------------------------------------------------------

interface RunCtx {
  runId: string;
  runDir: string;
  startedAt: Date;
  limits: RunLimits;
  specDir: string;
  paths: { appSnapshotDir: string; traceFile: string; usageFile: string; configSnapshotDir: string };
}

const CC_HOME_TMPFS = '/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0755';

/**
 * Coding run with the real Claude Code CLI inside the container:
 *   gateway (host) → per-run internal network + forwarder → sandbox (cc image, /spec, ~/.claude files)
 *   → `claude -p` → trace.jsonl + claude-stream.jsonl → snapshot → destroy (always) → run.json.
 * The gateway's usage records (usage.jsonl, role 'coding') are authoritative. Never throws.
 */
async function runClaudeCodeBackend(opts: RunCodingAgentOptions, ctx: RunCtx): Promise<CodingRunResult> {
  const { config } = opts;
  const { runId, runDir, startedAt, limits, specDir, paths } = ctx;
  const streamFile = join(runDir, 'claude-stream.jsonl');
  let status: RunStatus = 'infra_error';
  let failureReason: string | undefined;
  let toolCalls = 0;
  let image: ImageInfo = { image: '', imageId: '', starterHash: '' };
  let configHash = '';
  let usageLimitResetAt: string | undefined;
  let usageCrossCheck: CodingRunResult['usageCrossCheck'];
  let configAudit: CodingRunResult['configAudit'];
  let sandbox: Sandbox | undefined;
  let gateway: import('./gateway.js').GatewayHandle | undefined;
  let network: import('./gateway-network.js').GatewayNetwork | undefined;

  try {
    configHash = hashConfig(config);
    snapshotConfig(config, paths.configSnapshotDir);
    const { startGateway } = await import('./gateway.js');
    gateway = await startGateway({
      role: 'coding',
      runId,
      experimentId: opts.experimentId,
      usageFile: paths.usageFile,
      limits: { maxTotalTokens: limits.maxTotalTokens, maxModelCalls: limits.maxModelCalls },
      onUsageRecord: opts.onUsageRecord,
      mainModel: config.model,
      ...(opts.gatewayOptions ?? {}),
    });

    let forwarderImage: string;
    if (opts.image) {
      image = opts.image;
      forwarderImage = opts.image.image;
    } else {
      const { ensureClaudeCodeImage } = await import('./claude-code-image.js');
      const cc = await ensureClaudeCodeImage();
      image = { image: cc.image, imageId: cc.imageId, starterHash: cc.starterHash };
      forwarderImage = cc.baseImage;
    }

    const inlineSpec = [];
    for (const name of config.inlineSpecFiles) {
      const f = readSpecFile(specDir, name);
      if (f) inlineSpec.push(f);
      else log.warn('inline spec file not found; skipping', { name, specDir });
    }
    const { buildClaudeCodePrompt, runClaudeCodeInSandbox, streamToTrace, countToolUses, streamResultTotals, FRUGAL_OPT_TMPFS, readBinAuditLog, hookEventCounts } = await import('./claude-code.js');
    const prompt = opts.taskPrompt ?? buildClaudeCodePrompt(config, inlineSpec);

    if (opts.sandboxFactory) sandbox = await opts.sandboxFactory({ image, runId, specDir });
    else {
      const { createGatewayNetwork } = await import('./gateway-network.js');
      network = await createGatewayNetwork({ runId, gatewayPort: gateway.port, image: forwarderImage });
      const { createSandbox } = await import('./sandbox.js');
      sandbox = await createSandbox({
        image: image.image,
        imageId: image.imageId,
        runId,
        role: 'coding',
        network: network.network,
        specDir,
        home: '/home/node',
        // /opt/frugal holds the config's bin scripts (root-owned, read-only to the agent; outside /workspace).
        extraTmpfs: [CC_HOME_TMPFS, ...(config.bin?.length ? [FRUGAL_OPT_TMPFS] : [])],
      });
    }
    const gatewayUrl = network?.gatewayUrl ?? gateway.containerUrl;

    // Workspace disk limit (same default as the api loop): checked once a minute.
    const diskLimit = opts.diskLimitMB ?? 2048;
    const ctrl = new AbortController();
    let diskExceeded: string | undefined;
    const onOuterAbort = () => ctrl.abort();
    if (opts.signal?.aborted) ctrl.abort();
    else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const sb = sandbox;
    const diskTimer =
      diskLimit > 0 && 'diskUsageMB' in sb
        ? setInterval(async () => {
            const mb = await (sb as unknown as { diskUsageMB(): Promise<number> }).diskUsageMB().catch(() => NaN);
            if (Number.isFinite(mb) && mb > diskLimit && !diskExceeded) {
              diskExceeded = `workspace uses ${Math.round(mb)} MiB > limit ${diskLimit} MiB`;
              ctrl.abort();
            }
          }, 60_000)
        : undefined;

    let r;
    try {
      r = await runClaudeCodeInSandbox({
        sandbox: sandbox as unknown as import('./claude-code.js').ClaudeSandbox,
        config,
        prompt,
        gateway,
        gatewayUrl,
        timeoutSec: limits.maxRuntimeSec,
        streamFile,
        signal: ctrl.signal,
      });
    } finally {
      if (diskTimer) clearInterval(diskTimer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    toolCalls = countToolUses(r.events);
    const gwLimit = gateway.limitExceeded();
    const ul = gateway.usageLimitResetAt() ?? r.streamUsageLimitResetAt ?? null;
    const res = r.result;
    if (opts.signal?.aborted) {
      status = 'interrupted';
      failureReason = 'run aborted by signal';
    } else if (ul) {
      status = 'infra_error';
      failureReason = 'usage_limit'; // exact value the research loop matches; reset time is in usageLimitResetAt
      usageLimitResetAt = ul;
    } else if (diskExceeded) {
      status = 'limit_exceeded';
      failureReason = diskExceeded;
    } else if (gwLimit) {
      status = 'limit_exceeded';
      failureReason = gwLimit;
    } else if (r.timedOut) {
      status = 'limit_exceeded';
      failureReason = `maxRuntimeSec (${limits.maxRuntimeSec}) exceeded`;
    } else if (res && res.is_error !== true && res.subtype === 'success') {
      status = 'completed';
    } else if (res) {
      const apiErr = res.terminal_reason === 'api_error' || res.api_error_status != null || /authentication|not logged in|api error|overloaded/i.test(String(res.result ?? ''));
      status = apiErr ? 'infra_error' : res.subtype === 'error_max_budget_usd' || res.subtype === 'error_max_turns' ? 'limit_exceeded' : 'agent_error';
      failureReason = `claude-code ended with ${res.subtype ?? 'error'}${res.terminal_reason ? ` (${res.terminal_reason})` : ''}: ${String(res.result ?? '').slice(0, 300)}`;
    } else {
      status = 'infra_error';
      failureReason = `claude-code exited (code ${r.exitCode}) without a result event: ${r.stderr.trim().slice(-500) || 'no stderr'}`;
    }

    // Trace (existing schema) + cross-check of gateway totals against the stream's own totals.
    const gwTotals = gateway.tracker.totals();
    const st = streamResultTotals(res);
    const g = {
      inputTokens: gwTotals.inputTokens,
      outputTokens: gwTotals.outputTokens,
      cacheReadTokens: gwTotals.cacheReadTokens,
      cacheWriteTokens: gwTotals.cacheWriteTokens,
      totalTokens: gwTotals.totalTokens,
      modelCalls: gateway.tracker.records().filter((x) => x.purpose !== 'count-tokens').length,
    };
    const match = !!st && st.inputTokens === g.inputTokens && st.outputTokens === g.outputTokens && st.cacheReadTokens === g.cacheReadTokens && st.cacheWriteTokens === g.cacheWriteTokens;
    usageCrossCheck = {
      gateway: g,
      stream: st,
      match,
      ...(match ? {} : { note: st ? 'gateway totals differ from Claude Code result totals (gateway is authoritative)' : 'no result usage in the stream' }),
    };
    if (!match) log.warn('usage cross-check mismatch (gateway is authoritative)', { runId, gateway: g, stream: st });
    try {
      const trace = streamToTrace(r.events, {
        configId: config.id,
        model: config.model,
        limits,
        extraEnd: { runStatus: status, failureReason, gatewayTotals: gwTotals, usageCrossCheck, exitCode: r.exitCode, timedOut: r.timedOut },
      });
      writeFileSync(paths.traceFile, trace.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch (e) {
      log.warn('failed to write trace', { runId, error: String(e) });
    }

    try {
      await sandbox.copyOut('/workspace', paths.appSnapshotDir);
    } catch (e) {
      const msg = `app snapshot failed: ${String((e as Error)?.message ?? e)}`;
      log.error(msg, { runId });
      failureReason = failureReason ? `${failureReason}; ${msg}` : msg;
      if (!usageLimitResetAt) status = 'infra_error';
    }

    // Anti-cheating runtime audit (researcher/config-guard.ts): which bin scripts and hooks ran, whether a
    // bin script wrote app source, whether the snapshot reproduces config content. Flagged runs fail.
    try {
      const { auditCodingRun } = await import('../researcher/config-guard.js');
      const log0 = await readBinAuditLog(sandbox as unknown as import('./claude-code.js').ClaudeSandbox, config);
      configAudit = auditCodingRun({ config, ...log0, hookCounts: hookEventCounts(r.events), appDir: paths.appSnapshotDir });
      if (configAudit.flagged) {
        log.error('config audit flagged the run (app code from the config)', { runId, reasons: configAudit.reasons });
        if (status === 'completed') status = 'agent_error';
        const msg = `config_audit: ${configAudit.reasons.join('; ')}`;
        failureReason = failureReason ? `${failureReason}; ${msg}` : msg;
      }
    } catch (e) {
      log.warn('config audit failed', { runId, error: String((e as Error)?.message ?? e) });
    }
  } catch (e) {
    status = opts.signal?.aborted ? 'interrupted' : 'infra_error';
    failureReason = String((e as Error)?.message ?? e);
    log.error('coding run failed', { runId, error: failureReason });
  } finally {
    if (sandbox) {
      try {
        await sandbox.destroy();
      } catch (e) {
        log.warn('sandbox destroy failed', { runId, error: String(e) });
      }
    }
    if (network) await network.destroy();
    if (gateway) await gateway.stop().catch(() => undefined);
  }

  const finishedAt = new Date();
  const usage: TokenTotals = gateway && gateway.tracker.records().length ? gateway.tracker.totals() : emptyTotals();
  const result: CodingRunResult = {
    runId,
    experimentId: opts.experimentId,
    configId: config.id,
    seed: opts.seed,
    status,
    ...(failureReason ? { failureReason } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    imageId: image.imageId,
    starterHash: image.starterHash,
    configHash,
    usage,
    toolCalls,
    artifacts: {
      appSnapshotDir: rel(paths.appSnapshotDir),
      traceFile: rel(paths.traceFile),
      usageFile: rel(paths.usageFile),
      configSnapshotDir: rel(paths.configSnapshotDir),
    },
    usedMockProvider: false,
    effectiveLimits: limits,
    backend: 'claude-code',
    ...(usageLimitResetAt ? { usageLimitResetAt } : {}),
    ...(usageCrossCheck ? { usageCrossCheck } : {}),
    ...(configAudit ? { configAudit } : {}),
  };
  try {
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    log.error('failed to write run.json', { runId, error: String(e) });
  }
  log.info(`run ${runId} finished: ${status} (claude-code; API-equivalent cost $${usage.costUsd.toFixed(4)})`, {
    runId,
    status,
    failureReason,
    totalTokens: usage.totalTokens,
  });
  return result;
}
