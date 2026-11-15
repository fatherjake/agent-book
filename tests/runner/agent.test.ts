import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent, dropOldToolResults, buildInitialUserMessage, buildSystemPrompt, DROPPED_TOOL_RESULT } from '../../runner/agent.js';
import { loadConfig } from '../../runner/config.js';
import { MockProvider } from '../../runner/providers/mock.js';
import { TokenTracker } from '../../runner/token-tracker.js';
import type { AgentConfig, Message } from '../../runner/types.js';
import { FakeSandbox } from './fake-sandbox.js';

function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...loadConfig('baseline-api'), provider: 'mock', ...over };
}
const tracker = () => new TokenTracker({ role: 'coding', runId: 'r' });

describe('runAgent with the mock provider', () => {
  it('default script writes a file and completes; trace is written', async () => {
    const sb = new FakeSandbox();
    const t = tracker();
    const traceFile = join(mkdtempSync(join(tmpdir(), 'tr-')), 'trace.jsonl');
    const r = await runAgent({ config: cfg(), provider: new MockProvider(), tracker: t, sandbox: sb, traceFile });
    expect(r.status).toBe('completed');
    expect(r.toolCalls).toBe(1);
    expect(sb.files.get('/workspace/MOCK_RUN.txt')?.toString()).toMatch(/mock provider/);
    expect(t.totals().modelCalls).toBe(2);
    expect(t.totals().anyEstimated).toBe(true);
    const types = readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types).toEqual(['start', 'model_call', 'tool_call', 'model_call', 'end']);
    const entries = readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.map((e) => e.turn)).toEqual([0, 1, 1, 2, 2]);
    expect(entries[2]).toMatchObject({ type: 'tool_call', tool: 'write_file', isError: false, input: { path: '/workspace/MOCK_RUN.txt' } });
    expect(typeof entries[2].output).toBe('string');
    expect(entries[1]).toMatchObject({ type: 'model_call', stopReason: 'tool_use', usage: { usageEstimated: true } });
    expect(typeof entries[1].usage.totalTokens).toBe('number');
  });

  it('sends system prompt with skills, tools and the task with inline spec', async () => {
    const p = new MockProvider();
    const c = cfg();
    await runAgent({
      config: c,
      provider: p,
      tracker: tracker(),
      sandbox: new FakeSandbox(),
      inlineSpec: [{ name: 'requirements.md', content: 'REQ BODY' }],
      designImage: { name: 'design.png', image: { mediaType: 'image/png', dataBase64: 'AAAA' } },
    });
    const req = p.requests[0];
    expect(req.system).toBe(buildSystemPrompt(c));
    expect(req.system).toMatch(/# Skill: fullstack-checklist/);
    expect(req.tools?.map((t) => t.name)).toContain('run_command');
    const first = req.messages[0];
    expect(first.content[0].type === 'text' && first.content[0].text).toMatch(/<file path="\/spec\/requirements.md">\nREQ BODY/);
    expect(first.content.some((b) => b.type === 'image')).toBe(true);
    expect(req.promptCaching).toBe(true);
  });

  it('write-files-from-dir pushes a directory through write_file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'src-'));
    mkdirSync(join(dir, 'backend'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'backend', 'server.js'), 'console.log(1)');
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'skip');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2]));
    const sb = new FakeSandbox();
    const r = await runAgent({
      config: cfg(),
      provider: new MockProvider({ type: 'write-files-from-dir', dir, filesPerTurn: 1, commands: ['npm run build'] }),
      tracker: tracker(),
      sandbox: sb,
    });
    expect(r.status).toBe('completed');
    expect([...sb.files.keys()].sort()).toEqual(['/workspace/backend/server.js', '/workspace/package.json']);
    expect(sb.commands).toContain('npm run build');
  });

  it('enforces maxModelCalls', async () => {
    const r = await runAgent({
      config: cfg({ limits: { maxModelCalls: 5, maxTotalTokens: 1e9, maxRuntimeSec: 600 } }),
      provider: new MockProvider({ type: 'loop' }),
      tracker: tracker(),
      sandbox: new FakeSandbox(),
    });
    expect(r).toMatchObject({ status: 'limit_exceeded', stopCause: 'max_model_calls', modelCalls: 5 });
  });

  it('enforces maxTotalTokens from recorded usage', async () => {
    const t = tracker();
    const r = await runAgent({
      config: cfg({ limits: { maxModelCalls: 1000, maxTotalTokens: 20_000, maxRuntimeSec: 600 } }),
      provider: new MockProvider({ type: 'loop' }),
      tracker: t,
      sandbox: new FakeSandbox(),
    });
    expect(r.status).toBe('limit_exceeded');
    expect(r.stopCause).toBe('max_total_tokens');
    expect(t.totals().totalTokens).toBeGreaterThanOrEqual(20_000);
  });

  it('enforces maxRuntimeSec via the clock', async () => {
    let clock = 0;
    const sb = new FakeSandbox();
    sb.onExec = () => {
      clock += 4000;
      return undefined;
    };
    const r = await runAgent({
      config: cfg({ limits: { maxModelCalls: 1000, maxTotalTokens: 1e9, maxRuntimeSec: 10 } }),
      provider: new MockProvider({ type: 'loop' }),
      tracker: tracker(),
      sandbox: sb,
      now: () => clock,
    });
    expect(r).toMatchObject({ status: 'limit_exceeded', stopCause: 'max_runtime' });
  });

  it('stops on abort signal', async () => {
    const ac = new AbortController();
    const sb = new FakeSandbox();
    let n = 0;
    sb.onExec = () => {
      if (++n === 3) ac.abort();
      return undefined;
    };
    const r = await runAgent({ config: cfg(), provider: new MockProvider({ type: 'loop' }), tracker: tracker(), sandbox: sb, signal: ac.signal });
    expect(r.status).toBe('interrupted');
  });

  it('feeds tool errors back to the model and keeps going', async () => {
    const p = new MockProvider({
      type: 'steps',
      steps: [
        { content: [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: '/etc/passwd', content: 'x' } }] },
        { content: [{ type: 'tool_use', id: 't2', name: 'no_such_tool', input: {} }] },
        { content: [{ type: 'tool_use', id: 't3', name: 'read_file', input: { path: 'missing' } }] },
        { content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const r = await runAgent({ config: cfg(), provider: p, tracker: tracker(), sandbox: new FakeSandbox() });
    expect(r).toMatchObject({ status: 'completed', toolCalls: 3, toolErrors: 3, finalText: 'done' });
    const results = p.requests[1].messages.at(-1)!.content;
    expect(results[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: true });
  });

  it('provider failure → infra_error, not a throw', async () => {
    const p = new MockProvider({ type: 'steps', steps: [{ content: [], error: 'API down' }] });
    const r = await runAgent({ config: cfg(), provider: p, tracker: tracker(), sandbox: new FakeSandbox() });
    expect(r.status).toBe('infra_error');
    expect(r.failureReason).toMatch(/API down/);
  });

  it('handles max_tokens: skips the possibly truncated last tool call, gives up after 3', async () => {
    const tu = (id: string) => ({ type: 'tool_use' as const, id, name: 'write_file', input: { path: `${id}.txt`, content: 'x' } });
    const p = new MockProvider({
      type: 'steps',
      steps: [
        { content: [tu('a'), tu('b')], stopReason: 'max_tokens' },
        { content: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' },
        { content: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' },
      ],
    });
    const sb = new FakeSandbox();
    const r = await runAgent({ config: cfg(), provider: p, tracker: tracker(), sandbox: sb });
    expect(sb.files.has('/workspace/a.txt')).toBe(true);
    expect(sb.files.has('/workspace/b.txt')).toBe(false);
    expect(r.status).toBe('agent_error');
    expect(r.failureReason).toMatch(/max_tokens/);
  });

  it('summarize strategy compacts with a compaction call recorded under the coding role', async () => {
    const t = tracker();
    const r = await runAgent({
      config: cfg({ context: { strategy: 'summarize', compactAtTokens: 1000 }, limits: { maxModelCalls: 8, maxTotalTokens: 1e9, maxRuntimeSec: 600 } }),
      provider: new MockProvider({ type: 'loop' }),
      tracker: t,
      sandbox: new FakeSandbox(),
    });
    expect(r.compactions).toBeGreaterThan(0);
    expect(t.records().some((x) => x.purpose === 'compaction' && x.role === 'coding')).toBe(true);
    expect(JSON.stringify(r.messages[0])).toMatch(/progress_summary/);
  });

  it('summarize-tool-output is recorded with its purpose', async () => {
    const t = tracker();
    const sb = new FakeSandbox();
    sb.onExec = () => ({ stdout: 'z'.repeat(5000) });
    const c = cfg({ tools: [{ name: 'run_command', enabled: true, maxOutputChars: 300, outputMode: 'summarize' }] });
    await runAgent({
      config: c,
      provider: new MockProvider({ type: 'steps', steps: [{ content: [{ type: 'tool_use', id: 'x', name: 'run_command', input: { command: 'ls' } }] }, { content: [{ type: 'text', text: 'ok' }] }] }),
      tracker: t,
      sandbox: sb,
    });
    expect(t.records().map((x) => x.purpose)).toEqual(['agent-turn', 'summarize-tool-output', 'agent-turn']);
  });

  it('enforces the du-based disk limit', async () => {
    const sb = new FakeSandbox();
    sb.onExec = (cmd) => (cmd.startsWith('du ') ? { stdout: String(5000 * 1024) } : undefined);
    const r = await runAgent({ config: cfg(), provider: new MockProvider({ type: 'loop' }), tracker: tracker(), sandbox: sb, diskLimitMB: 100, diskCheckEvery: 2 });
    expect(r).toMatchObject({ status: 'limit_exceeded', stopCause: 'disk_limit' });
  });
});

describe('context helpers', () => {
  it('dropOldToolResults keeps the most recent N and strips providerState', () => {
    const msgs: Message[] = [buildInitialUserMessage({})];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }], providerState: { provider: 'anthropic', model: 'm', content: [{}] } });
      msgs.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `t${i}`, content: `out${i}` }, { type: 'image', mediaType: 'image/png', dataBase64: 'A' }] });
    }
    expect(dropOldToolResults(msgs, 2)).toBe(3);
    const contents = msgs.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (b as any).content);
    expect(contents).toEqual([DROPPED_TOOL_RESULT, DROPPED_TOOL_RESULT, DROPPED_TOOL_RESULT, 'out3', 'out4']);
    expect(msgs.every((m) => !m.providerState)).toBe(true);
    expect(msgs[2].content.some((b) => b.type === 'image')).toBe(false);
    expect(msgs[10].content.some((b) => b.type === 'image')).toBe(true);
    expect(dropOldToolResults(msgs, 2)).toBe(0);
  });
});
