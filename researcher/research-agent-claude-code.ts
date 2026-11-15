/**
 * Research agent on the Claude Code CLI (subscription auth, no API key).
 *
 * Each proposal attempt is one host `claude -p` process (runner/claude-code.ts runClaudeHeadless)
 * talking to a per-proposal gateway (runner/gateway.ts, role 'research'):
 *  - fresh EMPTY temp cwd, ALL built-in tools disabled (`--tools ""`), no MCP servers
 *    (`--strict-mcp-config` without a config), no slash commands/skills, no setting sources.
 *    The agent therefore cannot read the repo, the evaluator, the holdout suite or results; the only
 *    tool it has is Claude Code's synthetic StructuredOutput tool for `--json-schema`.
 *  - the full context (best config files, history digest, modification surface) is in the prompt;
 *    the final answer comes back as `structured_output` validated against PROPOSAL_JSON_SCHEMA and
 *    then by the same strict whitelist validation as the API path, with ONE retry on invalid output.
 *  - research tokens are the gateway's UsageRecords (role 'research'), appended to `usageFile` by
 *    the gateway and returned to the loop, which stores them exactly like the API path's records.
 *  - a subscription usage limit surfaces as ResearchProposalError.usageLimitResetAt so the loop can
 *    wait and retry instead of counting a proposal failure.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Effort, UsageRecord } from '../runner/types.js';
import { logger } from '../runner/logger.js';
import { resultsDir } from '../runner/env.js';
import { PLACEHOLDER_OAUTH_TOKEN, type GatewayHandle, type StartGatewayOptions } from '../runner/gateway.js';
import { CLAUDE_BASE_ENV, CONTAINER_CONFIG_DIR, CONTAINER_HOME, StreamJsonCollector, type HeadlessResult } from '../runner/claude-code.js';
import type { CreateSandboxOptions } from '../runner/sandbox.js';
import {
  buildAgenticSystemPrompt,
  buildAgenticTaskPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  checkSingleVariable,
  DEFAULT_RESEARCH_MODEL,
  extractJson,
  ResearchProposalError,
  type ResearchAgent,
} from './research-agent.js';
import { buildResearchWorkspace, type BuildWorkspaceOptions, type ResearchWorkspace, type WorkspaceLimits } from './research-workspace.js';
import { validateProposal, withParentBackend, type Proposal, type WhitelistOptions } from './whitelist.js';

const log = logger('research-agent-cc');

/** Loose schema for --json-schema; the strict checks are validateProposal's (single source of truth). */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hypothesis: { type: 'string', description: 'Why this change should reduce median coding tokens while keeping every check passing.' },
    changeSummary: { type: 'string', description: 'One or two sentences: exactly what changed.' },
    files: {
      type: 'object',
      description:
        'Only the files you change. Keys: "system-prompt.md", "CLAUDE.md", "tools.json", "skills/<name>.md" (string = full content, null = delete) and "config.json" (a PARTIAL object of approved fields).',
      additionalProperties: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'null' }] },
    },
  },
  required: ['hypothesis', 'changeSummary', 'files'],
  additionalProperties: false,
} as const;

export type RunHeadlessFn = (opts: {
  cwd: string;
  prompt: string;
  gateway: GatewayHandle;
  args: string[];
  env?: Record<string, string>;
  timeoutSec: number;
  streamFile: string;
  signal?: AbortSignal;
}) => Promise<HeadlessResult>;

export interface ClaudeCodeResearchDeps {
  startGateway: (opts: StartGatewayOptions) => Promise<GatewayHandle>;
  runClaudeHeadless: RunHeadlessFn;
  hasSubscriptionToken: () => boolean;
}

export interface CreateClaudeCodeResearchAgentOptions {
  model?: string;
  effort?: Effort;
  /** Research UsageRecords are appended here by the gateway (in addition to the DB via the loop). */
  usageFile?: string;
  /** Per-attempt wall-clock limit for the claude process (default 900 s). */
  timeoutSec?: number;
  /** Passed as CLAUDE_CODE_MAX_OUTPUT_TOKENS (default 16000). */
  maxOutputTokens?: number;
  /** stream-json transcripts per attempt (default results/research/streams). */
  streamDir?: string;
  /** TESTS: inject fakes (labelled mock) instead of the real gateway / CLI. */
  deps?: Partial<ClaudeCodeResearchDeps>;
}

/**
 * The exact claude flags of a research attempt (exported so tests can assert that no built-in tool,
 * MCP server or skill is available). runClaudeHeadless adds -p, stream-json, --no-session-persistence,
 * --strict-mcp-config and --setting-sources "".
 */
