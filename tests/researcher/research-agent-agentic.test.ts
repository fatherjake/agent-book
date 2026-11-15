/**
 * Agentic research agent tests with a FAKE sandbox, FAKE gateway and FAKE guard (MOCKS: no docker,
 * no claude process, no model). Covers the container argv / flags (tool restrictions, no host
 * mounts), the extended proposal schema, the guard-feedback retry and the loop integration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenTracker } from '../../runner/token-tracker.js';
import { PLACEHOLDER_OAUTH_TOKEN, type GatewayHandle, type StartGatewayOptions } from '../../runner/gateway.js';
import {
  AGENTIC_PROPOSAL_JSON_SCHEMA,
  buildAgenticClaudeArgs,
  buildAgenticEnv,
  buildResearchExecArgs,
  createAgenticResearchAgent,
  researchSandboxOptions,
  RESEARCH_TOOLS,
  splitAgenticProposal,
  type AgenticResearchDeps,
  type ResearchSandboxRun,
  type ResearchSandboxSession,
} from '../../researcher/research-agent-claude-code.js';
import { ResearchProposalError, type ResearchAgent, type ResearchAgentInput } from '../../researcher/research-agent.js';
import { buildResearchWorkspace, type ResearchWorkspace } from '../../researcher/research-workspace.js';
import { splitResearchText } from '../../researcher/history.js';
import { validateProposal } from '../../researcher/whitelist.js';
import { runResearchLoop } from '../../researcher/loop.js';
import { DEFAULT_RESEARCH_SETTINGS } from '../../researcher/settings.js';
import { openDb, type Db } from '../../storage/db.js';
import { makeConfigsRoot, makeFakeBench, makeFakeClock, makeTmp, rmTmp } from './helpers.js';

process.env.FRUGAL_QUIET = '1';

const ccConfig = JSON.stringify({ id: 'baseline', backend: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', claudeCode: { systemPromptMode: 'append' } });

const good = {
  hypothesis: 'Restricting the built-in tool set removes ~4k tokens of tool definitions from every call',
  changeSummary: 'claudeCode.tools limited to Bash, Read, Write, Edit',
  evidence: 'run-a calls 1-4: cacheRead 10.7k→26k; system init lists 18 tools of which only Bash/Read/Write were used',
  expectedSavings: '~4k tokens x 4 calls = 16k per run (~13%); risk: agent needs Glob (low)',
  files: { 'config.json': { claudeCode: { systemPromptMode: 'append', tools: ['Bash', 'Read', 'Write', 'Edit'] } } },
};

function fakeGateway() {
  const started: StartGatewayOptions[] = [];
  let stopped = 0;
  const start = async (o: StartGatewayOptions): Promise<GatewayHandle> => {
    started.push(o);
    const tracker = new TokenTracker({ role: o.role, experimentId: o.experimentId });
    return {
      port: 0,
      hostUrl: 'http://127.0.0.1:1',
      containerUrl: '',
      tracker,
      usageLimitResetAt: () => null,
      limitExceeded: () => null,
      stats: () => ({ requests: 0, messagesCalls: 0, upstreamErrors: 0, blocked: 0, lastStatus: null }),
      stop: async () => void stopped++,
    };
  };
  return { start, started, stopped: () => stopped };
}

type RunOpts = Parameters<ResearchSandboxSession['run']>[0];

/** MOCK sandbox: scripted structured outputs; records every claude invocation. */
function fakeSandbox(outputs: unknown[], o: { sessionId?: string | null } = {}) {
  const runs: RunOpts[] = [];
  const opened: { workspaceDir: string; files: string[] }[] = [];
  let destroyed = 0;
  let gw: GatewayHandle;
  const open: AgenticResearchDeps['openSandbox'] = async ({ workspaceDir, gateway }) => {
    gw = gateway;
    opened.push({ workspaceDir, files: fs.readdirSync(workspaceDir).sort() });
    return {
      containerId: 'mock-container',
      gatewayUrl: 'http://frugal-gateway:8080',
      async run(r: RunOpts): Promise<ResearchSandboxRun> {
        runs.push(r);
        gw.tracker.record(
          { provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, reasoningIncludedInOutput: true, cacheReadTokens: 5000, cacheWriteTokens: 0, totalTokens: 6200, costUsd: 0.01, costEstimated: true, usageEstimated: false, raw: { mock: true } },
          'agent-turn',
        );
        const out = outputs[runs.length - 1];
        const sid = o.sessionId === null ? undefined : (o.sessionId ?? 'sess-mock-1');
        const result = { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out, ...(sid ? { session_id: sid } : {}) };
        return { exitCode: 0, timedOut: false, result, events: [result] };
      },
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      destroy: async () => void destroyed++,
    };
  };
  return { open, runs, opened, destroyed: () => destroyed };
}

