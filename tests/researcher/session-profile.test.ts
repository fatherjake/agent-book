import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSessionProfile,
  classifyHookResponse,
  detectHookOutput,
  detectUnusedTools,
  pngDimensions,
  renderProfileMarkdown,
  shellFileOps,
  writeSessionProfile,
  type SessionProfile,
} from '../../researcher/session-profile.js';
import { REPO_ROOT, SPEC_DIR } from '../../runner/env.js';

// Real claude-code baseline run (2026-11-15), copied with base64 image payloads shortened to 200 chars
// (the PNG header, which carries the dimensions, is kept) and rate_limit_event lines removed.
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'session-profile', 'run-20261115-072840-480e46');
const SUBAGENT_STREAM = join(REPO_ROOT, 'tests', 'runner', 'fixtures', 'claude-stream-subagent.jsonl');

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const readJsonl = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------
// Synthetic run builder
// ---------------------------------------------------------------------------

let seq = 0;
function rec(input: number, cacheRead: number, cacheWrite: number, output: number, extra: Record<string, unknown> = {}) {
  return {
    id: `u${++seq}`,
    role: 'coding',
    runId: 'synthetic',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    timestamp: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: 0,
    reasoningIncludedInOutput: true,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    costUsd: 0.01,
    costEstimated: true,
    usageEstimated: false,
    purpose: 'agent-turn',
    raw: { output_tokens_details: { thinking_tokens: (extra.thinking as number) ?? 0 } },
    ...extra,
  };
}

interface Turn {
  usage: ReturnType<typeof rec>;
  tools?: { name: string; input: Record<string, unknown>; output: string; isError?: boolean }[];
  text?: string;
  parent?: string;
}