export function buildResearchClaudeArgs(o: { model: string; effort?: Effort; systemPrompt: string }): string[] {
  const args = [
    '--model', o.model,
    '--system-prompt', o.systemPrompt,
    '--tools', '',
    '--disable-slash-commands',
    '--permission-mode', 'dontAsk',
    '--json-schema', JSON.stringify(PROPOSAL_JSON_SCHEMA),
  ];
  if (o.effort) args.push('--effort', o.effort);
  return args;
}

async function loadDeps(over?: Partial<ClaudeCodeResearchDeps>): Promise<ClaudeCodeResearchDeps> {
  if (over?.startGateway && over.runClaudeHeadless && over.hasSubscriptionToken) return over as ClaudeCodeResearchDeps;
  const [gw, cc] = await Promise.all([import('../runner/gateway.js'), import('../runner/claude-code.js')]);
  return {
    startGateway: gw.startGateway,
    runClaudeHeadless: cc.runClaudeHeadless,
    hasSubscriptionToken: gw.hasSubscriptionToken,
    ...over,
  };
}

/** Claude Code's own wording when the subscription is exhausted (fallback if the gateway saw no reset time). */
export const USAGE_LIMIT_TEXT = /usage limit|limit reached|out of (extra )?usage/i;

/** Final answer of a headless run: structured_output, else JSON found in the result text. */
export function proposalPayload(res: HeadlessResult): { raw: unknown; text: string } {
  const r = res.result;
  const text = typeof r?.result === 'string' ? r.result : '';
  if (r && r.structured_output !== undefined && r.structured_output !== null) return { raw: r.structured_output, text: text || JSON.stringify(r.structured_output) };
  return { raw: extractJson(text), text };
}

