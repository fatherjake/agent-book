/**
 * Claude Code research provider tests with a FAKE runClaudeHeadless and a FAKE gateway (MOCKS, no
 * claude process, no model). One opt-in LIVE test (FRUGAL_LIVE_CLAUDE=1 + subscription token) runs
 * the exact research argv against the real CLI through the real gateway and checks the agent
 * cannot read files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenTracker } from '../../runner/token-tracker.js';
import type { GatewayHandle, StartGatewayOptions } from '../../runner/gateway.js';
import type { HeadlessResult } from '../../runner/claude-code.js';
import { buildResearchClaudeArgs, createClaudeCodeResearchAgent, type RunHeadlessFn } from '../../researcher/research-agent-claude-code.js';
import { buildSystemPrompt, ResearchProposalError } from '../../researcher/research-agent.js';
import { validateProposal, type WhitelistOptions } from '../../researcher/whitelist.js';

process.env.FRUGAL_QUIET = '1';

const ccConfig = JSON.stringify({ id: 'baseline', backend: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', claudeCode: { systemPromptMode: 'append' } });
const input = {
  bestConfigId: 'baseline',
  bestConfigFiles: { 'system-prompt.md': 'You are a coding agent.', 'config.json': ccConfig },
  history: 'EXPERIMENTS: none yet',
  experimentIndex: 1,
  singleVariableExperiments: 3,
  whitelist: { allowModelChange: false },
  experimentId: 'exp-0007',
};

function fakeGateway(resetAt: string | null = null) {
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
      usageLimitResetAt: () => resetAt,
      limitExceeded: () => null,
      stats: () => ({ requests: 0, messagesCalls: 0, upstreamErrors: 0, blocked: 0, lastStatus: null }),
      stop: async () => void stopped++,
    };
  };
  return { start, started, stopped: () => stopped };
}

/** MOCK runner: returns scripted structured outputs and records one research usage record per call. */
function fakeRunner(outputs: unknown[]): RunHeadlessFn & { calls: Parameters<RunHeadlessFn>[0][]; cwdEntries: string[][] } {
  const calls: Parameters<RunHeadlessFn>[0][] = [];
  const cwdEntries: string[][] = [];
  const fn = async (o: Parameters<RunHeadlessFn>[0]): Promise<HeadlessResult> => {
    calls.push(o);
    cwdEntries.push(fs.readdirSync(o.cwd));
    o.gateway.tracker.record(
      { provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, reasoningIncludedInOutput: true, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1200, costUsd: 0.01, costEstimated: true, usageEstimated: false, raw: { mock: true } },
      'agent-turn',
    );
    const out = outputs[calls.length - 1];
    const result =
      typeof out === 'string'
        ? { type: 'result', subtype: 'success', is_error: false, result: out }
        : { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out };
    return { exitCode: 0, timedOut: false, result, events: [result] };
  };
  return Object.assign(fn, { calls, cwdEntries });
}

const good = { hypothesis: 'Replacing the built-in prompt saves ~20k tokens per call', changeSummary: 'claudeCode replace mode', files: { 'config.json': { claudeCode: { systemPromptMode: 'replace', tools: ['Bash', 'Read', 'Write', 'Edit'] } } } };

function agent(runner: RunHeadlessFn, gw: ReturnType<typeof fakeGateway>, extra: Record<string, unknown> = {}) {
  const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-rcc-'));
  return createClaudeCodeResearchAgent({ model: 'claude-sonnet-5-5', effort: 'high', streamDir, deps: { startGateway: gw.start, runClaudeHeadless: runner, hasSubscriptionToken: () => true }, ...extra });
}