/** MOCK workspace builder (the real one is tested in research-workspace.test.ts). */
function fakeWorkspace() {
  const built: ResearchWorkspace[] = [];
  const fn: AgenticResearchDeps['buildWorkspace'] = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-mockws-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# MOCK');
    const ws: ResearchWorkspace = { dir, experiments: [], runs: ['run-a'], notes: [], bytes: 6, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    built.push(ws);
    return ws;
  };
  return { fn, built };
}

const input = (): ResearchAgentInput => ({
  context: { db: {} as Db, resultsDir: '/nonexistent/results', configsRoot: '/nonexistent/configs' },
  bestConfigId: 'baseline',
  bestConfigFiles: { 'system-prompt.md': 'You are a coding agent.', 'config.json': ccConfig },
  history: 'EXPERIMENTS: none yet',
  experimentIndex: 1,
  singleVariableExperiments: 3,
  whitelist: { allowModelChange: false },
  experimentId: 'exp-0007',
});

function agent(sb: ReturnType<typeof fakeSandbox>, gw: ReturnType<typeof fakeGateway>, guard: AgenticResearchDeps['guard'] = null, ws = fakeWorkspace()) {
  const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-ag-'));
  return {
    ws,
    agent: createAgenticResearchAgent({
      model: 'claude-sonnet-5-5',
      effort: 'high',
      maxRuntimeSec: 900,
      maxTotalTokens: 1_500_000,
      streamDir,
      deps: { startGateway: gw.start, hasSubscriptionToken: () => true, openSandbox: sb.open, buildWorkspace: ws.fn, guard },
    }),
  };
}