export function createClaudeCodeResearchAgent(opts: CreateClaudeCodeResearchAgentOptions = {}): ResearchAgent {
  const model = opts.model ?? process.env.RESEARCH_MODEL ?? DEFAULT_RESEARCH_MODEL;
  const timeoutSec = opts.timeoutSec ?? 900;
  return {
    async propose(input, signal) {
      const deps = await loadDeps(opts.deps);
      if (!deps.hasSubscriptionToken()) {
        const { SETUP_TOKEN_HELP } = await import('../runner/gateway.js');
        throw new ResearchProposalError(`research agent unavailable: ${SETUP_TOKEN_HELP}`, []);
      }
      input = { ...input, whitelist: withParentBackend(input.whitelist, input.bestConfigFiles) };
      const records: UsageRecord[] = [];
      const gateway = await deps.startGateway({
        role: 'research',
        experimentId: input.experimentId,
        usageFile: opts.usageFile,
        mainModel: model,
        onUsageRecord: (r) => records.push(r),
      });
      const cwd = mkdtempSync(join(tmpdir(), 'frugal-research-'));
      const streamDir = opts.streamDir ?? join(resultsDir(), 'research', 'streams');
      mkdirSync(streamDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const usage = () => (records.length ? [...records] : gateway.tracker.records());
      const args = buildResearchClaudeArgs({ model, effort: opts.effort, systemPrompt: buildSystemPrompt(input.whitelist) });
      const env = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(opts.maxOutputTokens ?? 16_000) };
      const single = input.experimentIndex <= input.singleVariableExperiments;
      const basePrompt = buildUserPrompt(input);
      let prompt = basePrompt;
      let lastErrors: string[] = [];
      try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (signal?.aborted) throw new ResearchProposalError('aborted', usage());
          const streamFile = join(streamDir, `${input.experimentId ?? 'proposal'}-${stamp}-a${attempt}.jsonl`);
          let res: HeadlessResult;
          try {
            res = await deps.runClaudeHeadless({ cwd, prompt, gateway, args, env, timeoutSec, streamFile, signal });
          } catch (e) {
            throw new ResearchProposalError(`research claude process failed: ${(e as Error)?.message ?? String(e)}`, usage());
          }
          const resetAt = gateway.usageLimitResetAt();
          const resultText = typeof res.result?.result === 'string' ? res.result.result : '';
          if (resetAt !== null || (res.result?.is_error && USAGE_LIMIT_TEXT.test(resultText))) {
            throw new ResearchProposalError(`subscription usage limit reached${resetAt ? ` (resets ${resetAt})` : ''}`, usage(), [], resetAt ?? '');
          }
          if (signal?.aborted) throw new ResearchProposalError('aborted', usage());
          if (res.timedOut) throw new ResearchProposalError(`research claude process timed out after ${timeoutSec}s`, usage());
          if (!res.result || res.result.is_error || res.result.subtype !== 'success') {
            const why = res.result ? `${res.result.subtype ?? 'error'}: ${resultText.slice(0, 300)}` : `no result event (exit ${res.exitCode})`;
            throw new ResearchProposalError(`research claude process failed: ${why}`, usage());
          }
          let errors: string[];
          let text = resultText;
          try {
            const payload = proposalPayload(res);
            text = payload.text;
            const v = validateProposal(payload.raw, input.whitelist);
            if (v.ok) {
              errors = single ? checkSingleVariable(v.proposal) : [];
              if (!errors.length) return { proposal: v.proposal, usage: usage(), attempts: attempt };
            } else errors = v.errors;
          } catch (e) {
            errors = [`invalid JSON: ${(e as Error).message}`];
          }
          lastErrors = errors;
          log.warn('invalid research proposal', { attempt, errors });
          // No session persistence: the retry is a new conversation that carries the rejected answer.
          prompt = [
            basePrompt,
            '',
            'YOUR PREVIOUS PROPOSAL WAS REJECTED:',
            (text || '(empty)').slice(0, 70_000),
            '',
            `Rejection reasons:\n- ${errors.join('\n- ')}`,
            'Return a corrected proposal.',
          ].join('\n');
        }
        throw new ResearchProposalError(`research agent returned an invalid proposal twice: ${lastErrors.join('; ')}`, usage(), lastErrors);
      } finally {
        await gateway.stop().catch(() => undefined);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

// ===========================================================================
// AGENTIC mode: the research agent studies past coding sessions inside a sandbox
// ===========================================================================
//
//   host: buildResearchWorkspace() ──► temp dir (README, digest, best-config, experiments, runs, spec)
//   host gateway (role 'research', per-proposal token cap) ◄── forwarder ◄── internal docker network
//   research container (frugal-bench-cc image, non-root, read-only root fs, cap-drop ALL, limits):
//     /research          root-owned tmpfs, the workspace copied in (read-only for user node)
//     /research/scratch  the agent's only writable dir (tmpfs, uid 1000)
//     /workspace         the starter (disposable; for smoke-testing helper scripts)
//     claude -p  --tools Read,Grep,Glob,Bash,Write  (Write only under /research/scratch), --json-schema
//
// No host mount, no docker socket, placeholder token only; the real token stays in the host gateway.
// Guard / validation feedback goes back ONCE, in the same container and Claude session (--resume).

export const RESEARCH_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write'] as const;
export const RESEARCH_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write(//research/scratch/**)', 'Edit(//research/scratch/**)'] as const;
/** Explicitly denied even though --tools already excludes most of them (defense in depth). */
export const RESEARCH_DISALLOWED_TOOLS = [
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Bash(claude:*)',
  'Bash(*claude -p*)',
  'Bash(npx claude:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
] as const;

export const RESEARCH_WORKDIR = '/research';
export const RESEARCH_SCRATCH = '/research/scratch';
const RESEARCH_HOME_TMPFS = '/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0755';
/** Root-owned: user node can read but not modify the copied workspace. */
const RESEARCH_TMPFS = `${RESEARCH_WORKDIR}:rw,nosuid,nodev,size=256m,mode=0755`;
const RESEARCH_SCRATCH_TMPFS = `${RESEARCH_SCRATCH}:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755`;
/** Brownfield dev tasks: read-only (root-owned) copy of the checkpoint source. */
export const RESEARCH_CODEBASE = '/research/codebase';
const RESEARCH_CODEBASE_TMPFS = `${RESEARCH_CODEBASE}:rw,nosuid,nodev,noexec,size=768m,mode=0755`;
/** Not copied into /research/codebase (VCS, dependencies, generated output). */
export const CODEBASE_EXCLUDES = ['./.git', './node_modules', './vendor', './tmp', './log', './public/packs', './public/packs-test', './public/system', './coverage'] as const;

/** --json-schema of the agentic proposal (extended surface + evidence + expectedSavings). */
export const AGENTIC_PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hypothesis: { type: 'string', description: 'Why this change should reduce median coding tokens while keeping every check passing.' },
    changeSummary: { type: 'string', description: 'One or two sentences: exactly what changed.' },
    evidence: {
      type: 'string',
      description: 'The specific runs, turns/calls and tool calls (with token numbers) that motivated the change, e.g. "run-X call 7: Bash npm run build returned 38k chars".',
    },
    expectedSavings: { type: 'string', description: 'Estimated token savings per run with the reasoning/arithmetic and the main risk.' },
    files: {
      type: 'object',
      description:
        'Only the files you change. Keys: "system-prompt.md", "CLAUDE.md", "skills/<name>.md", "bin/<name>" (helper script on the coding agent PATH), "agents/<name>.md" (subagent), "commands/<name>.md" (slash command), "docs/<path>" (reference file at /opt/frugal/docs, not auto-loaded) — string = full content, null = delete — and "config.json" (a PARTIAL object of approved fields; hooks go in claudeCode.settings.hooks).',
      additionalProperties: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'null' }] },
    },
  },
  required: ['hypothesis', 'changeSummary', 'evidence', 'expectedSavings', 'files'],
  additionalProperties: false,
} as const;

