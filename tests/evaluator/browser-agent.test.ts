/**
 * Browser-agent TOOL LAYER tests.
 *
 * !!! Uses a SCRIPTED FAKE PROVIDER (a mock, not a real model). These tests only prove that the
 * tool plumbing (snapshot/refs, screenshot images, click/type/press, trace, limits, verdict)
 * works against a real Chromium page. They do NOT validate the browser agent with a real model.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContentBlock, ModelProvider, ModelRequest, ModelResponse } from '../../runner/types.js';
import {
  BrowserTools,
  BROWSER_TOOL_SPECS,
  runAgentLoop,
  runBrowserAgentScenarios,
  TraceWriter,
} from '../../evaluator/browser-agent.js';
import type { LaunchedApp } from '../../evaluator/app-launcher.js';
import { buildVariant } from '../../evaluator/fixtures.js';

const PAGE = `<!doctype html><html><body>
<h1>Todos</h1>
<form id="f"><label for="n">New todo</label><input id="n"><button>Add</button></form>
<ul aria-label="Todo list" id="l"></ul>
<script>
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = document.getElementById('n').value.trim();
  if (!v) return;
  const li = document.createElement('li');
  li.innerHTML = '<input type="checkbox" aria-label="Toggle ' + v + '"> <span>' + v + '</span>';
  document.getElementById('l').appendChild(li);
  document.getElementById('n').value = '';
});
</script></body></html>`;

/** MOCK provider: replays a script; each step may inspect the conversation so far. */
class ScriptedFakeProvider implements ModelProvider {
  readonly name = 'scripted-fake';
  readonly isMock = true;
  calls: ModelRequest[] = [];
  constructor(private readonly steps: Array<(req: ModelRequest) => ContentBlock[]>) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(JSON.parse(JSON.stringify(req)));
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)];
    const content = step(req);
    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: {
        provider: 'mock',
        model: req.model,
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 0,
        reasoningIncludedInOutput: true,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 110,
        costUsd: 0,
        costEstimated: true,
        usageEstimated: true,
        raw: null,
      },
    };
  }
}

let n = 0;
const call = (name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: 'tool_use', id: `t${++n}`, name, input });