describe('agentic research agent: container argv and flags', () => {
  it('claude gets ONLY Read/Grep/Glob/Bash/Write, Write scoped to /research/scratch, no Task/web tools', () => {
    const args = buildAgenticClaudeArgs({ model: 'claude-opus-5-5', effort: 'high', systemPrompt: 'SYS' });
    const val = (f: string) => args[args.indexOf(f) + 1];
    expect(val('--tools').split(',')).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write']);
    expect(RESEARCH_TOOLS).not.toContain('Task');
    for (const t of ['Task', 'Agent', 'WebFetch', 'WebSearch']) {
      expect(val('--tools').split(',')).not.toContain(t);
      expect(val('--disallowedTools').split(',')).toContain(t);
    }
    expect(val('--disallowedTools')).toContain('Bash(claude:*)');
    const allowed = val('--allowedTools').split(',');
    expect(allowed).toContain('Write(//research/scratch/**)');
    expect(allowed).not.toContain('Write');
    expect(val('--permission-mode')).toBe('dontAsk');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--mcp-config');
    expect(val('--model')).toBe('claude-opus-5-5');
    expect(val('--system-prompt')).toBe('SYS');
    expect(JSON.parse(val('--json-schema')).required).toEqual(['hypothesis', 'changeSummary', 'evidence', 'expectedSavings', 'files']);
    expect(args).not.toContain('--resume');
    expect(buildAgenticClaudeArgs({ model: 'm', systemPrompt: 's', resumeSessionId: 'abc' }).slice(-2)).toEqual(['--resume', 'abc']);
  });

  it('container: internal network, non-root, limits, tmpfs only — no host mounts, no spec/evaluator copy', () => {
    const o = researchSandboxOptions({ image: 'frugal-bench-cc:x', label: 'research-exp', network: 'frugal-coding-research-net' });
    expect(o.network).toBe('frugal-coding-research-net');
    expect(o.user ?? 'node').toBe('node');
    expect(o.specDir).toBeUndefined();
    expect(o.publish).toBeUndefined();
    expect(o.memory).toBe('2g');
    expect(o.cpus).toBe(2);
    expect(o.pidsLimit).toBeGreaterThan(0);
    // Only tmpfs mounts; none of them is a host path bind.
    expect(o.extraTmpfs!.map((t) => t.split(':')[0])).toEqual(['/home/node', '/research', '/research/scratch']);
    expect(o.extraTmpfs!.find((t) => t.startsWith('/research:'))).not.toContain('uid=1000'); // root-owned → read-only for node
    expect(o.extraTmpfs!.find((t) => t.startsWith('/research/scratch:'))).toContain('uid=1000');
    expect(JSON.stringify(o)).not.toContain(process.cwd());
    expect(JSON.stringify(o)).not.toContain(os.homedir());
  });

  it('docker exec: user node, cwd /research, placeholder token only, no -v / --privileged', () => {
    const env = buildAgenticEnv('http://frugal-gateway:8080', 32000);
    const argv = buildResearchExecArgs('cid', env, ['-p'], 900);
    expect(argv.slice(0, 6)).toEqual(['exec', '-i', '-u', 'node', '-w', '/research']);
    expect(argv).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDER_OAUTH_TOKEN}`);
    expect(argv).toContain('ANTHROPIC_BASE_URL=http://frugal-gateway:8080');
    expect(argv).not.toContain('-v');
    expect(argv).not.toContain('--privileged');
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) expect(argv.join(' ')).not.toContain(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    expect(argv).toContain('900s');
  });
});

describe('agentic proposal schema', () => {
  it('splitAgenticProposal requires evidence and expectedSavings and strips them for validateProposal', () => {
    const s = splitAgenticProposal(good);
    expect(s.errors).toEqual([]);
    expect(s.evidence).toContain('run-a');
    expect(validateProposal(s.core, { allowModelChange: false, backend: 'claude-code' }).ok).toBe(true);
    const bad = splitAgenticProposal({ ...good, evidence: 'short', expectedSavings: undefined });
    expect(bad.errors.join(' ')).toMatch(/evidence/);
    expect(bad.errors.join(' ')).toMatch(/expectedSavings/);
    // without stripping, the core validator would reject the unknown keys
    expect(validateProposal(good, { allowModelChange: false, backend: 'claude-code' }).ok).toBe(false);
  });

  it('schema describes the extended surface', () => {
    const d = AGENTIC_PROPOSAL_JSON_SCHEMA.properties.files.description;
    for (const k of ['bin/<name>', 'agents/<name>.md', 'commands/<name>.md', 'claudeCode.settings.hooks', 'CLAUDE.md']) expect(d).toContain(k);
  });
});

describe('agentic research agent (FAKE sandbox + gateway + guard — MOCK)', () => {
  it('returns proposal + evidence; research usage from the gateway with the token cap; cleans up', async () => {
    const gw = fakeGateway();
    const sb = fakeSandbox([good]);
    const { agent: a, ws } = agent(sb, gw);
    const r = await a.propose(input());
    expect(r.attempts).toBe(1);
    expect(r.research).toEqual({ evidence: good.evidence, expectedSavings: good.expectedSavings });
    expect(r.proposal).not.toHaveProperty('evidence');
    expect(r.usage).toHaveLength(1);
    expect(r.usage[0]).toMatchObject({ role: 'research', experimentId: 'exp-0007', totalTokens: 6200 });
    expect(gw.started[0]).toMatchObject({ role: 'research', mainModel: 'claude-sonnet-5-5', limits: { maxTotalTokens: 1_500_000 } });
    expect(sb.opened[0].files).toEqual(['README.md']);
    expect(sb.runs[0].prompt).toContain('/research/README.md');
    expect(sb.runs[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(PLACEHOLDER_OAUTH_TOKEN);
    expect(sb.runs[0].timeoutSec).toBeLessThanOrEqual(900);
    const sys = sb.runs[0].args[sb.runs[0].args.indexOf('--system-prompt') + 1];
    expect(sys).toContain('/research/scratch');
    expect(sys).toContain('single-variable');
    expect(sb.destroyed()).toBe(1);
    expect(gw.stopped()).toBe(1);
    expect(fs.existsSync(ws.built[0].dir)).toBe(false);
  });

  it('guard rejection goes back ONCE in the same session (--resume) and the fix is accepted', async () => {
    const gw = fakeGateway();
    const fixed = { ...good, changeSummary: 'fixed: tools restricted' };
    const sb = fakeSandbox([good, fixed]);
    const guardCalls: unknown[] = [];
    const guard: AgenticResearchDeps['guard'] = (p, ctx) => {
      guardCalls.push({ p, ctx });
      return guardCalls.length === 1 ? ['bin/check contains application code (express route)'] : [];
    };
    const { agent: a } = agent(sb, gw, guard);
    const r = await a.propose(input());
    expect(r.attempts).toBe(2);
    expect(r.proposal.changeSummary).toBe('fixed: tools restricted');
    expect(sb.runs).toHaveLength(2);
    const second = sb.runs[1];
    expect(second.args.slice(-2)).toEqual(['--resume', 'sess-mock-1']);
    expect(second.prompt).toContain('REJECTED');
    expect(second.prompt).toContain('guard: bin/check contains application code');
    expect((guardCalls[0] as { ctx: { parentConfigId: string; configsRoot: string } }).ctx).toMatchObject({ parentConfigId: 'baseline', configsRoot: '/nonexistent/configs' });
    expect(r.usage).toHaveLength(2);
    expect(sb.destroyed()).toBe(1); // one container for both attempts
  });

  it('without a session id the feedback goes to a new call carrying the rejected proposal', async () => {
    const gw = fakeGateway();
    const noEvidence = { ...good, evidence: undefined };
    const sb = fakeSandbox([noEvidence, good], { sessionId: null });
    const { agent: a } = agent(sb, gw);
    const r = await a.propose(input());
    expect(r.attempts).toBe(2);
    expect(sb.runs[1].args).not.toContain('--resume');
    expect(sb.runs[1].prompt).toContain('Candidate experiment #1');
    expect(sb.runs[1].prompt).toContain('"evidence" must be a string');
    expect(sb.runs[1].prompt).toContain('Rejected proposal:');
  });

  it('fails after the single feedback attempt; usage is still reported', async () => {
    const gw = fakeGateway();
    const sb = fakeSandbox([good, good]);
    const { agent: a } = agent(sb, gw, () => ['always rejected']);
    const err = await a.propose(input()).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProposalError);
    expect((err as ResearchProposalError).errors).toEqual(['guard: always rejected']);
    expect((err as ResearchProposalError).usage).toHaveLength(2);
    expect(sb.destroyed()).toBe(1);
    expect(gw.stopped()).toBe(1);
  });

  it('single-variable rule is enforced as feedback too', async () => {
    const gw = fakeGateway();
    const many = { ...good, files: { 'system-prompt.md': 'a', 'CLAUDE.md': 'b', 'skills/x.md': 'c' } };
    const sb = fakeSandbox([many, good]);
    const { agent: a } = agent(sb, gw);
    const r = await a.propose(input());
    expect(r.attempts).toBe(2);
    expect(sb.runs[1].prompt).toContain('single-variable experiment');
  });

  it('needs input.context', async () => {
    const { agent: a } = agent(fakeSandbox([good]), fakeGateway());
    await expect(a.propose({ ...input(), context: undefined })).rejects.toThrow(/input.context/);
  });
});

describe('loop integration with the agentic agent (FAKE sandbox + bench — MOCK)', () => {
  let dir: string;
  let configs: string;
  let results: string;
  let db: Db;
  beforeEach(() => {
    dir = makeTmp();
    configs = makeConfigsRoot(dir);
    results = path.join(dir, 'results');
    db = openDb(path.join(results, 'benchmark.db'));
  });
  afterEach(() => {
    db.close();
    rmTmp(dir);
  });

  it('builds a real workspace from the loop context, stores evidence/expected savings, feeds them back next time', async () => {
    const gw = fakeGateway();
    const proposals = [1, 2].map((n) => ({
      hypothesis: `Shorter prompt v${n} cuts per-call overhead`,
      changeSummary: `prompt v${n}`,
      evidence: `fake-baseline-verify run ${n}: system prompt re-read on all 3 calls`,
      expectedSavings: `~${n}k tokens per run`,
      files: { 'system-prompt.md': `MOCK PROMPT v${n}\n` },
    }));
    const sb = fakeSandbox(proposals);
    const workspaces: string[][] = [];
    const realWs: AgenticResearchDeps['buildWorkspace'] = async (o) => {
      const ws = await buildResearchWorkspace({ ...o, profile: null, repoRoot: process.cwd() });
      const list = (d: string, base = d): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]));
      workspaces.push(list(ws.dir).sort());
      if (workspaces.length === 2) {
        const metaPath = list(ws.dir).find((f) => f.endsWith('meta.json') && fs.readFileSync(path.join(ws.dir, f), 'utf8').includes('prompt v1'))!;
        const meta = JSON.parse(fs.readFileSync(path.join(ws.dir, metaPath), 'utf8'));
        expect(meta.evidence).toBe(proposals[0].evidence);
        expect(meta.expectedSavings).toBe(proposals[0].expectedSavings);
      }
      return ws;
    };
    const research: ResearchAgent = createAgenticResearchAgent({
      streamDir: path.join(dir, 'streams'),
      deps: { startGateway: gw.start, hasSubscriptionToken: () => true, openSandbox: sb.open, buildWorkspace: realWs, guard: null },
    });
    const bench = makeFakeBench(db, (cfg) => ({ passed: true, tokens: cfg === 'baseline' ? 1000 : 900 }));
    const res = await runResearchLoop(
      { db, runBenchmark: bench.fn, researchAgent: research, clock: makeFakeClock() },
      {
        settings: { ...DEFAULT_RESEARCH_SETTINGS, verificationRuns: 2, maxExperiments: 2, quickRunMaxTokenRatio: null, holdout: { onPromotion: false, runs: 1 } },
        paths: { configsRoot: configs, resultsDir: results },
      },
    );
    expect(res.experimentsRun).toBe(2);
    const cands = db.listExperiments().filter((e) => e.kind === 'candidate');
    const split = splitResearchText(cands[0].hypothesis);
    expect(split).toEqual({ hypothesis: proposals[0].hypothesis, evidence: proposals[0].evidence, expectedSavings: proposals[0].expectedSavings });
    // research usage stored per experiment, separate from coding
    expect(db.usageRecordTotalsByRole({ experimentId: cands[0].id }).research.totalTokens).toBe(6200);
    // the workspace had the documented top-level layout and the baseline experiment
    expect(workspaces[0]).toEqual(expect.arrayContaining(['README.md', 'digest.md', path.join('best-config', 'system-prompt.md')]));
    expect(workspaces[0].some((f) => f.startsWith('spec' + path.sep))).toBe(true);
    expect(workspaces[1].some((f) => f.includes(cands[0].id))).toBe(true);
  });
});