/** Validate and strip the research-only fields; the rest goes through validateProposal unchanged. */
export function splitAgenticProposal(raw: unknown): { core: unknown; evidence: string; expectedSavings: string; errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { core: raw, evidence: '', expectedSavings: '', errors: [] };
  const { evidence, expectedSavings, ...core } = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof evidence !== 'string' || evidence.trim().length < 20 || evidence.length > 6000)
    errors.push('"evidence" must be a string (20-6000 chars) citing specific runs, turns or tool calls');
  if (typeof expectedSavings !== 'string' || expectedSavings.trim().length < 10 || expectedSavings.length > 2000)
    errors.push('"expectedSavings" must be a string (10-2000 chars) with an estimate and its reasoning');
  return {
    core,
    evidence: typeof evidence === 'string' ? evidence.trim() : '',
    expectedSavings: typeof expectedSavings === 'string' ? expectedSavings.trim() : '',
    errors,
  };
}

/** claude flags of an agentic research attempt (exported for tests). */
export function buildAgenticClaudeArgs(o: { model: string; effort?: Effort; systemPrompt: string; resumeSessionId?: string }): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--model', o.model,
    '--system-prompt', o.systemPrompt,
    '--tools', RESEARCH_TOOLS.join(','),
    '--allowedTools', RESEARCH_ALLOWED_TOOLS.join(','),
    '--disallowedTools', RESEARCH_DISALLOWED_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--json-schema', JSON.stringify(AGENTIC_PROPOSAL_JSON_SCHEMA),
  ];
  if (o.effort) args.push('--effort', o.effort);
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  return args;
}

/** Env of the in-container research claude process: gateway URL + placeholder token only. */
export function buildAgenticEnv(gatewayUrl: string, maxOutputTokens: number): Record<string, string> {
  return {
    ...CLAUDE_BASE_ENV,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    BASH_MAX_OUTPUT_LENGTH: '30000',
    HOME: CONTAINER_HOME,
    CLAUDE_CONFIG_DIR: CONTAINER_CONFIG_DIR,
    ANTHROPIC_BASE_URL: gatewayUrl,
    CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_OAUTH_TOKEN,
  };
}

/** `docker run` options of the research container (exported so tests can assert there is no host mount). */
export function researchSandboxOptions(o: { image: string; imageId?: string; label: string; network: string; codebase?: boolean }): CreateSandboxOptions {
  return {
    image: o.image,
    imageId: o.imageId,
    runId: o.label,
    role: 'coding',
    network: o.network,
    cpus: 2,
    memory: o.codebase ? '3g' : '2g',
    pidsLimit: 256,
    tmpSizeMb: 512,
    home: CONTAINER_HOME,
    extraTmpfs: [RESEARCH_HOME_TMPFS, RESEARCH_TMPFS, RESEARCH_SCRATCH_TMPFS, ...(o.codebase ? [RESEARCH_CODEBASE_TMPFS] : [])],
    labels: { 'frugal.component': 'research' },
  };
}

/** `docker exec` argv of one in-container claude invocation (exported for tests). */
export function buildResearchExecArgs(containerId: string, env: Record<string, string>, claudeArgs: string[], timeoutSec: number): string[] {
  const t = Math.max(10, Math.round(timeoutSec));
  const a = ['exec', '-i', '-u', 'node', '-w', RESEARCH_WORKDIR];
  for (const [k, v] of Object.entries(env)) a.push('-e', `${k}=${v}`);
  a.push(containerId, 'sh', '-c', 'echo $$ > /tmp/.claude.pid; exec timeout -k 10 "$0" claude "$@"', `${t}s`, ...claudeArgs);
  return a;
}

export interface ResearchSandboxRun extends HeadlessResult {
  stoppedBy?: 'gateway_limit' | 'usage_limit';
  stderr?: string;
}