/** Builds usage.jsonl + claude-stream.jsonl from turns; returns the run dir. */
function synthRun(turns: Turn[], opts: { tools?: string[]; extraUsage?: ReturnType<typeof rec>[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-profile-'));
  tmpDirs.push(dir);
  const events: unknown[] = [{ type: 'system', subtype: 'init', tools: opts.tools ?? ['Bash', 'Read', 'Write', 'Edit'], skills: [], claude_code_version: '2.1.325' }];
  let tu = 0;
  turns.forEach((t, i) => {
    const u = t.usage;
    const content: unknown[] = [];
    if (t.text) content.push({ type: 'text', text: t.text });
    const ids: string[] = [];
    for (const tool of t.tools ?? []) {
      const id = `toolu_${++tu}`;
      ids.push(id);
      content.push({ type: 'tool_use', id, name: tool.name, input: tool.input });
    }
    events.push({
      type: 'assistant',
      parent_tool_use_id: t.parent ?? null,
      message: {
        id: `msg_${i}`,
        model: u.model,
        content,
        stop_reason: t.tools?.length ? 'tool_use' : 'end_turn',
        usage: { input_tokens: u.inputTokens, cache_read_input_tokens: u.cacheReadTokens, cache_creation_input_tokens: u.cacheWriteTokens, output_tokens: 1 },
      },
    });
    (t.tools ?? []).forEach((tool, k) =>
      events.push({ type: 'user', parent_tool_use_id: t.parent ?? null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ids[k], content: tool.output, is_error: tool.isError ?? false }] } }),
    );
  });
  events.push({ type: 'result', subtype: 'success', result: turns[turns.length - 1].text ?? '' });
  const usage = [...turns.map((t) => t.usage), ...(opts.extraUsage ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeFileSync(join(dir, 'usage.jsonl'), usage.map((u) => JSON.stringify(u)).join('\n') + '\n');
  writeFileSync(join(dir, 'claude-stream.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'synthetic', configId: 'test', status: 'completed', backend: 'claude-code', usedMockProvider: false }));
  return dir;
}

const kinds = (p: SessionProfile) => p.waste.map((w) => w.kind);

// ---------------------------------------------------------------------------
// Real run fixture
// ---------------------------------------------------------------------------

describe('buildSessionProfile on a real claude-code run', () => {
  const p = buildSessionProfile(FIXTURE, { specDir: SPEC_DIR });
  const usage = readJsonl(join(FIXTURE, 'usage.jsonl'));

  it('takes every token figure from usage.jsonl', () => {
    expect(p.backend).toBe('claude-code');
    expect(p.totals.modelCalls).toBe(usage.length);
    expect(p.totals.totalTokens).toBe(usage.reduce((a: number, r: any) => a + r.totalTokens, 0));
    expect(p.totals.totalTokens).toBe(161_546);
    expect(p.totals.cacheReadTokens).toBe(usage.reduce((a: number, r: any) => a + r.cacheReadTokens, 0));
    expect(p.totals.outputTokens).toBe(usage.reduce((a: number, r: any) => a + r.outputTokens, 0));
    p.calls.forEach((c, i) => {
      expect(c.outputTokens).toBe(usage[i].outputTokens); // gateway, not the stream's partial count
      expect(c.contextTokens).toBe(usage[i].inputTokens + usage[i].cacheReadTokens + usage[i].cacheWriteTokens);
    });
    expect(p.byPurpose['agent-turn'].calls).toBe(5);
  });

  it('joins every stream message to a usage record and computes context deltas', () => {
    expect(p.sources).toMatchObject({ usage: true, stream: true, joined: 5, unjoinedUsageRecords: 0, unjoinedMessages: 0 });
    expect(p.calls.every((c) => c.joined)).toBe(true);
    expect(p.calls[0].contextDelta).toBeNull();
    expect(p.calls[1].contextDelta).toBe(p.calls[1].contextTokens - p.calls[0].contextTokens);
    expect(p.calls[0].tools).toEqual(['Bash', 'Read']);
    expect(p.calls[4].tools).toEqual([]);
  });

  it('profiles tool calls with estimated output tokens and carried cost', () => {
    expect(p.tools).toHaveLength(5);
    const img = p.tools.find((t) => t.name === 'Read')!;
    expect(img.inputSummary).toBe('/spec/design.png');
    expect(img.images).toBe(1);
    expect(img.outputTokensEst).toBe(Math.ceil((1280 * 800) / 750));
    expect(img.remainingCalls).toBe(4);
    expect(img.carriedTokensEst).toBe(img.outputTokensEst * 4);
    const failed = p.tools.find((t) => t.isError)!;
    expect(failed.name).toBe('Bash');
    expect(failed.outputTokensEst).toBe(Math.ceil(failed.outputChars / 4));
    const build = p.tools.filter((t) => t.isBuild);
    expect(build).toHaveLength(1);
    expect(p.tools.find((t) => t.writes.includes('/workspace/backend/server.js'))?.writeKind).toBe('whole-file');
  });

  it('estimates fixed overhead from the first call minus the rebuilt task prompt', () => {
    const o = p.overhead;
    expect(o.firstCallContextTokens).toBe(p.calls[0].contextTokens);
    expect(o.userPromptChars).toBeGreaterThan(20_000); // task text + 3 inline spec files
    expect(o.fixedOverheadTokensEst).toBe(o.firstCallContextTokens! - o.userPromptTokensEst!);
    expect(o.overheadReReadTokensEst).toBe(o.fixedOverheadTokensEst! * 4);
    expect(o.overheadShareOfTotal).toBeGreaterThan(0.4);
    expect(o.overheadShareOfTotal).toBeLessThan(1);
  });

  it('flags the error → retry loop with the exact cost of the extra turn', () => {
    const w = p.waste.find((x) => x.kind === 'error-retry')!;
    expect(w).toBeDefined();
    expect(w.tokens).toBe(usage[1].totalTokens);
    expect(w.tokensEstimated).toBe(false);
    expect(w.evidence.join('\n')).toContain('retry #2');
    expect(kinds(p)).toContain('unused-tools');
    expect(kinds(p)).toContain('final-summary');
    expect(p.finalSummary?.outputTokens).toBe(usage[4].outputTokens);
  });

  it('renders compact markdown within the default and custom caps', () => {
    const md = renderProfileMarkdown(p);
    expect(md.length).toBeLessThanOrEqual(6000);
    expect(md.length).toBeGreaterThan(1500);
    expect(md).toContain('161.5k');
    expect(md).toContain('error-retry');
    expect(md).toContain('/spec/design.png');
    expect(md).toContain('#5 ctx');
    const small = renderProfileMarkdown(p, { maxChars: 1200 });
    expect(small.length).toBeLessThanOrEqual(1200);
    expect(small).toContain('Total 161.5k');
  });

  it('timeline has one line per call', () => {
    expect(p.timeline).toHaveLength(5);
    expect(p.timeline[0]).toMatch(/^#1 ctx 26\.1k/);
  });

  it('writeSessionProfile writes profile.json and profile.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frugal-profile-'));
    tmpDirs.push(dir);
    for (const f of ['usage.jsonl', 'claude-stream.jsonl', 'trace.jsonl', 'run.json']) copyFileSync(join(FIXTURE, f), join(dir, f));
    writeSessionProfile(dir, { specDir: SPEC_DIR });
    expect(existsSync(join(dir, 'profile.md'))).toBe(true);
    const j = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
    expect(j.totals.totalTokens).toBe(161_546);
    expect(j.version).toBe(1);
  });
});

describe('api backend (trace.jsonl, no stream)', () => {
  it('builds totals and per-call data from usage.jsonl + trace.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frugal-profile-'));
    tmpDirs.push(dir);
    const u1 = rec(5000, 0, 0, 300);
    const u2 = rec(6200, 0, 0, 120);
    writeFileSync(join(dir, 'usage.jsonl'), [u1, u2].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const trace = [
      { type: 'start', configId: 'baseline-api', model: 'claude-sonnet-5-5', tools: ['read_file', 'run_command', 'write_file'], systemChars: 4000 },
      { type: 'model_call', turn: 1, purpose: 'agent-turn', usage: { inputTokens: 5000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, text: '', toolUses: [{ id: 't1', name: 'run_command' }] },
      { type: 'tool_call', turn: 1, id: 't1', tool: 'run_command', input: { command: 'npm run build' }, isError: true, returnedChars: 4800, output: 'error TS2345' },
      { type: 'model_call', turn: 2, purpose: 'agent-turn', usage: { inputTokens: 6200, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 }, text: 'Done.', toolUses: [] },
    ];
    writeFileSync(join(dir, 'trace.jsonl'), trace.map((x) => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'api-run', configId: 'baseline-api', status: 'completed', usedMockProvider: false }));
    const p = buildSessionProfile(dir);
    expect(p.backend).toBe('api');
    expect(p.sources.stream).toBe(false);
    expect(p.totals.totalTokens).toBe(u1.totalTokens + u2.totalTokens);
    expect(p.calls.map((c) => c.joined)).toEqual([true, true]);
    expect(p.calls[1].contextDelta).toBe(1200);
    expect(p.tools[0]).toMatchObject({ name: 'run_command', outputChars: 4800, outputTokensEst: 1200, isError: true, isBuild: true, remainingCalls: 1 });
    expect(p.overhead.fixedOverheadTokensEst).toBe(1000);
    expect(renderProfileMarkdown(p)).toContain('run_command');
  });
});