/** Find the ref of `checkbox "<name>"` in the latest snapshot tool result. */
function refFromSnapshot(req: ModelRequest, name: string): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    for (const b of req.messages[i].content) {
      if (b.type === 'tool_result' && b.content.includes('URL:')) {
        const m = new RegExp(`checkbox "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(b.content);
        if (m) return m[1];
      }
    }
  }
  throw new Error(`ref for ${name} not found`);
}

describe('browser agent tool layer (scripted fake provider — MOCK)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let url = '';
  let browser: Browser;
  let page: Page;
  let dir = '';

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-agent-test-'));
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await ctx.newPage();
    await page.goto(url);
  });

  it('exposes the documented tools', () => {
    expect(BROWSER_TOOL_SPECS.map((t) => t.name).sort()).toEqual(
      ['click', 'finish', 'goto', 'press', 'reload', 'screenshot', 'select_option', 'snapshot', 'type'].sort(),
    );
  });

  it('drives a page via snapshot refs and role+name, returns images and a verdict, writes a trace', async () => {
    const tools = new BrowserTools(page, url, path.join(dir, 'shots'), 'agent-test');
    const provider = new ScriptedFakeProvider([
      () => [{ type: 'text', text: 'Let me look.' }, call('snapshot')],
      () => [call('type', { role: 'textbox', name: 'New todo', text: 'Buy milk', submit: true })],
      () => [call('snapshot')],
      (req) => [call('click', { ref: refFromSnapshot(req, 'Toggle Buy milk') })],
      () => [call('screenshot')],
      () => [call('screenshot')],
      () => [call('screenshot')],
      () => [call('finish', { success: true, observations: 'Added and checked Buy milk.' })],
    ]);
    const trace = new TraceWriter(path.join(dir, 'browser-trace.jsonl'));
    const res = await runAgentLoop({
      provider,
      model: 'fake',
      tools,
      goal: 'Add "Buy milk" and tick it.',
      limits: { maxSteps: 20, maxTokens: 100_000, maxOutputTokensPerCall: 256 },
      trace: (e) => trace.write(e),
    });
    expect(res.stop).toBe('finished');
    expect(res.verdict).toEqual({ success: true, observations: 'Added and checked Buy milk.' });
    expect(res.steps).toBe(8);
    expect(res.tokens).toBe(8 * 110);
    // The page state really changed.
    expect(await page.getByRole('checkbox', { name: 'Toggle Buy milk' }).isChecked()).toBe(true);
    expect(tools.actionCounts).toMatchObject({ snapshot: 2, type: 1, click: 1, screenshot: 3, finish: 1 });
    // Screenshots are saved and sent as image blocks; only the 2 most recent are kept in context.
    expect(fs.readdirSync(path.join(dir, 'shots')).filter((f) => f.endsWith('.png'))).toHaveLength(3);
    const last = provider.calls[provider.calls.length - 1];
    const images = last.messages.flatMap((m) => m.content).filter((b) => b.type === 'image');
    expect(images).toHaveLength(2);
    expect(JSON.stringify(last.messages)).toContain('[older screenshot omitted]');
    const lines = fs.readFileSync(trace.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === 'tool').map((l) => l.tool)).toEqual([
      'snapshot',
      'type',
      'snapshot',
      'click',
      'screenshot',
      'screenshot',
      'screenshot',
      'finish',
    ]);
  });

  it('reports tool errors to the model instead of throwing, and blocks other origins', async () => {
    const tools = new BrowserTools(page, url, dir, 'x');
    const bad = await tools.execute('click', { role: 'button', name: 'Does not exist' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/^Error:/);
    const off = await tools.execute('goto', { path: 'https://example.com/' });
    expect(off.isError).toBe(true);
    expect((await tools.execute('nope', {})).isError).toBe(true);
    expect((await tools.execute('finish', { observations: 'x' })).isError).toBe(true);
  });

  it('stops at the step cap without a verdict', async () => {
    const tools = new BrowserTools(page, url, dir, 'cap');
    const provider = new ScriptedFakeProvider([() => [call('snapshot')]]);
    const res = await runAgentLoop({ provider, model: 'fake', tools, goal: 'loop', limits: { maxSteps: 3, maxTokens: 1e9, maxOutputTokensPerCall: 10 } });
    expect(res.stop).toBe('max_steps');
    expect(res.verdict).toBeNull();
    expect(provider.calls).toHaveLength(3);
  });

  it('stops at the token cap', async () => {
    const tools = new BrowserTools(page, url, dir, 'tok');
    const provider = new ScriptedFakeProvider([() => [call('snapshot')]]);
    const res = await runAgentLoop({ provider, model: 'fake', tools, goal: 'loop', limits: { maxSteps: 50, maxTokens: 250, maxOutputTokensPerCall: 10 } });
    expect(res.stop).toBe('max_tokens');
    expect(provider.calls).toHaveLength(3);
  });

  it('without a provider (or with the mock) every browser check is an evaluator error, never a pass', async () => {
    const fakeApp = {} as LaunchedApp; // never touched on the unavailable path
    const variant = buildVariant('dev', 1);
    const none = await runBrowserAgentScenarios({ app: fakeApp, browser, variant, provider: null, unavailableReason: 'no key', outDir: dir });
    expect(none).toHaveLength(9);
    expect(none.every((c) => c.outcome === 'error' && c.mandatory && c.category === 'browser')).toBe(true);
    expect(none[0].message).toMatch(/no key/);
    const mock = await runBrowserAgentScenarios({ app: fakeApp, browser, variant, provider: new ScriptedFakeProvider([() => []]), outDir: dir });
    expect(mock.every((c) => c.outcome === 'error')).toBe(true);
    expect(mock[0].message).toMatch(/mock provider/);
  });
});