/** One research container: copy-in done, claude invocations and probes run inside it. */
export interface ResearchSandboxSession {
  readonly containerId: string;
  run(o: { args: string[]; prompt: string; env: Record<string, string>; timeoutSec: number; streamFile: string; signal?: AbortSignal }): Promise<ResearchSandboxRun>;
  /** Run a shell command as user node in /research (isolation probes, tests). */
  exec(command: string, timeoutSec?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroy(): Promise<void>;
}

export interface OpenResearchSandboxOptions {
  workspaceDir: string;
  gateway: GatewayHandle;
  label: string;
  /** Dev task (default todo). Brownfield: the task image (its /workspace is the checkpoint) + /research/codebase. */
  taskId?: string;
}

/** REAL research sandbox: cc image, per-proposal internal network + forwarder to the host gateway. */
export async function openResearchSandbox(o: OpenResearchSandboxOptions): Promise<ResearchSandboxSession & { gatewayUrl: string }> {
  const [{ ensureClaudeCodeImage }, { createGatewayNetwork }, sbx] = await Promise.all([
    import('../runner/claude-code-image.js'),
    import('../runner/gateway-network.js'),
    import('../runner/sandbox.js'),
  ]);
  const brownfield = !!o.taskId && o.taskId !== 'todo';
  let cc: { image: string; imageId: string; baseImage: string };
  if (brownfield) {
    const tasks = await import('../runner/tasks.js');
    const ti = await tasks.ensureTaskImage(tasks.getTask(o.taskId!));
    // The forwarder (trusted, `node -e` as user node) always uses the todo benchmark image.
    cc = { image: ti.image, imageId: ti.imageId, baseImage: (await sbx.ensureImage()).image };
  } else cc = await ensureClaudeCodeImage();
  const network = await createGatewayNetwork({ runId: o.label, gatewayPort: o.gateway.port, image: cc.baseImage });
  let sandbox: import('../runner/sandbox.js').DockerSandbox | undefined;
  try {
    sandbox = await sbx.createSandbox(researchSandboxOptions({ image: cc.image, imageId: cc.imageId, label: o.label, network: network.network, codebase: brownfield }));
    // Root-owned copy: readable, not writable, for user node.
    await sandbox.copyIn(o.workspaceDir, RESEARCH_WORKDIR, { user: 'root', exclude: ['.DS_Store'] });
    // Brownfield: read-only copy of the checkpoint source (from the image's /workspace, read as node, written as root).
    if (brownfield) await sandbox.copyWithin('/workspace', RESEARCH_CODEBASE, { fromUser: 'node', toUser: 'root', exclude: [...CODEBASE_EXCLUDES] });
  } catch (e) {
    await sandbox?.destroy().catch(() => undefined);
    await network.destroy();
    throw e;
  }
  const sb = sandbox;
  return {
    containerId: sb.containerId,
    gatewayUrl: network.gatewayUrl,
    run: (r) => runInResearchContainer({ ...r, containerId: sb.containerId, gateway: o.gateway }),
    async exec(command, timeoutSec = 60) {
      const res = await sb.exec(command, { cwd: RESEARCH_WORKDIR, user: 'node', timeoutSec });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    },
    async destroy() {
      await sb.destroy().catch(() => undefined);
      await network.destroy();
    },
  };
}

async function runInResearchContainer(o: {
  containerId: string;
  gateway: GatewayHandle;
  args: string[];
  prompt: string;
  env: Record<string, string>;
  timeoutSec: number;
  streamFile: string;
  signal?: AbortSignal;
}): Promise<ResearchSandboxRun> {
  const { spawn } = await import('node:child_process');
  const { createWriteStream } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(o.streamFile), { recursive: true });
  const out = createWriteStream(o.streamFile, { flags: 'a' });
  const collector = new StreamJsonCollector();
  const dockerArgs = buildResearchExecArgs(o.containerId, o.env, o.args, o.timeoutSec);
  let stoppedBy: ResearchSandboxRun['stoppedBy'];
  let timedOut = false;
  let stderr = '';
  const start = Date.now();
  const kill = (sig: 'TERM' | 'KILL') =>
    new Promise<void>((resolve) => {
      const k = spawn('docker', ['exec', '-u', 'node', o.containerId, 'sh', '-c', `p=$(cat /tmp/.claude.pid 2>/dev/null) && kill -${sig} -- -$p 2>/dev/null; true`], { stdio: 'ignore' });
      k.on('close', () => resolve());
      k.on('error', () => resolve());
      setTimeout(resolve, 15_000).unref();
    });
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stopping = false;
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      log.info('stopping in-container research claude', { why });
      void kill('TERM').then(() =>
        setTimeout(() => {
          void kill('KILL');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, 5000).unref(),
      );
    };
    const poll = setInterval(() => {
      if (!stoppedBy && o.gateway.usageLimitResetAt()) {
        stoppedBy = 'usage_limit';
        stop('subscription usage limit');
      } else if (!stoppedBy && o.gateway.limitExceeded?.()) {
        stoppedBy = 'gateway_limit';
        stop('research token budget');
      }
      if (Date.now() - start > (o.timeoutSec + 30) * 1000) {
        timedOut = true;
        stop('host backstop timeout');
      }
    }, 1000);
    const onAbort = () => stop('abort signal');
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      out.write(c);
      collector.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 50_000) stderr += c.toString('utf8');
    });
    child.on('error', (e) => (stderr += String(e)));
    child.on('close', (code) => {
      clearInterval(poll);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(code);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.prompt);
  });
  collector.end();
  await new Promise<void>((r) => out.end(() => r()));
  if (exitCode === 124 || (exitCode === 137 && Date.now() - start >= o.timeoutSec * 1000 - 500)) timedOut = true;
  return { exitCode, timedOut, result: collector.result(), events: collector.events, stoppedBy, stderr };
}

