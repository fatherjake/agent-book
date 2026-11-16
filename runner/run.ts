/**
 * runCodingAgent: one complete, isolated coding run of one task (docs/TASKS.md; default 'todo').
 *   ensure image → create sandbox (+ /spec, task resources/mounts, services hook) → agent loop
 *   → snapshot (tree: /workspace without node_modules → app/; git-diff: workspace.patch vs the checkpoint)
 *   → run.json → destroy container (always).
 * The task drives image, prompt, spec dir, sandbox resources, extra mounts, limits and snapshot mode;
 * todo keeps the original code path unchanged.
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
import { DEFAULT_TASK_ID, getTask, isTodoTask, readTaskPrompt, taskLimits, type Task } from './tasks.js';
import type { CreateSandboxOptions } from './sandbox.js';
import { recordCheckpoint, snapshotGitDiff } from './snapshot.js';

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
  /** `sandbox`: the createSandbox options the run would have used (task resources, mounts, start hook). */
  sandboxFactory?: (opts: { image: ImageInfo; runId: string; specDir: string; task: Task; sandbox: Partial<CreateSandboxOptions> }) => Promise<Sandbox>;
  /** Benchmark task (id or loaded task). Default 'todo'. */
  task?: string | Task;
  /** Observer for each usage record (e.g. SQLite). */
  onUsageRecord?: (r: import('./types.js').UsageRecord) => void;
  diskLimitMB?: number;
  /** Tighten limits for this run only: min(config limit, override) per field. Never loosens. Does not change configHash. */
  limitsOverride?: Partial<RunLimits>;
  /** claude-code backend, TESTS ONLY: extra gateway options (e.g. a loopback fake upstream + token). */
  gatewayOptions?: Pick<StartGatewayOptions, 'upstreamUrl' | 'token'>;
  /** claude-code backend: replace the whole task prompt (smoke tests). Default: the benchmark task + inline spec files. */
  taskPrompt?: string;
  /**
   * git-diff tasks: a patch applied to /workspace and folded into the checkpoint commit BEFORE the checkpoint
   * is recorded (e.g. the repo's skill files under test, a suggestion's edits, an injected bug). It is part of
   * the starting state: it never shows up in workspace.patch, and git history does not reveal it.
   */
  workspaceOverlay?: string;
}