// ---------------------------------------------------------------------------
// Waste detectors on small synthetic streams
// ---------------------------------------------------------------------------

describe('waste detectors', () => {
  it('repeated reads of the same file (Read tool and cat)', () => {
    const p = buildSessionProfile(
      synthRun([
        { usage: rec(2, 0, 10_000, 50), tools: [{ name: 'Read', input: { file_path: '/spec/requirements.md' }, output: 'x'.repeat(4000) }] },
        { usage: rec(2, 10_000, 1000, 50), tools: [{ name: 'Bash', input: { command: 'cd /spec; cat requirements.md api-contract.yaml' }, output: 'y'.repeat(4000) }] },
        { usage: rec(2, 11_000, 1000, 50), tools: [{ name: 'Read', input: { file_path: '/spec/requirements.md' }, output: 'x'.repeat(4000) }] },
        { usage: rec(2, 12_000, 1000, 80), text: 'done' },
      ]),
    );
    const w = p.waste.find((x) => x.kind === 'repeated-read')!;
    expect(w.title).toContain('/spec/requirements.md read 3×');
    expect(w.evidence).toHaveLength(3);
    expect(w.tokensEstimated).toBe(true);
    expect(p.waste.some((x) => x.kind === 'repeated-read' && x.title.includes('api-contract'))).toBe(false);
  });

  it('error → fix loops, repeated builds, large outputs', () => {
    const big = 'E'.repeat(9000);
    const p = buildSessionProfile(
      synthRun([
        { usage: rec(2, 0, 10_000, 50), tools: [{ name: 'Bash', input: { command: 'npm run build' }, output: big, isError: true }] },
        { usage: rec(2, 10_000, 2300, 400), tools: [{ name: 'Edit', input: { file_path: '/workspace/a.js', old_string: 'a', new_string: 'b' }, output: 'ok' }] },
        { usage: rec(2, 12_300, 100, 50), tools: [{ name: 'Bash', input: { command: 'cd /workspace && npm run build 2>&1 | tail -5' }, output: 'built' }] },
        { usage: rec(2, 12_400, 100, 60), text: 'Built.' },
      ]),
      { largeOutputChars: 6000 },
    );
    const retry = p.waste.find((x) => x.kind === 'error-retry')!;
    expect(retry.title).toContain('#1 → #3');
    expect(retry.tokens).toBe(p.calls[1].totalTokens + p.calls[2].totalTokens);
    const builds = p.waste.find((x) => x.kind === 'repeated-build')!;
    expect(builds.title).toBe('build run 2×');
    const large = p.waste.find((x) => x.kind === 'large-output')!;
    expect(large.tokens).toBe(Math.ceil(9000 / 4) * 3);
  });

  it('whole-file rewrites vs edits', () => {
    const p = buildSessionProfile(
      synthRun([
        { usage: rec(2, 0, 10_000, 3000), tools: [{ name: 'Write', input: { file_path: '/workspace/App.jsx', content: 'a'.repeat(8000) }, output: 'File created' }] },
        { usage: rec(2, 10_000, 200, 3000), tools: [{ name: 'Bash', input: { command: "cat > /workspace/App.jsx <<'EOF'\n" + 'b'.repeat(8000) + '\nEOF' }, output: '' }] },
        { usage: rec(2, 10_200, 200, 50), text: 'ok' },
      ]),
    );
    const w = p.waste.find((x) => x.kind === 'whole-file-rewrite')!;
    expect(w.title).toContain('/workspace/App.jsx written whole 2×');
    expect(w.severity).toBe('medium');
  });

  it('subagent spawns and their cost; unjoined records are reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frugal-profile-'));
    tmpDirs.push(dir);
    copyFileSync(SUBAGENT_STREAM, join(dir, 'claude-stream.jsonl'));
    // Usage matching the fixture's request-side numbers, plus one subagent turn the stream does not echo.
    const recs = [rec(2, 10_751, 5850, 120), rec(2, 0, 11_032, 40), rec(2, 11_032, 30, 25), rec(2, 16_601, 420, 4)];
    writeFileSync(join(dir, 'usage.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const p = buildSessionProfile(dir);
    expect(p.sources.joined).toBe(3);
    expect(p.sources.unjoinedUsageRecords).toBe(1);
    expect(p.calls[1].purpose).toBe('subagent');
    expect(p.byPurpose.subagent.calls).toBe(1);
    const w = p.waste.find((x) => x.kind === 'subagent')!;
    expect(w.tokens).toBe(recs[1].totalTokens);
    expect(w.evidence[0]).toContain('general-purpose');
    expect(p.notes.join(' ')).toMatch(/no matching stream message/);
  });

  it('thinking volume, no-tool turns, background calls, final summary', () => {
    const p = buildSessionProfile(
      synthRun(
        [
          { usage: rec(2, 0, 10_000, 2000, { thinking: 1500, reasoningTokens: 1500 }), text: 'Let me plan this out.' },
          { usage: rec(2, 10_000, 500, 100), tools: [{ name: 'Bash', input: { command: 'ls' }, output: 'a' }] },
          { usage: rec(2, 10_500, 100, 900), text: 'S'.repeat(2500) },
        ],
        { extraUsage: [rec(300, 0, 0, 20, { model: 'claude-haiku-5-5', purpose: 'background' })] },
      ),
    );
    expect(p.waste.find((x) => x.kind === 'thinking')!.tokens).toBe(1500);
    const idle = p.waste.find((x) => x.kind === 'no-tool-turn')!;
    expect(idle.title).toContain('1 non-final turn');
    expect(idle.evidence[0]).toMatch(/^#1:/);
    expect(p.waste.find((x) => x.kind === 'background-calls')!.tokens).toBe(320);
    expect(p.calls.find((c) => c.purpose === 'background')!.thread).toBe('background');
    const fs = p.waste.find((x) => x.kind === 'final-summary')!;
    expect(fs.title).toContain('2500 chars');
    expect(fs.severity).toBe('low');
    expect(p.totals.thinkingTokens).toBe(1500);
  });

  it('unused tool definitions', () => {
    expect(detectUnusedTools(['Bash', 'Read'], [])).toEqual([]);
    const w = detectUnusedTools(['Bash', 'Read', 'Write', 'Edit', 'Task', 'WebFetch'], [{ name: 'Bash' } as any]);
    expect(w[0].title).toBe('5/6 tool definitions loaded but never used');
  });
});