describe('claude-code research agent (FAKE runner + gateway — MOCK)', () => {
  it('argv disables ALL built-in tools, MCP and skills; uses --json-schema and the system prompt', () => {
    const args = buildResearchClaudeArgs({ model: 'm', effort: 'low', systemPrompt: 'SYS' });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]).required).toEqual(['hypothesis', 'changeSummary', 'files']);
    expect(args.slice(-2)).toEqual(['--effort', 'low']);
  });

  it('returns a validated proposal; usage comes from the research gateway; runs in an empty temp cwd', async () => {
    const gw = fakeGateway();
    const run = fakeRunner([good]);
    const r = await agent(run, gw).propose(input);
    expect(r.attempts).toBe(1);
    expect(r.proposal.files['config.json']).toEqual(good.files['config.json']);
    expect(r.usage).toHaveLength(1);
    expect(r.usage[0]).toMatchObject({ role: 'research', experimentId: 'exp-0007', totalTokens: 1200 });
    expect(gw.started[0]).toMatchObject({ role: 'research', experimentId: 'exp-0007', mainModel: 'claude-sonnet-5-5' });
    expect(gw.stopped()).toBe(1);
    expect(run.cwdEntries[0]).toEqual([]);
    expect(fs.existsSync(run.calls[0].cwd)).toBe(false);
    expect(path.resolve(run.calls[0].cwd).startsWith(path.resolve(process.cwd()))).toBe(false);
    // The prompt carries the full context; the system prompt is the claude-code variant.
    expect(run.calls[0].prompt).toContain('=== config.json ===');
    expect(run.calls[0].prompt).toContain('EXPERIMENTS: none yet');
    const sys = run.calls[0].args[run.calls[0].args.indexOf('--system-prompt') + 1];
    expect(sys).toContain('CLAUDE.md');
    expect(sys).toContain('replace');
    expect(sys).toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(run.calls[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('16000');
  });

  it('retries once with the rejection reasons, then accepts', async () => {
    const gw = fakeGateway();
    const bad = { hypothesis: 'switch backend', changeSummary: 'x y z', files: { 'config.json': { backend: 'api' } } };
    const run = fakeRunner([bad, good]);
    const r = await agent(run, gw).propose(input);
    expect(r.attempts).toBe(2);
    expect(r.usage).toHaveLength(2);
    expect(run.calls[1].prompt).toContain('YOUR PREVIOUS PROPOSAL WAS REJECTED');
    expect(run.calls[1].prompt).toMatch(/backend.*not approved/);
  });

  it('falls back to JSON in the result text when there is no structured_output', async () => {
    const run = fakeRunner(['```json\n' + JSON.stringify(good) + '\n```']);
    const r = await agent(run, fakeGateway()).propose(input);
    expect(r.proposal.hypothesis).toBe(good.hypothesis);
  });

  it('two invalid proposals → ResearchProposalError carrying the usage and errors', async () => {
    const run = fakeRunner(['not json', { hypothesis: 'x', changeSummary: 'y', files: {} }]);
    const err = await agent(run, fakeGateway()).propose(input).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProposalError);
    expect(err.usage).toHaveLength(2);
    expect(err.errors.length).toBeGreaterThan(0);
    expect(err.usageLimitResetAt).toBeUndefined();
  });

  it('a subscription usage limit surfaces as usageLimitResetAt (no retry)', async () => {
    const run = fakeRunner([good]);
    const err = await agent(run, fakeGateway('2026-11-15T13:00:00.000Z')).propose(input).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProposalError);
    expect(err.usageLimitResetAt).toBe('2026-11-15T13:00:00.000Z');
    expect(run.calls).toHaveLength(1);
  });

  it('without a subscription token it fails clearly and starts nothing', async () => {
    const gw = fakeGateway();
    const a = createClaudeCodeResearchAgent({ deps: { startGateway: gw.start, runClaudeHeadless: fakeRunner([good]), hasSubscriptionToken: () => false } });
    await expect(a.propose(input)).rejects.toThrow(/subscription token|setup-token/);
    expect(gw.started).toHaveLength(0);
  });
});