/** Apply and commit a workspace overlay (see RunCodingAgentOptions.workspaceOverlay). */
export async function applyWorkspaceOverlay(sandbox: Pick<Sandbox, 'exec' | 'writeFile'>, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const file = '/tmp/.frugal-overlay.patch';
  await sandbox.writeFile(file, patch.endsWith('\n') ? patch : patch + '\n');
  const r = await sandbox.exec(
    `cd /workspace && git apply --binary --whitespace=nowarn ${file} && git add -A && ` +
      // Folded into the checkpoint commit (same message, author and dates), so history stays one commit and
      // `git show` / `git log -p` cannot reveal what the overlay added (e.g. an injected bug).
      `GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git -c user.name=frugal -c user.email=frugal@localhost commit -q --amend --no-edit --no-verify --no-gpg-sign; rc=$?; rm -f ${file} 2>/dev/null; exit $rc`,
    { timeoutSec: 120, cwd: '/workspace' },
  );
  if (r.exitCode !== 0) throw new Error(`workspace overlay did not apply (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 1500)}`);
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

/** Every non-todo task image provides this idempotent hook; the runner starts its services at sandbox creation. */
export const TASK_SERVICES_START = '/opt/frugal/task/services start';

/** createSandbox options that come from the task (resources, extra mounts, services hook). todo: none (defaults). */
export function taskSandboxOptions(task: Task): Partial<CreateSandboxOptions> {
  if (isTodoTask(task)) return {};
  return {
    cpus: task.sandbox.cpus,
    memory: task.sandbox.memory,
    pidsLimit: task.sandbox.pidsLimit,
    ...(task.sandbox.extraVolumes?.length ? { extraVolumes: task.sandbox.extraVolumes } : {}),
    ...(task.sandbox.shmSize ? { shmSize: task.sandbox.shmSize } : {}),
    extraTmpfs: [...(task.sandbox.extraTmpfs ?? [])],
    startHook: { command: TASK_SERVICES_START, timeoutSec: 300 },
  };
}

/**
 * Disk limit of a run in MiB. todo: the limit applies to the whole /workspace (unchanged). Other tasks start from a
 * large checkout (gems, node_modules), so the limit applies to the GROWTH over the size at start.
 */
async function diskLimitFor(sandbox: Sandbox, task: Task, limitMB: number): Promise<number> {
  if (isTodoTask(task) || limitMB <= 0) return limitMB;
  const r = await sandbox.exec('du -sk /workspace 2>/dev/null | cut -f1', { timeoutSec: 120 }).catch(() => null);
  const mb = r ? parseInt(r.stdout, 10) / 1024 : NaN;
  return Number.isFinite(mb) ? Math.ceil(mb) + limitMB : limitMB;
}

/** The container's PATH as the image defines it (undefined when it cannot be read). */
async function imagePath(sandbox: Sandbox): Promise<string | undefined> {
  const r = await sandbox.exec('printf %s "$PATH"', { timeoutSec: 30 }).catch(() => null);
  const p = r?.exitCode === 0 ? r.stdout.trim() : '';
  return /^\/[A-Za-z0-9_.\/:-]*$/.test(p) ? p : undefined;
}

function resolveTask(t: string | Task | undefined): Task {
  return typeof t === 'object' && t ? t : getTask(t ?? DEFAULT_TASK_ID);
}

/** Read the config's inline spec files from the task's spec dir. Missing files are skipped (warned for todo only). */
function inlineSpecFiles(config: AgentConfig, specDir: string, task: Task): SpecFile[] {
  const out: SpecFile[] = [];
  for (const name of config.inlineSpecFiles) {
    const f = readSpecFile(specDir, name);
    if (f) out.push(f);
    else if (isTodoTask(task)) log.warn('inline spec file not found; skipping', { name, specDir });
    else log.debug('inline spec file not in this task\'s spec; skipping', { name, task: task.id });
  }
  return out;
}

/**
 * Snapshot the workspace per the task's mode. tree: copy /workspace (no node_modules) to app/.
 * git-diff: workspace.patch against the checkpoint recorded at start.
 */
async function snapshotWorkspace(sandbox: Sandbox, task: Task, checkpoint: string | undefined, paths: { appSnapshotDir: string; workspacePatch: string }, runId: string): Promise<void> {
  if (task.workspace.snapshot === 'git-diff') {
    if (!checkpoint) throw new Error('no checkpoint commit recorded at start');
    const s = await snapshotGitDiff(sandbox as unknown as import('./snapshot.js').SnapshotSandbox, checkpoint, paths.workspacePatch);
    log.info('workspace patch written', { runId, bytes: s.bytes, files: s.files.length });
    return;
  }
  await sandbox.copyOut('/workspace', paths.appSnapshotDir);
}

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
  const task = resolveTask(opts.task);
  const limits = effectiveLimits(taskLimits(config.limits, task), opts.limitsOverride);
  const runId = opts.runId ?? newRunId();
  const startedAt = new Date();
  const runDir = join(opts.resultsDir ?? resultsDir(), 'runs', runId);
  const specDir = opts.specDir ?? (isTodoTask(task) ? SPEC_DIR : task.specPath);
  const paths = {
    appSnapshotDir: join(runDir, 'app'),
    traceFile: join(runDir, 'trace.jsonl'),
    usageFile: join(runDir, 'usage.jsonl'),
    configSnapshotDir: join(runDir, 'config'),
    workspacePatch: join(runDir, 'workspace.patch'),
  };
  mkdirSync(runDir, { recursive: true });

  const backend = selectBackend(config, opts.provider);
  if (backend === 'claude-code') return runClaudeCodeBackend(opts, { runId, runDir, startedAt, limits, specDir, paths, task });
  if (config.backend === 'claude-code') log.warn('claude-code config run with the mock provider: using the api agent loop', { runId });

  const tracker = new TokenTracker({ role: 'coding', runId, experimentId: opts.experimentId, taskId: task.id, usageFile: paths.usageFile, onRecord: opts.onUsageRecord });
  let status: RunStatus = 'infra_error';
  let failureReason: string | undefined;
  let toolCalls = 0;
  let image: ImageInfo = { image: '', imageId: '', starterHash: '' };
  let configHash = '';
  let usedMock = config.provider === 'mock';
  let sandbox: Sandbox | undefined;
  let checkpoint: string | undefined;

  try {
    configHash = hashConfig(config);
    snapshotConfig(config, paths.configSnapshotDir);

    const provider = opts.provider ?? createProvider(config.provider);
    usedMock = provider.isMock;

    if (opts.image) image = opts.image;
    else if (isTodoTask(task)) image = await (await import('./sandbox.js')).ensureImage();
    else {
      const ti = await (await import('./tasks.js')).ensureTaskImage(task, { backend: 'api' });
      image = { image: ti.image, imageId: ti.imageId, starterHash: ti.starterHash };
    }

    const inlineSpec = inlineSpecFiles(config, specDir, task);
    const designImage = config.designDelivery === 'inline-image' ? readSpecFile(specDir, 'design.png') : undefined;
    if (config.designDelivery === 'inline-image' && !designImage && isTodoTask(task)) log.warn('design.png not found in spec dir', { specDir });

    const sbOpts = taskSandboxOptions(task);
    if (opts.sandboxFactory) sandbox = await opts.sandboxFactory({ image, runId, specDir, task, sandbox: sbOpts });
    else {
      const { createSandbox } = await import('./sandbox.js');
      sandbox = await createSandbox({ image: image.image, imageId: image.imageId, runId, role: 'coding', network: 'none', specDir, ...sbOpts });
    }
    if (opts.workspaceOverlay) {
      if (task.workspace.snapshot !== 'git-diff') throw new Error('workspaceOverlay needs a git-diff task');
      await applyWorkspaceOverlay(sandbox, opts.workspaceOverlay);
    }
    if (task.workspace.snapshot === 'git-diff') checkpoint = await recordCheckpoint(sandbox as unknown as import('./snapshot.js').SnapshotSandbox);

    const result = await runAgent({
      config: { ...config, limits },
      provider,
      tracker,
      sandbox,
      inlineSpec,
      designImage,
      traceFile: paths.traceFile,
      signal: opts.signal,
      diskLimitMB: isTodoTask(task) ? opts.diskLimitMB : await diskLimitFor(sandbox, task, opts.diskLimitMB ?? 2048),
      ...(opts.taskPrompt ? { taskPrompt: opts.taskPrompt } : isTodoTask(task) ? {} : { taskPrompt: readTaskPrompt(task) }),
    });
    status = result.status;
    failureReason = result.failureReason;
    toolCalls = result.toolCalls;

    try {
      await snapshotWorkspace(sandbox, task, checkpoint, paths, runId);
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
      ...(task.workspace.snapshot === 'git-diff' ? { workspacePatch: rel(paths.workspacePatch) } : {}),
    },
    usedMockProvider: usedMock,
    effectiveLimits: limits,
    taskId: task.id,
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
  paths: { appSnapshotDir: string; traceFile: string; usageFile: string; configSnapshotDir: string; workspacePatch: string };
  task: Task;
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
  const { runId, runDir, startedAt, limits, specDir, paths, task } = ctx;
  const todo = isTodoTask(task);
  const streamFile = join(runDir, 'claude-stream.jsonl');
  let checkpoint: string | undefined;
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
      taskId: task.id,
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
    } else if (todo) {
      const { ensureClaudeCodeImage } = await import('./claude-code-image.js');
      const cc = await ensureClaudeCodeImage();
      image = { image: cc.image, imageId: cc.imageId, starterHash: cc.starterHash };
      forwarderImage = cc.baseImage;
    } else {
      const { ensureTaskImage } = await import('./tasks.js');
      const ti = await ensureTaskImage(task);
      image = { image: ti.image, imageId: ti.imageId, starterHash: ti.starterHash };
      // The forwarder is trusted infrastructure (a node one-liner as user node): always the todo benchmark image.
      forwarderImage = (await (await import('./sandbox.js')).ensureImage()).image;
    }

    const inlineSpec = inlineSpecFiles(config, specDir, task);
    const { buildClaudeCodePrompt, buildTaskPrompt, runClaudeCodeInSandbox, streamToTrace, countToolUses, streamResultTotals, optTmpfsMounts, readBinAuditLog, hookEventCounts } = await import('./claude-code.js');
    const prompt = opts.taskPrompt ?? (todo ? buildClaudeCodePrompt(config, inlineSpec) : buildTaskPrompt(readTaskPrompt(task), config, inlineSpec));
    const optLayout = todo ? 'single' : 'split';

    const tso = taskSandboxOptions(task);
    // /opt/frugal holds the config's bin scripts and docs (root-owned, read-only to the agent; outside /workspace).
    const sbOpts: Partial<CreateSandboxOptions> = { ...tso, home: '/home/node', extraTmpfs: [CC_HOME_TMPFS, ...optTmpfsMounts(config, optLayout), ...(tso.extraTmpfs ?? [])] };
    if (opts.sandboxFactory) sandbox = await opts.sandboxFactory({ image, runId, specDir, task, sandbox: sbOpts });
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
        ...sbOpts,
      });
    }
    if (opts.workspaceOverlay) {
      if (task.workspace.snapshot !== 'git-diff') throw new Error('workspaceOverlay needs a git-diff task');
      await applyWorkspaceOverlay(sandbox, opts.workspaceOverlay);
    }
    if (task.workspace.snapshot === 'git-diff') checkpoint = await recordCheckpoint(sandbox as unknown as import('./snapshot.js').SnapshotSandbox);
    const gatewayUrl = network?.gatewayUrl ?? gateway.containerUrl;

    // Workspace disk limit (same default as the api loop): checked once a minute.
    const diskLimit = await diskLimitFor(sandbox, task, opts.diskLimitMB ?? 2048);
    // Task images may extend PATH (e.g. /opt/frugal/task); bin scripts are prepended to the image's PATH.
    const basePath = todo || !config.bin?.length ? undefined : await imagePath(sandbox);
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
        optLayout,
        ...(basePath ? { basePath } : {}),
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
      await snapshotWorkspace(sandbox, task, checkpoint, paths, runId);
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
      configAudit = auditCodingRun({
        config,
        ...log0,
        hookCounts: hookEventCounts(r.events),
        ...(task.workspace.snapshot === 'git-diff' ? { patchFile: paths.workspacePatch } : { appDir: paths.appSnapshotDir }),
      });
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
      ...(task.workspace.snapshot === 'git-diff' ? { workspacePatch: rel(paths.workspacePatch) } : {}),
    },
    usedMockProvider: false,
    effectiveLimits: limits,
    taskId: task.id,
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