describe('hooks', () => {
  const ev = (stdout: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'hook_response', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse', stdout, stderr: '', exit_code: 0, ...extra });

  it('classifies hook output: injected vs replacement vs not shown', () => {
    const h = { name: 'x', runs: 0, injectedChars: 0, replacements: 0, replacementChars: 0, systemMessageChars: 0, plainStdoutChars: 0, blockingExits: 0, measuredReplacements: 0, origChars: 0, newChars: 0 };
    classifyHookResponse(ev(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'a'.repeat(1700) } })), h);
    classifyHookResponse(ev(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls' } } })), h);
    classifyHookResponse(ev(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'b'.repeat(300) }, systemMessage: 'note' })), h);
    classifyHookResponse(ev(JSON.stringify({ decision: 'block', reason: 'c'.repeat(40) })), h);
    classifyHookResponse(ev('', { stderr: 'd'.repeat(25), exit_code: 2 }), h);
    classifyHookResponse(ev('plain text log'), h);
    classifyHookResponse(ev('', { stderr: 'frugal: orig_chars=5000 new_chars=2030\n' }), h);
    expect(h).toMatchObject({ runs: 7, measuredReplacements: 1, origChars: 5000, newChars: 2030, replacements: 2, replacementChars: 1700 + JSON.stringify({ command: 'ls' }).length, injectedChars: 300 + 40 + 25, systemMessageChars: 4, plainStdoutChars: 14, blockingExits: 1 });
  });

  it('hook-output waste counts only injected text; configAudit is passed through', () => {
    const dir = synthRun([
      { usage: rec(2, 0, 10_000, 50), tools: [{ name: 'Bash', input: { command: 'seq 1 5000' }, output: 'trimmed' }] },
      { usage: rec(2, 10_000, 300, 40), text: 'done' },
    ]);
    const stream = join(dir, 'claude-stream.jsonl');
    const replace = ev(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'x'.repeat(1700) } }), { output: 'dup' });
    writeFileSync(stream, readFileSync(stream, 'utf8') + JSON.stringify(replace) + '\n');
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'synthetic', status: 'agent_error', backend: 'claude-code', configAudit: { flagged: true, reasons: ['bin wrote source'] } }));
    let p = buildSessionProfile(dir);
    expect(p.hooks[0]).toMatchObject({ name: 'PostToolUse:Bash', runs: 1, replacements: 1, replacementChars: 1700, injectedChars: 0 });
    expect(p.waste.some((w) => w.kind === 'hook-output')).toBe(false);
    expect(p.configAudit).toEqual({ flagged: true, reasons: ['bin wrote source'] });
    const md = renderProfileMarkdown(p);
    expect(md).toContain('PostToolUse:Bash ×1 (1 replacement(s), 1700 chars)');
    expect(md).toContain('CONFIG AUDIT FLAGGED');

    const inject = ev(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'y'.repeat(500) } }));
    writeFileSync(stream, readFileSync(stream, 'utf8') + JSON.stringify(inject) + '\n');
    p = buildSessionProfile(dir);
    expect(p.waste.find((w) => w.kind === 'hook-output')!.tokens).toBe(125);
    expect(detectHookOutput([{ ...p.hooks[0], injectedChars: 0 }])).toEqual([]);
  });
});