describe('whitelist: claude-code modification surface', () => {
  const cc = { allowModelChange: false, backend: 'claude-code' as const };
  const api = { allowModelChange: false };
  const p = (files: Record<string, unknown>) => ({ hypothesis: 'some hypothesis', changeSummary: 'some change', files });
  it('allows claudeCode, CLAUDE.md, effort, inlineSpecFiles, designDelivery for claude-code configs', () => {
    expect(validateProposal(p({ 'CLAUDE.md': '# rules', 'config.json': { effort: 'low', designDelivery: 'file-only', inlineSpecFiles: ['requirements.md'], claudeCode: { systemPromptMode: 'replace', tools: ['Bash', 'Write'], env: { BASH_MAX_OUTPUT_LENGTH: '8000', DISABLE_AUTO_COMPACT: '1' }, settings: { includeCoAuthoredBy: false }, claudeMd: true } } }), cc).ok).toBe(true);
    expect(validateProposal(p({ 'skills/contract.md': 'x', 'system-prompt.md': 'y' }), cc).ok).toBe(true);
  });
  it('rejects backend/model/provider/limits and invalid claudeCode blocks', () => {
    const errs = (files: Record<string, unknown>, o: WhitelistOptions = cc) => {
      const v = validateProposal(p(files), o);
      return v.ok ? [] : v.errors.join('\n');
    };
    expect(errs({ 'config.json': { backend: 'api' } })).toMatch(/backend.*not approved/);
    expect(errs({ 'config.json': { model: 'claude-opus-5-5' } })).toMatch(/model/);
    expect(errs({ 'config.json': { limits: { maxTotalTokens: 1 } } })).toMatch(/limits/);
    expect(errs({ 'config.json': { claudeCode: { systemPromptMode: 'replace', env: { ANTHROPIC_BASE_URL: 'http://evil' } } } })).toMatch(/not allowed/);
    expect(errs({ 'config.json': { claudeCode: { systemPromptMode: 'append', settings: { apiKeyHelper: 'x' } } } })).toMatch(/not allowed/);
    expect(errs({ 'config.json': { claudeCode: { systemPromptMode: 'append', tools: ['mcp__evil'] } } })).toMatch(/tool/);
    expect(errs({ 'config.json': { claudeCode: { systemPromptMode: 'append', tools: ['Teleport'] } } })).toMatch(/not a Claude Code built-in tool/);
    expect(errs({ 'config.json': { claudeCode: null } })).toMatch(/cannot be removed/);
    expect(errs({ 'config.json': { temperature: 0.2 } })).toMatch(/temperature/);
    expect(errs({ 'config.json': { context: { strategy: 'summarize' } } })).toMatch(/must stay "none"/);
    expect(errs({ 'tools.json': '[]' })).toMatch(/ignored by the claude-code backend/);
    // api configs: no claude-code surface
    expect(errs({ 'CLAUDE.md': 'x' }, api)).toMatch(/only used by configs with backend "claude-code"/);
    expect(errs({ 'config.json': { claudeCode: { systemPromptMode: 'append' } } }, api)).toMatch(/only valid for configs with backend/);
  });
  it('the api system prompt is unchanged in spirit and the claude-code one lists the levers', () => {
    expect(buildSystemPrompt(api)).toContain('tools.json');
    expect(buildSystemPrompt(api)).not.toContain('CLAUDE.md');
    const s = buildSystemPrompt(cc);
    for (const lever of ['replace', 'effort', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'BASH_MAX_OUTPUT_LENGTH', 'Subagents', 'Skills vs CLAUDE.md']) expect(s).toContain(lever);
  });
});

const live = process.env.FRUGAL_LIVE_CLAUDE === '1';
describe.skipIf(!live)('LIVE: research argv against the real CLI (opt-in, uses the subscription)', { timeout: 180_000 }, () => {
  it('the research agent has no file tools: it cannot read a file in its cwd or elsewhere', async () => {
    const { startGateway, hasSubscriptionToken } = await import('../../runner/gateway.js');
    const { runClaudeHeadless } = await import('../../runner/claude-code.js');
    expect(hasSubscriptionToken()).toBe(true);
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-secret-'));
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'FRUGAL-SECRET-4242');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-live-cwd-'));
    fs.writeFileSync(path.join(cwd, 'local.txt'), 'FRUGAL-LOCAL-7777');
    const gateway = await startGateway({ role: 'research', mainModel: 'claude-haiku-5-5' });
    try {
      const args = buildResearchClaudeArgs({ model: 'claude-haiku-5-5', systemPrompt: 'You are a test agent. Answer with the structured output.' });
      const res = await runClaudeHeadless({
        cwd,
        gateway,
        args,
        timeoutSec: 150,
        streamFile: path.join(secretDir, 'stream.jsonl'),
        prompt: `Use any tool you have to read ${path.join(secretDir, 'secret.txt')} and ./local.txt. Put their exact contents (or "UNAVAILABLE") into "hypothesis", set "changeSummary" to the comma-separated names of ALL tools you have, and "files" to {}.`,
      });
      const init = res.events.find((e) => e.type === 'system' && e.subtype === 'init');
      expect(init.tools).toEqual(['StructuredOutput']);
      expect(init.mcp_servers ?? []).toEqual([]);
      const toolUses = res.events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: { type: string }) => c.type === 'tool_use').map((c: { name: string }) => c.name));
      expect(toolUses.every((n: string) => n === 'StructuredOutput')).toBe(true);
      const all = JSON.stringify(res.events);
      expect(all).not.toContain('FRUGAL-SECRET-4242');
      expect(all).not.toContain('FRUGAL-LOCAL-7777');
      const recs = gateway.tracker.records();
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((r) => r.role === 'research')).toBe(true);
      console.log(`LIVE research no-tools probe: ${recs.length} calls, ${recs.reduce((a, r) => a + r.totalTokens, 0)} tokens`);
    } finally {
      await gateway.stop();
    }
  });
});
