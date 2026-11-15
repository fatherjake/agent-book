/**
 * Claude Code backend: stream-json → trace conversion (recorded fixtures from real host runs,
 * sanitized), prompt/flag/env construction, skills frontmatter, and the stream cross-check helpers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_TASK_PROMPT,
  StreamJsonCollector,
  buildClaudeArgs,
  buildClaudeCodePrompt,
  buildClaudeEnv,
  claudeHomeFiles,
  countToolUses,
  skillMarkdown,
  streamResultTotals,
  streamToTrace,
  streamUsageLimit,
} from '../../runner/claude-code.js';
import { PLACEHOLDER_OAUTH_TOKEN } from '../../runner/gateway.js';
import { computeCost } from '../../runner/token-tracker.js';
import { loadConfig } from '../../runner/config.js';
import { selectBackend } from '../../runner/run.js';
import { MockProvider } from '../../runner/providers/mock.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('streamToTrace (recorded fixtures)', () => {
  it('converts a Write + Bash run into start / model_call / tool_call / end with numeric turns', () => {
    const events = fixture('claude-stream-tools.jsonl');
    const trace = streamToTrace(events, { configId: 'baseline', limits: { maxRuntimeSec: 1 } });
    expect(trace.map((e) => e.type)).toEqual(['start', 'model_call', 'tool_call', 'model_call', 'tool_call', 'model_call', 'end']);
    for (const e of trace) {
      expect(typeof e.turn).toBe('number');
      expect(typeof e.ts).toBe('string');
    }
    expect(trace[0]).toMatchObject({ type: 'start', turn: 0, backend: 'claude-code', model: 'claude-sonnet-5-5', claudeCodeVersion: '2.1.325', configId: 'baseline' });
    const calls = trace.filter((e) => e.type === 'model_call');
    expect(calls.map((c) => c.turn)).toEqual([1, 2, 3]);
    expect(calls[0].toolUses).toEqual([{ id: expect.stringMatching(/^toolu_/), name: 'Write' }]);
    expect(calls[2].text).toBe('done');
    const tools = trace.filter((e) => e.type === 'tool_call');
    expect(tools.map((t) => [t.tool, t.turn])).toEqual([
      ['Write', 1],
      ['Bash', 2],
    ]);
    expect(tools[1]).toMatchObject({ input: { command: 'cat hello.txt' }, output: 'hi', isError: false });
    const end = trace.at(-1)!;
    expect(end).toMatchObject({ type: 'end', status: 'completed', subtype: 'success', modelCalls: 3, toolCalls: 2, toolErrors: 0, result: 'done' });
    expect(countToolUses(events)).toBe(2);
  });

  it('keeps subagent (Agent/Task) calls on the parent turn and marks them', () => {
    const events = fixture('claude-stream-subagent.jsonl');
    const trace = streamToTrace(events);
    const calls = trace.filter((e) => e.type === 'model_call');
    expect(calls).toHaveLength(3);
    const [main1, sub, main2] = calls;
    expect(main1).toMatchObject({ turn: 1, purpose: 'agent-turn' });
    expect((main1.toolUses as any[])[0].name).toBe('Agent');
    const agentId = (main1.toolUses as any[])[0].id;
    expect(sub).toMatchObject({ turn: 1, purpose: 'subagent', subagent: agentId });
    expect(main2).toMatchObject({ turn: 2, purpose: 'agent-turn' });
    const tools = trace.filter((e) => e.type === 'tool_call');
    expect(tools.map((t) => [t.tool, t.turn, t.subagent ?? null])).toEqual([
      ['Bash', 1, agentId],
      ['Agent', 1, null],
    ]);
    expect(trace.some((e) => e.type === 'system_task_started')).toBe(true);
    expect(countToolUses(events)).toBe(2);
  });

  it('cross-check: the stream result totals equal what the gateway recorded for the same run', () => {
    // Gateway records captured alongside the fixtures (role coding): see the totals below.
    expect(streamResultTotals(fixture('claude-stream-tools.jsonl').at(-1))).toEqual({
      inputTokens: 6,
      outputTokens: 182,
      cacheReadTokens: 33369,
      cacheWriteTokens: 16850,
      totalTokens: 50407,
    });
    expect(streamResultTotals(fixture('claude-stream-subagent.jsonl').at(-1))?.totalTokens).toBe(56521);
    expect(streamResultTotals(null)).toBeNull();
  });

  it('API-equivalent cost with 1h cache writes matches what Claude Code reports', () => {
    const res = fixture('claude-stream-tools.jsonl').at(-1);
    const c = computeCost('claude-sonnet-5-5', { inputTokens: 6, outputTokens: 182, cacheReadTokens: 33369, cacheWriteTokens: 16850, cacheWrite1hTokens: 16850 });
    expect(c.costUsd).toBeCloseTo(res.total_cost_usd, 8);
  });

  it('emits an end entry even without a result event', () => {
    const t = streamToTrace([{ type: 'system', subtype: 'init', model: 'm' }]);
    expect(t.at(-1)).toMatchObject({ type: 'end', status: 'no_result', modelCalls: 0 });
  });

  it('StreamJsonCollector splits chunked lines and keeps unparsable lines', () => {
    const c = new StreamJsonCollector();
    c.push('{"type":"a"}\n{"ty');
    c.push('pe":"result","x":1}\nnot json\n');
    c.end();
    expect(c.events.map((e) => e.type)).toEqual(['a', 'result', 'unparsed']);
    expect(c.result()).toMatchObject({ x: 1 });
  });

  it('streamUsageLimit reads rejected rate_limit_event', () => {
    expect(streamUsageLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } })).toBeNull();
    expect(streamUsageLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794988800 } })).toBe(new Date(1794988800 * 1000).toISOString());
  });
});

describe('claude-code invocation', () => {
  const base = loadConfig('baseline');

  it('the baseline is a claude-code config', () => {
    expect(base).toMatchObject({ backend: 'claude-code', model: 'claude-sonnet-5-5', claudeCode: { systemPromptMode: 'append' }, maxOutputTokensPerCall: 0 });
    expect(selectBackend(base)).toBe('claude-code');
    expect(selectBackend(base, new MockProvider())).toBe('api');
    expect(selectBackend({ ...base, provider: 'mock' })).toBe('api');
    expect(selectBackend(loadConfig('baseline-api'))).toBe('api');
  });

  it('builds flags from the config', () => {
    expect(buildClaudeArgs(base)).toEqual(['--model', 'claude-sonnet-5-5', '--append-system-prompt', base.systemPrompt.trim()]);
    const cfg = {
      ...base,
      effort: 'low' as const,
      claudeCode: { systemPromptMode: 'replace' as const, tools: ['Bash', 'Read', 'Write'], disallowedTools: ['WebFetch', 'Bash(rm *)'], settings: { includeCoAuthoredBy: false } },
    };
    expect(buildClaudeArgs(cfg)).toEqual([
      '--model', 'claude-sonnet-5-5',
      '--effort', 'low',
      '--system-prompt', base.systemPrompt.trim(),
      '--tools', 'Bash,Read,Write',
      '--disallowedTools', 'WebFetch,Bash(rm *)',
      '--settings', '/home/node/.claude/frugal-settings.json',
    ]);
  });

  it('env: gateway URL + placeholder token only, allowlisted extras, no real credentials', () => {
    const env = buildClaudeEnv({ ...base, thinkingBudget: 2000, claudeCode: { systemPromptMode: 'append', env: { BASH_MAX_OUTPUT_LENGTH: '5000' } } }, 'http://frugal-gateway:8080');
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://frugal-gateway:8080',
      CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_OAUTH_TOKEN,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      HOME: '/home/node',
      CLAUDE_CONFIG_DIR: '/home/node/.claude',
      MAX_THINKING_TOKENS: '2000',
      BASH_MAX_OUTPUT_LENGTH: '5000',
    });
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(Object.keys(env).filter((k) => /API_KEY/.test(k))).toEqual([]);
  });

  it('prompt names /spec, inlines configured spec files and asks to view the design first', () => {
    const p = buildClaudeCodePrompt(base, [{ name: 'requirements.md', content: '# Req\n' }]);
    expect(p.startsWith(CLAUDE_CODE_TASK_PROMPT)).toBe(true);
    expect(p).toContain('/spec/design.png');
    expect(p).toContain('Start by viewing the reference design /spec/design.png');
    expect(p).toContain('<file path="/spec/requirements.md">\n# Req\n</file>');
    expect(buildClaudeCodePrompt({ ...base, designDelivery: 'file-only' }, [])).not.toContain('Start by viewing');
  });

  it('skills go to ~/.claude/skills/<name>/SKILL.md with frontmatter; CLAUDE.md to ~/.claude (never /workspace)', () => {
    const files = claudeHomeFiles({ ...base, skills: [...base.skills, { name: 'My Notes', content: '# Speed tips\nBe quick.' }], claudeCode: { systemPromptMode: 'append', claudeMd: true }, claudeMdContent: '# mem' });
    expect(files.map((f) => f.path)).toEqual([
      '/home/node/.claude/skills/fullstack-checklist/SKILL.md',
      '/home/node/.claude/skills/my-notes/SKILL.md',
      '/home/node/.claude/CLAUDE.md',
    ]);
    expect(files[0].content).toBe(base.skills[0].content); // already has frontmatter
    expect(files[1].content).toMatch(/^---\nname: my-notes\ndescription: "Speed tips \(use this skill for the benchmark task\)"\n---\n\n# Speed tips/);
    for (const f of files) expect(f.path.startsWith('/workspace')).toBe(false);
    expect(skillMarkdown('x', '---\nname: x\ndescription: d\n---\nbody')).toBe('---\nname: x\ndescription: d\n---\nbody');
  });
});