describe('hook trim savings', () => {
  it('pairs a PostToolUse size line with the next tool result and estimates carried savings', () => {
    const dir = synthRun([
      { usage: rec(2, 0, 10_000, 50), tools: [{ name: 'Bash', input: { command: 'seq 1 5000' }, output: 'z'.repeat(2030) }] },
      { usage: rec(2, 10_000, 600, 50), tools: [{ name: 'Bash', input: { command: 'ls' }, output: 'a' }] },
      { usage: rec(2, 10_600, 100, 40), text: 'done' },
    ]);
    const stream = join(dir, 'claude-stream.jsonl');
    const lines = readFileSync(stream, 'utf8').trim().split('\n');
    const firstResult = lines.findIndex((l) => l.includes('"tool_result"'));
    const hook = { type: 'system', subtype: 'hook_response', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse', exit_code: 0, stderr: 'frugal: orig_chars=5000 new_chars=2030', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'z'.repeat(2030) } }) };
    lines.splice(firstResult, 0, JSON.stringify(hook));
    writeFileSync(stream, lines.join('\n') + '\n');
    const p = buildSessionProfile(dir);
    expect(p.tools[0].hookTrim).toEqual({ origChars: 5000, newChars: 2030, savedTokensEst: Math.ceil(2970 / 4), savedCarriedTokensEst: Math.ceil(2970 / 4) * 2 });
    expect(p.tools[1].hookTrim).toBeUndefined();
    expect(p.hookSavings).toEqual({ measured: 1, unmeasuredReplacements: 0, savedChars: 2970, savedTokensEst: 743, savedCarriedTokensEst: 1486 });
    expect(renderProfileMarkdown(p)).toContain('Hook trims (est.): 1 measured, saved 2.97k chars');
    expect(p.waste.some((w) => w.kind === 'hook-output')).toBe(false);
  });
});

describe('hook trim pairing by tool_use_id', () => {
  it('pairs exactly by id even when the hook line arrives out of order; falls back to order without it', () => {
    const dir = synthRun([
      {
        usage: rec(2, 0, 10_000, 50),
        tools: [
          { name: 'Bash', input: { command: 'seq 1 100' }, output: 'p' },
          { name: 'Bash', input: { command: 'seq 1 9000' }, output: 'q'.repeat(1000) },
        ],
      },
      { usage: rec(2, 10_000, 600, 50), tools: [{ name: 'Bash', input: { command: 'cat big.log' }, output: 'r'.repeat(500) }] },
      { usage: rec(2, 10_600, 100, 40), text: 'done' },
    ]);
    const stream = join(dir, 'claude-stream.jsonl');
    const lines = readFileSync(stream, 'utf8').trim().split('\n');
    const hook = (stderr: string) => JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse', exit_code: 0, stdout: '', stderr });
    // The id-tagged line for toolu_2 comes BEFORE toolu_1's result; order pairing would mis-attribute it.
    const first = lines.findIndex((l) => l.includes('"tool_result"'));
    lines.splice(first, 0, hook('frugal: orig_chars=9000 new_chars=1000 tool_use_id=toolu_2'));
    // An untagged (legacy) line just before toolu_3's result.
    const third = lines.findIndex((l) => l.includes('"tool_use_id":"toolu_3"'));
    lines.splice(third, 0, hook('frugal: orig_chars=4000 new_chars=500'));
    writeFileSync(stream, lines.join('\n') + '\n');
    const p = buildSessionProfile(dir);
    const byId = Object.fromEntries(p.tools.map((t) => [t.id, t.hookTrim]));
    expect(byId.toolu_1).toBeUndefined();
    expect(byId.toolu_2).toMatchObject({ origChars: 9000, newChars: 1000, savedTokensEst: 2000, savedCarriedTokensEst: 4000 });
    expect(byId.toolu_3).toMatchObject({ origChars: 4000, newChars: 500, savedTokensEst: 875, savedCarriedTokensEst: 875 });
    expect(p.hookSavings).toMatchObject({ measured: 2, savedChars: 11_500, savedTokensEst: 2875 });
  });
});

describe('helpers', () => {
  it('shellFileOps parses reads, redirects, heredocs and cd', () => {
    expect(shellFileOps('cd /workspace; cat package.json frontend/index.html | head -50')).toEqual({ reads: ['/workspace/package.json', '/workspace/frontend/index.html'], writes: [] });
    const h = shellFileOps("cd /workspace/frontend/src; cat > main.jsx <<'EOF'\ncat secret.txt\nEOF\nnpm run build > /tmp/b.log 2>&1");
    expect(h.writes).toEqual(['/workspace/frontend/src/main.jsx', '/tmp/b.log']);
    expect(h.reads).toEqual([]);
    expect(shellFileOps('head -n 40 src/a.ts && sed -n 1,20p src/b.ts').reads).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('pngDimensions reads the IHDR header', () => {
    const png = readFileSync(join(SPEC_DIR, 'design.png')).toString('base64');
    expect(pngDimensions(png)).toEqual({ width: 1280, height: 800 });
    expect(pngDimensions('bm90IGEgcG5n')).toBeNull();
  });
});