/** Guard hook: returns violation strings (empty = ok). */
export type ProposalGuardFn = (
  proposal: Proposal,
  ctx: { parentConfigId: string; parentFiles: Record<string, string>; configsRoot: string; whitelist: WhitelistOptions },
) => string[] | Promise<string[]>;

/**
 * Default guard: apply the proposal to a COPY of the parent config in a temp configs root, i.e. the
 * exact path the loop takes (whitelist, optimizer, runner config validation incl. the anti-cheating
 * config guard). Nothing is written to the real configs/ tree.
 */
export const dryApplyGuard: ProposalGuardFn = async (proposal, ctx) => {
  const { cpSync, mkdtempSync: mk } = await import('node:fs');
  const { applyProposal, configDir, OptimizerError } = await import('./optimizer.js');
  const tmpRoot = mk(join(tmpdir(), 'frugal-guard-'));
  try {
    cpSync(configDir(ctx.parentConfigId, ctx.configsRoot), join(tmpRoot, ctx.parentConfigId), { recursive: true });
    applyProposal({ parentConfigId: ctx.parentConfigId, proposal, whitelist: ctx.whitelist, configsRoot: tmpRoot });
    return [];
  } catch (e) {
    if (e instanceof OptimizerError) return e.errors.length ? e.errors : [e.message];
    return [`dry apply failed: ${(e as Error)?.message ?? String(e)}`];
  } finally {
    const { chmodSync, readdirSync, statSync } = await import('node:fs');
    const fix = (p: string) => {
      try {
        const st = statSync(p);
        chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
        if (st.isDirectory()) for (const n of readdirSync(p)) fix(join(p, n));
      } catch {
        /* ignore */
      }
    };
    fix(tmpRoot);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

export interface AgenticResearchDeps {
  startGateway: (opts: StartGatewayOptions) => Promise<GatewayHandle>;
  hasSubscriptionToken: () => boolean;
  openSandbox: (o: OpenResearchSandboxOptions) => Promise<ResearchSandboxSession & { gatewayUrl: string }>;
  buildWorkspace: (o: BuildWorkspaceOptions) => Promise<ResearchWorkspace>;
  /** Anti-cheating guard + config validation (default dryApplyGuard); null = none. */
  guard: ProposalGuardFn | null;
}

export interface CreateAgenticResearchAgentOptions {
  model?: string;
  effort?: Effort;
  usageFile?: string;
  /** Wall clock for the whole proposal incl. the feedback attempt (default 900 s). */
  maxRuntimeSec?: number;
  /** Research tokens per proposal, enforced by the gateway (default 1.5M). */
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  streamDir?: string;
  workspaceLimits?: Partial<WorkspaceLimits>;
  /** Called once the container is ready, before claude runs (isolation probes in --propose-only). */
  onSandboxReady?: (s: ResearchSandboxSession, ws: ResearchWorkspace) => Promise<void>;
  /** Keep the host workspace dir after the proposal (default: removed). */
  keepWorkspace?: boolean;
  /** TESTS: inject fakes (labelled mock). */
  deps?: Partial<AgenticResearchDeps>;
}

async function loadAgenticDeps(over: Partial<AgenticResearchDeps> = {}): Promise<AgenticResearchDeps> {
  const need = (k: keyof AgenticResearchDeps) => !(k in over);
  const gw = need('startGateway') || need('hasSubscriptionToken') ? await import('../runner/gateway.js') : null;
  return {
    startGateway: over.startGateway ?? gw!.startGateway,
    hasSubscriptionToken: over.hasSubscriptionToken ?? gw!.hasSubscriptionToken,
    openSandbox: over.openSandbox ?? openResearchSandbox,
    buildWorkspace: over.buildWorkspace ?? buildResearchWorkspace,
    guard: 'guard' in over ? (over.guard ?? null) : dryApplyGuard,
  };
}

function feedbackPrompt(errors: string[], resumed: boolean, previous: string): string {
  return [
    resumed ? 'Your proposal was REJECTED by the automatic checks:' : 'A previous attempt at this task returned a proposal that was REJECTED by the automatic checks.',
    ...errors.map((e) => `- ${e}`),
    ...(resumed ? [] : ['', 'Rejected proposal:', previous.slice(0, 60_000)]),
    '',
    'Fix exactly these problems (keep the same hypothesis if it is still sound) and return the corrected proposal with the structured output tool. Do not start the analysis over.',
  ].join('\n');
}

/**
 * The agentic research agent (researchMode "agentic"). Needs input.context (db + paths) to build the
 * workspace; usage is the research gateway's records, exactly like the simple mode.
 */
export function createAgenticResearchAgent(opts: CreateAgenticResearchAgentOptions = {}): ResearchAgent {
  const model = opts.model ?? process.env.RESEARCH_MODEL ?? DEFAULT_RESEARCH_MODEL;
  const maxRuntimeSec = opts.maxRuntimeSec ?? 900;
  const maxTotalTokens = opts.maxTotalTokens ?? 1_500_000;
  return {
    async propose(input, signal) {
      const deps = await loadAgenticDeps(opts.deps);
      if (!deps.hasSubscriptionToken()) {
        const { SETUP_TOKEN_HELP } = await import('../runner/gateway.js');
        throw new ResearchProposalError(`research agent unavailable: ${SETUP_TOKEN_HELP}`, []);
      }
      const ctx = input.context;
      if (!ctx) throw new ResearchProposalError('agentic research agent needs input.context (db, resultsDir, configsRoot)', []);
      input = { ...input, whitelist: withParentBackend(input.whitelist, input.bestConfigFiles) };
      const single = input.experimentIndex <= input.singleVariableExperiments;
      const deadline = Date.now() + maxRuntimeSec * 1000;

      const ws = await deps.buildWorkspace({
        db: ctx.db,
        resultsDir: ctx.resultsDir,
        configsRoot: ctx.configsRoot,
        specDir: ctx.specDir,
        verificationRuns: ctx.verificationRuns,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        ...(ctx.hiddenTaskIds?.length ? { hiddenTaskIds: ctx.hiddenTaskIds } : {}),
        bestConfigId: input.bestConfigId,
        bestConfigFiles: input.bestConfigFiles,
        history: input.history,
        whitelist: input.whitelist,
        experimentIndex: input.experimentIndex,
        singleVariableExperiments: input.singleVariableExperiments,
        agentLimits: { maxRuntimeSec, maxTotalTokens },
        limits: opts.workspaceLimits,
      });
      const wsInfo = { experiments: ws.experiments, runs: ws.runs, notes: ws.notes, bytes: ws.bytes };
      log.info('research workspace built', { experiments: ws.experiments.length, runs: ws.runs.length, bytes: ws.bytes });

      const records: UsageRecord[] = [];
      let gateway: GatewayHandle | undefined;
      let session: (ResearchSandboxSession & { gatewayUrl: string }) | undefined;
      const usage = () => (records.length ? [...records] : (gateway?.tracker.records() ?? []));
      try {
        gateway = await deps.startGateway({
          role: 'research',
          experimentId: input.experimentId,
          usageFile: opts.usageFile,
          mainModel: model,
          limits: { maxTotalTokens },
          onUsageRecord: (r) => records.push(r),
        });
        const label = `research-${input.experimentId ?? 'proposal'}-${Date.now().toString(36)}`;
        try {
          session = await deps.openSandbox({ workspaceDir: ws.dir, gateway, label, ...(ctx.taskId && ctx.taskId !== 'todo' ? { taskId: ctx.taskId } : {}) });
        } catch (e) {
          throw new ResearchProposalError(`research sandbox failed to start: ${(e as Error)?.message ?? String(e)}`, usage());
        }
        if (opts.onSandboxReady) await opts.onSandboxReady(session, ws);

        const streamDir = opts.streamDir ?? join(resultsDir(), 'research', 'streams');
        mkdirSync(streamDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const systemPrompt = buildAgenticSystemPrompt({ single, maxRuntimeSec, maxTotalTokens });
        const env = buildAgenticEnv(session.gatewayUrl, opts.maxOutputTokens ?? 32_000);
        let prompt = buildAgenticTaskPrompt({ experimentIndex: input.experimentIndex, bestConfigId: input.bestConfigId });
        let resumeSessionId: string | undefined;
        let lastErrors: string[] = [];

        for (let attempt = 1; attempt <= 2; attempt++) {
          if (signal?.aborted) throw new ResearchProposalError('aborted', usage());
          const remaining = Math.floor((deadline - Date.now()) / 1000);
          if (remaining < 30) throw new ResearchProposalError(`research time budget (${maxRuntimeSec}s) exhausted${lastErrors.length ? `; last rejection: ${lastErrors.join('; ')}` : ''}`, usage(), lastErrors);
          const args = buildAgenticClaudeArgs({ model, effort: opts.effort, systemPrompt, resumeSessionId });
          const streamFile = join(streamDir, `${input.experimentId ?? 'proposal'}-${stamp}-agentic.jsonl`);
          let res: ResearchSandboxRun;
          try {
            res = await session.run({ args, prompt, env, timeoutSec: remaining, streamFile, signal });
          } catch (e) {
            throw new ResearchProposalError(`research claude process failed: ${(e as Error)?.message ?? String(e)}`, usage());
          }
          const resetAt = gateway.usageLimitResetAt();
          const resultText = typeof res.result?.result === 'string' ? res.result.result : '';
          if (resetAt !== null || res.stoppedBy === 'usage_limit' || (res.result?.is_error && USAGE_LIMIT_TEXT.test(resultText)))
            throw new ResearchProposalError(`subscription usage limit reached${resetAt ? ` (resets ${resetAt})` : ''}`, usage(), [], resetAt ?? '');
          if (signal?.aborted) throw new ResearchProposalError('aborted', usage());
          if (res.stoppedBy === 'gateway_limit') throw new ResearchProposalError(`research token budget (${maxTotalTokens.toLocaleString('en-US')}) exhausted before a proposal was returned`, usage());
          if (res.timedOut) throw new ResearchProposalError(`research agent timed out after ${maxRuntimeSec}s`, usage());
          if (!res.result || res.result.is_error || res.result.subtype !== 'success') {
            const why = res.result ? `${res.result.subtype ?? 'error'}: ${resultText.slice(0, 300)}` : `no result event (exit ${res.exitCode}) ${(res.stderr ?? '').slice(-300)}`;
            throw new ResearchProposalError(`research claude process failed: ${why}`, usage());
          }
          const sid = typeof res.result.session_id === 'string' ? res.result.session_id : undefined;

          let errors: string[] = [];
          let text = resultText;
          try {
            const payload = proposalPayload(res);
            text = payload.text;
            const split = splitAgenticProposal(payload.raw);
            const v = validateProposal(split.core, input.whitelist);
            errors = [...split.errors, ...(v.ok ? [] : v.errors)];
            if (v.ok && !errors.length) {
              if (single) errors.push(...checkSingleVariable(v.proposal));
              if (!errors.length && deps.guard) errors.push(
                  ...(await deps.guard(v.proposal, { parentConfigId: input.bestConfigId, parentFiles: input.bestConfigFiles, configsRoot: ctx.configsRoot, whitelist: input.whitelist })).map((x) => `guard: ${x}`),
                );
              if (!errors.length) {
                return {
                  proposal: v.proposal,
                  usage: usage(),
                  attempts: attempt,
                  research: { evidence: split.evidence, expectedSavings: split.expectedSavings },
                  workspace: wsInfo,
                };
              }
            }
          } catch (e) {
            errors = [`invalid JSON: ${(e as Error).message}`];
          }
          lastErrors = errors;
          log.warn('research proposal rejected; giving the violations back once', { attempt, errors });
          resumeSessionId = sid;
          prompt = feedbackPrompt(errors, Boolean(sid), text || '(empty)');
          if (!sid) prompt = `${buildAgenticTaskPrompt({ experimentIndex: input.experimentIndex, bestConfigId: input.bestConfigId })}\n\n${prompt}`;
        }
        throw new ResearchProposalError(`research agent returned an invalid proposal twice: ${lastErrors.join('; ')}`, usage(), lastErrors);
      } catch (e) {
        if (e instanceof ResearchProposalError) {
          (e as ResearchProposalError & { workspace?: unknown }).workspace = wsInfo;
          throw e;
        }
        throw new ResearchProposalError(`agentic research failed: ${(e as Error)?.message ?? String(e)}`, usage());
      } finally {
        await session?.destroy().catch(() => undefined);
        await gateway?.stop().catch(() => undefined);
        if (!opts.keepWorkspace) ws.cleanup();
      }
    },
  };
}
