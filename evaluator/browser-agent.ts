/**
 * Independent LLM browser agent (TASK.md §7A).
 *
 * The agent gets HIGH-LEVEL user goals only (no selectors) and ends with a structured verdict
 * {success, observations}. Two backends drive the same scenarios and assertions:
 *  - claude-code (default, subscription): Claude Code CLI + Playwright MCP attached over CDP to a
 *    harness-owned Chromium; no built-in tools at all (see browser-agent-cc.ts).
 *  - api (only when a ModelProvider is passed explicitly, e.g. tests/infra): the built-in tool layer
 *    below over a Playwright page (snapshot with refs, screenshot, click/type/press/select, reload,
 *    same-origin goto).
 *
 * Fault injection for the "recover from API error" scenario is done by the evaluator's proxy in
 * front of the app (LaunchedApp.setFaultMode on agentUrl), not by page.route, because the MCP owns
 * the page's automation. The agent's page always uses `app.agentUrl`; harness reads use `app.url`,
 * which is never faulted.
 *
 * The verdict is NEVER trusted on its own: after each scenario the harness runs deterministic
 * assertions on the API, the DB and the DOM. A scenario passes only if those assertions pass;
 * the agent's verdict is recorded alongside. Every action, screenshot, error and outcome is
 * written to browser-trace.jsonl (+ screenshots/).
 *
 * If no real model provider is available the checks get outcome 'error' (evaluator failure, not an
 * app failure). Nothing is ever faked as a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import type { CheckResult, ContentBlock, Message, ModelProvider, ToolSpec } from '../runner/types.js';
import type { LaunchedApp } from './app-launcher.js';
import { launchAgentBrowser, runClaudeBrowserPhase, UsageLimitError, type AgentBrowser, type ClaudeCodeBrowserBackend } from './browser-agent-cc.js';
import { assert, AssertionFailure, isInfraError, trunc } from './checks.js';
import { seedTodos, type FixtureTodo, type ScenarioVariant } from './fixtures.js';
import { expectBackend, expectUi, openPage, pressedFilter, uiTodos, waitForLoaded } from './ui-helpers.js';

export const DEFAULT_BROWSER_AGENT_MODEL = 'claude-sonnet-5-5';

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export class TraceWriter {
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      /* tracing must never break evaluation */
    }
  }
}

// ---------------------------------------------------------------------------
// Tool layer (unit-tested with a scripted fake provider)
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  image?: { mediaType: 'image/png' | 'image/jpeg'; dataBase64: string; file?: string };
  /** Set by the finish tool. */
  verdict?: AgentVerdict;
}

export interface AgentVerdict {
  success: boolean;
  observations: string;
}

const targetSchema = {
  ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "e12". Preferred.' },
  role: { type: 'string', description: 'ARIA role (button, textbox, checkbox, link, ...) if no ref is given.' },
  name: { type: 'string', description: 'Accessible name used together with role.' },
};

export const BROWSER_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'snapshot',
    description:
      'Return the accessibility tree of the current page as YAML. Interactive elements have refs like [ref=e5] that other tools accept.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the visible page (returned as an image).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description: 'Click an element (button, checkbox, link, ...). Identify it by ref, or by role + name.',
    inputSchema: { type: 'object', properties: { ...targetSchema }, additionalProperties: false },
  },
  {
    name: 'type',
    description:
      'Replace the text of an input with `text`. Set submit=true to press Enter afterwards. Identify the input by ref, or by role + name.',
    inputSchema: {
      type: 'object',
      properties: { ...targetSchema, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description:
      'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "Space"). If a target is given it is focused first, otherwise the key goes to the focused element.',
    inputSchema: {
      type: 'object',
      properties: { ...targetSchema, key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'select_option',
    description: 'Select an option in a <select> element by its label or value.',
    inputSchema: {
      type: 'object',
      properties: { ...targetSchema, value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'reload',
    description: 'Reload the current page (like pressing F5).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'goto',
    description: 'Navigate to a path of the app, e.g. "/". Only the app under test is reachable.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'finish',
    description:
      'Finish the task. success = whether the goal was achieved as far as you can tell from the UI; observations = what you did and saw, including any messages the app showed.',
    inputSchema: {
      type: 'object',
      properties: { success: { type: 'boolean' }, observations: { type: 'string' } },
      required: ['success', 'observations'],
      additionalProperties: false,
    },
  },
];

const SNAPSHOT_MAX_CHARS = 12_000;
const ACTION_TIMEOUT_MS = 3000;

export class BrowserTools {
  readonly specs = BROWSER_TOOL_SPECS;
  private shotCounter = 0;
  /** Count of actions per tool (lets the harness see e.g. whether the agent reloaded). */
  readonly actionCounts: Record<string, number> = {};

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly screenshotDir: string,
    private readonly screenshotPrefix: string,
  ) {}

  private locate(input: Record<string, unknown>): Locator {
    const ref = typeof input.ref === 'string' ? input.ref.trim().replace(/^\[?ref=/, '').replace(/\]$/, '') : '';
    if (ref) return this.page.getByRef(ref);
    if (typeof input.role === 'string' && input.role) {
      const opts = typeof input.name === 'string' ? { name: input.name, exact: true } : {};
      return this.page.getByRole(input.role as Parameters<Page['getByRole']>[0], opts).first();
    }
    throw new Error('identify the element with "ref" (from snapshot) or "role" + "name"');
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    this.actionCounts[name] = (this.actionCounts[name] ?? 0) + 1;
    try {
      switch (name) {
        case 'snapshot': {
          const snap = await this.page.ariaSnapshot({ mode: 'ai', timeout: 5000 });
          const text = `URL: ${this.page.url()}\n${snap}`;
          return { content: text.length > SNAPSHOT_MAX_CHARS ? `${text.slice(0, SNAPSHOT_MAX_CHARS)}\n… (truncated)` : text };
        }
        case 'screenshot': {
          const buf = await this.page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
          fs.mkdirSync(this.screenshotDir, { recursive: true });
          const file = path.join(this.screenshotDir, `${this.screenshotPrefix}-${String(++this.shotCounter).padStart(2, '0')}.png`);
          fs.writeFileSync(file, buf);
          return { content: 'Screenshot of the current page attached.', image: { mediaType: 'image/png', dataBase64: buf.toString('base64'), file } };
        }
        case 'click':
          await this.locate(input).click({ timeout: ACTION_TIMEOUT_MS });
          await this.settle();
          return { content: 'Clicked.' };
        case 'type': {
          const loc = this.locate(input);
          await loc.fill(String(input.text ?? ''), { timeout: ACTION_TIMEOUT_MS });
          if (input.submit) await loc.press('Enter', { timeout: ACTION_TIMEOUT_MS });
          await this.settle();
          return { content: input.submit ? 'Typed text and pressed Enter.' : 'Typed text.' };
        }
        case 'press': {
          const key = String(input.key ?? '');
          if (!key) throw new Error('key is required');
          if (input.ref || input.role) await this.locate(input).press(key, { timeout: ACTION_TIMEOUT_MS });
          else await this.page.keyboard.press(key);
          await this.settle();
          return { content: `Pressed ${key}.` };
        }
        case 'select_option':
          await this.locate(input).selectOption(String(input.value ?? ''), { timeout: ACTION_TIMEOUT_MS });
          await this.settle();
          return { content: 'Selected.' };
        case 'reload':
          await this.page.reload({ waitUntil: 'networkidle', timeout: 20_000 });
          return { content: 'Page reloaded.' };
        case 'goto': {
          const p = String(input.path ?? '/');
          const target = new URL(p, this.baseUrl);
          if (target.origin !== new URL(this.baseUrl).origin) throw new Error('only the app under test can be opened');
          await this.page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 20_000 });
          return { content: `Navigated to ${target.pathname}.` };
        }
        case 'finish': {
          if (typeof input.success !== 'boolean') throw new Error('success (boolean) is required');
          return {
            content: 'Finished.',
            verdict: { success: input.success, observations: String(input.observations ?? '').slice(0, 4000) },
          };
        }
        default:
          return { content: `Unknown tool "${name}".`, isError: true };
      }
    } catch (e) {
      if (isInfraError(e)) throw e;
      return { content: `Error: ${trunc((e as Error).message.split('\n')[0], 400)}`, isError: true };
    }
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    await this.page.waitForTimeout(150);
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export const BROWSER_AGENT_SYSTEM_PROMPT = `You are a careful QA tester operating a web application through a real browser.
You can only perceive the page through your tools: "snapshot" (accessibility tree with element refs) and "screenshot".
Act like a real user: discover the controls yourself, use the visible interface, and check the result on screen after each action.
Do not assume an action worked — look. If the app shows a message (for example an error), read it and report it.
When you are done, or if the goal cannot be achieved, call "finish" with success (true/false) and concise observations.
Be efficient: prefer snapshot over screenshot, and do not repeat actions unnecessarily.`;

export interface AgentLimits {
  maxSteps: number;
  maxTokens: number;
  maxOutputTokensPerCall: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 20, maxTokens: 150_000, maxOutputTokensPerCall: 2048 };

export interface AgentRunResult {
  verdict: AgentVerdict | null;
  steps: number;
  tokens: number;
  stop: 'finished' | 'max_steps' | 'max_tokens' | 'no_tool_call';
  messages: Message[];
}

const KEEP_IMAGES = 2;

/** Replace all but the most recent screenshots with a placeholder to bound context growth. */
function pruneImages(messages: Message[]): void {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    m.content = m.content.map((b) => {
      if (b.type !== 'image') return b;
      seen++;
      return seen > KEEP_IMAGES ? ({ type: 'text', text: '[older screenshot omitted]' } as ContentBlock) : b;
    });
  }
}

export async function runAgentLoop(opts: {
  provider: ModelProvider;
  model: string;
  tools: BrowserTools;
  goal: string;
  limits: AgentLimits;
  /** Continue an earlier conversation (multi-phase scenarios). */
  history?: Message[];
  trace?: (e: Record<string, unknown>) => void;
}): Promise<AgentRunResult> {
  const messages: Message[] = [...(opts.history ?? []), { role: 'user', content: [{ type: 'text', text: `Goal: ${opts.goal}` }] }];
  let tokens = 0;
  for (let step = 1; step <= opts.limits.maxSteps; step++) {
    if (tokens >= opts.limits.maxTokens) return { verdict: null, steps: step - 1, tokens, stop: 'max_tokens', messages };
    pruneImages(messages);
    const res = await opts.provider.complete({
      model: opts.model,
      system: BROWSER_AGENT_SYSTEM_PROMPT,
      messages,
      tools: opts.tools.specs,
      maxOutputTokens: opts.limits.maxOutputTokensPerCall,
      temperature: 0,
      promptCaching: true,
      purpose: 'browser-agent',
    });
    const u = res.usage;
    tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    messages.push({ role: 'assistant', content: res.content });
    const texts = res.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text);
    const calls = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    opts.trace?.({ type: 'model', step, text: trunc(texts.join('\n'), 2000), toolCalls: calls.map((c) => ({ name: c.name, input: c.input })), tokens });
    if (!calls.length) return { verdict: null, steps: step, tokens, stop: 'no_tool_call', messages };
    const results: ContentBlock[] = [];
    const images: ContentBlock[] = [];
    let verdict: AgentVerdict | null = null;
    for (const call of calls) {
      const out = await opts.tools.execute(call.name, call.input ?? {});
      opts.trace?.({
        type: 'tool',
        step,
        tool: call.name,
        input: call.input,
        isError: !!out.isError,
        result: call.name === 'snapshot' ? trunc(out.content, 3000) : out.content,
        screenshot: out.image?.file,
      });
      results.push({ type: 'tool_result', toolUseId: call.id, content: out.content, isError: out.isError });
      if (out.image) images.push({ type: 'image', mediaType: out.image.mediaType, dataBase64: out.image.dataBase64 });
      if (out.verdict) verdict = out.verdict;
    }
    messages.push({ role: 'user', content: [...results, ...images] });
    if (verdict) return { verdict, steps: step, tokens, stop: 'finished', messages };
  }
  return { verdict: null, steps: opts.limits.maxSteps, tokens, stop: 'max_steps', messages };
}

// ---------------------------------------------------------------------------
// Scenarios: goal(s) + deterministic assertions
// ---------------------------------------------------------------------------

interface ScenarioCtx {
  /** The agent's page (shared with the MCP for the claude-code backend). */
  page: Page;
  app: LaunchedApp;
  browser: Browser;
  v: ScenarioVariant;
  seed: FixtureTodo[];
  /** api backend only. */
  tools?: BrowserTools;
}

interface AgentPhase {
  goal: (v: ScenarioVariant) => string;
  /** Harness-side setup before this phase (e.g. turn fault injection on/off). */
  before?: (c: ScenarioCtx) => Promise<void>;
  /** Deterministic assertions after this phase. Throw AssertionFailure on failure. */
  assert: (c: ScenarioCtx) => Promise<void>;
}

interface AgentScenario {
  id: string;
  seed: (v: ScenarioVariant) => FixtureTodo[];
  phases: AgentPhase[];
}

const without = (s: FixtureTodo[], title: string) => s.filter((t) => t.title !== title);

/** Open the app in a fresh browser context and check the list (independent of the agent's page). */
async function freshUiShows(c: ScenarioCtx, expected: FixtureTodo[], what: string): Promise<void> {
  const { context, page } = await openPage(c.browser, c.app.url);
  try {
    await page.goto(c.app.url, { waitUntil: 'networkidle' });
    await waitForLoaded(page, expected.length);
    await expectUi(page, expected, what);
  } finally {
    await context.close();
  }
}

/** Proxy fault for the api_error scenario: mutations on the agent's URL get 500 INTERNAL_ERROR. */
export const API_ERROR_FAULT = 'fail-mutations-500' as const;

/** Alerts that appeared at any time on the agent's page (recorded by an init script). */
async function alertsSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __frugalAlerts?: string[] }).__frugalAlerts ?? []).catch(() => []);
}

const ALERT_RECORDER = `(() => {
  const seen = (window.__frugalAlerts = window.__frugalAlerts || []);
  const scan = () => document.querySelectorAll('[role="alert"]').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t && seen[seen.length - 1] !== t) seen.push(t);
  });
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})();`;

export function buildAgentScenarios(): AgentScenario[] {
  return [
    {
      id: 'create',
      seed: (v) => v.baseSet,
      phases: [
        {
          goal: (v) => `Add a new task named "${v.titles.create}" to the todo list.`,
          async assert(c) {
            const expected = [...c.seed, { title: c.v.titles.create, completed: false }];
            await expectBackend(c.app, expected, 'API/DB after the agent created a task');
            await freshUiShows(c, expected, 'fresh page after create');
          },
        },
      ],
    },
    {
      id: 'edit',
      seed: (v) => [...v.baseSet, { title: v.titles.editFrom, completed: false }],
      phases: [
        {
          goal: (v) => `Rename the task "${v.titles.editFrom}" to "${v.titles.editTo}".`,
          async assert(c) {
            const expected = c.seed.map((t) => (t.title === c.v.titles.editFrom ? { ...t, title: c.v.titles.editTo } : t));
            await expectBackend(c.app, expected, 'API/DB after the agent renamed a task');
            await freshUiShows(c, expected, 'fresh page after edit');
          },
        },
      ],
    },
    {
      id: 'complete',
      seed: (v) => [{ title: v.titles.complete, completed: false }, ...v.baseSet],
      phases: [
        {
          goal: (v) => `Mark the task "${v.titles.complete}" as done.`,
          async assert(c) {
            const expected = c.seed.map((t) => (t.title === c.v.titles.complete ? { ...t, completed: true } : t));
            await expectBackend(c.app, expected, 'API/DB after the agent completed a task');
            await freshUiShows(c, expected, 'fresh page after complete');
          },
        },
      ],
    },
    {
      id: 'reopen',
      seed: (v) => [...v.baseSet, { title: v.titles.reopen, completed: true }],
      phases: [
        {
          goal: (v) => `The task "${v.titles.reopen}" was marked as done by mistake. Make it not done again.`,
          async assert(c) {
            const expected = c.seed.map((t) => (t.title === c.v.titles.reopen ? { ...t, completed: false } : t));
            await expectBackend(c.app, expected, 'API/DB after the agent reopened a task');
            await freshUiShows(c, expected, 'fresh page after reopen');
          },
        },
      ],
    },
    {
      id: 'delete',
      seed: (v) => [{ title: v.titles.keep, completed: false }, { title: v.titles.remove, completed: false }, ...v.baseSet],
      phases: [
        {
          goal: (v) => `Delete the task "${v.titles.remove}". Leave every other task as it is.`,
          async assert(c) {
            const expected = without(c.seed, c.v.titles.remove);
            await expectBackend(c.app, expected, 'API/DB after the agent deleted a task');
            await freshUiShows(c, expected, 'fresh page after delete');
          },
        },
      ],
    },
    {
      id: 'filter',
      seed: (v) => v.mixedSet,
      phases: [
        {
          goal: () => 'Change the view so that only the tasks that are still open (not completed) are shown, then tell me which tasks are listed.',
          async assert(c) {
            await expectBackend(c.app, c.seed, 'filtering must not change data');
            const pressed = await pressedFilter(c.page);
            assert(pressed.join() === 'Active', `expected the "Active" filter to be selected on the agent's page, got [${pressed.join(', ')}]`);
            await expectUi(c.page, c.seed.filter((t) => !t.completed), "agent's page under the Active filter");
          },
        },
      ],
    },
    {
      id: 'persistence',
      seed: (v) => v.baseSet,
      phases: [
        {
          goal: (v) =>
            `Create a task named "${v.titles.persist}", mark it as completed, then reload the page and check that it is still there and still completed.`,
          async assert(c) {
            const expected = [...c.seed, { title: c.v.titles.persist, completed: true }];
            await expectBackend(c.app, expected, 'API/DB after create+complete');
            await c.page.reload({ waitUntil: 'networkidle' });
            await waitForLoaded(c.page, expected.length);
            await expectUi(c.page, expected, "agent's page after a harness reload");
            await freshUiShows(c, expected, 'fresh browser context');
          },
        },
      ],
    },
    {
      id: 'invalid_input',
      seed: (v) => v.baseSet,
      phases: [
        {
          goal: () =>
            'Try to add a task with an empty title, and then try to add a task whose title is only spaces. Report what the app does in each case.',
          async assert(c) {
            await expectBackend(c.app, c.seed, 'no todo may be created from invalid input');
            const ui = await uiTodos(c.page);
            assert(ui.length === c.seed.length, `the UI shows ${ui.length} todos, expected ${c.seed.length}`);
            const alerts = await alertsSeen(c.page);
            assert(alerts.length > 0, 'no role="alert" validation message appeared while the agent submitted invalid input');
          },
        },
      ],
    },
    {
      id: 'api_error',
      seed: (v) => v.baseSet,
      phases: [
        {
          goal: (v) => `Add a new task named "${v.titles.error}". Tell me exactly what happens.`,
          before: async (c) => {
            await c.app.setFaultMode(API_ERROR_FAULT);
          },
          async assert(c) {
            await expectBackend(c.app, c.seed, 'no todo may be stored while the server fails');
            const ui = await uiTodos(c.page);
            assert(!ui.some((t) => t.title === c.v.titles.error), 'the UI shows the todo as created although the server failed (phantom success)');
            const alerts = await alertsSeen(c.page);
            assert(alerts.length > 0, 'no role="alert" error message appeared when the server failed');
          },
        },
        {
          goal: (v) => `Please try again now. Make sure the task "${v.titles.error}" ends up in the list exactly once.`,
          before: async (c) => {
            await c.app.setFaultMode('off');
          },
          async assert(c) {
            const expected = [...c.seed, { title: c.v.titles.error, completed: false }];
            await expectBackend(c.app, expected, 'API/DB after the server recovered');
            await freshUiShows(c, expected, 'fresh page after recovery');
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface BrowserAgentOptions {
  app: LaunchedApp;
  browser: Browser;
  variant: ScenarioVariant;
  /** api backend: provider already wrapped in a TokenTracker (role 'evaluator'), or null. */
  provider: ModelProvider | null;
  /** claude-code backend (preferred when set): gateway role 'evaluator' + headless runner. */
  claudeCode?: ClaudeCodeBrowserBackend | null;
  /** TESTS: replace the harness-owned CDP browser launcher of the claude-code backend. */
  launchAgentBrowser?: () => Promise<AgentBrowser>;
  /** Why the provider is unavailable (shown in the 'error' checks). */
  unavailableReason?: string;
  /** Allow the mock provider (infrastructure tests only; results are not meaningful). */
  allowMock?: boolean;
  model?: string;
  outDir: string;
  limits?: Partial<AgentLimits>;
  /** Attempts per scenario when deterministic assertions fail (LLM agents are noisy). */
  maxAttempts?: number;
  only?: string[];
}

export async function runBrowserAgentScenarios(opts: BrowserAgentOptions): Promise<CheckResult[]> {
  const scenarios = buildAgentScenarios()
    .filter((s) => !opts.only || opts.only.includes(s.id))
    .sort((a, b) => opts.variant.browserScenarioOrder.indexOf(a.id) - opts.variant.browserScenarioOrder.indexOf(b.id));
  const trace = new TraceWriter(path.join(opts.outDir, 'browser-trace.jsonl'));
  const shotDir = path.join(opts.outDir, 'screenshots');
  const checkId = (id: string) => `browser.${id}`;

  const cc = opts.claudeCode ?? null;
  const unavailable = cc
    ? null
    : !opts.provider
      ? `browser agent unavailable: ${opts.unavailableReason ?? 'no model provider configured'}`
      : opts.provider.isMock && !opts.allowMock
        ? 'browser agent unavailable: the mock provider cannot evaluate a UI (configure a Claude subscription token or a real provider)'
        : null;
  if (unavailable) {
    trace.write({ type: 'unavailable', reason: unavailable });
    return scenarios.map((s) => ({
      id: checkId(s.id),
      category: 'browser' as const,
      mandatory: true,
      outcome: 'error' as const,
      message: `evaluator error: ${unavailable}`,
      attempts: 0,
    }));
  }

  const provider = opts.provider;
  const model = opts.model ?? DEFAULT_BROWSER_AGENT_MODEL;
  const launchCdpBrowser = opts.launchAgentBrowser ?? launchAgentBrowser;
  const streamDir = path.join(opts.outDir, 'browser-agent');
  const limits = { ...DEFAULT_AGENT_LIMITS, ...opts.limits };
  const maxAttempts = opts.maxAttempts ?? 2;
  const results: CheckResult[] = [];

  for (const sc of scenarios) {
    let result: CheckResult | null = null;
    const evidence: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t = (e: Record<string, unknown>) => trace.write({ scenario: sc.id, attempt, ...e });
      let closeAgentPage: (() => Promise<void>) | null = null;
      const verdicts: Array<AgentVerdict | null> = [];
      try {
        await opts.app.resetDb();
        await opts.app.setFaultMode('off');
        const seed = sc.seed(opts.variant).map((x) => ({ ...x }));
        await seedTodos(opts.app.url, seed);
        let page: Page;
        let cdpEndpoint = '';
        if (cc) {
          const ab = await launchCdpBrowser();
          closeAgentPage = ab.close;
          page = ab.page;
          cdpEndpoint = ab.cdpEndpoint;
        } else {
          const opened = await openPage(opts.browser, opts.app.agentUrl, 'desktop');
          closeAgentPage = () => opened.context.close();
          page = opened.page;
        }
        await page.addInitScript(ALERT_RECORDER);
        await page.goto(opts.app.agentUrl, { waitUntil: 'networkidle' });
        const tools = cc ? undefined : new BrowserTools(page, opts.app.agentUrl, shotDir, `agent-${sc.id}-a${attempt}`);
        const ctx: ScenarioCtx = { page, app: opts.app, browser: opts.browser, v: opts.variant, seed, tools };
        let history: Message[] = [];
        const previous: { goal: string; observations: string | null }[] = [];
        for (let pi = 0; pi < sc.phases.length; pi++) {
          const phase = sc.phases[pi];
          if (phase.before) await phase.before(ctx);
          const goal = phase.goal(opts.variant);
          t({ type: 'goal', phase: pi, goal });
          if (cc) {
            const streamFile = path.join(streamDir, `${sc.id}-a${attempt}-p${pi}.jsonl`);
            const run = await runClaudeBrowserPhase({
              backend: cc,
              appUrl: opts.app.agentUrl,
              cdpEndpoint,
              goal,
              previous,
              streamFile,
              screenshotDir: shotDir,
              screenshotPrefix: `agent-${sc.id}-a${attempt}-p${pi}`,
              trace: (e) => t({ phase: pi, ...e }),
            });
            evidence.push(streamFile, ...run.screenshots);
            verdicts.push(run.verdict);
            previous.push({ goal, observations: run.verdict?.observations ?? null });
            t({ type: 'verdict', phase: pi, verdict: run.verdict, stop: run.stop, steps: run.steps, tokens: run.tokens, modelCalls: run.modelCalls, streamFile });
          } else {
            const run = await runAgentLoop({ provider: provider!, model, tools: tools!, goal, limits, history, trace: (e) => t({ phase: pi, ...e }) });
            history = run.messages;
            verdicts.push(run.verdict);
            t({ type: 'verdict', phase: pi, verdict: run.verdict, stop: run.stop, steps: run.steps, tokens: run.tokens });
          }
          try {
            await phase.assert(ctx);
            t({ type: 'assertion', phase: pi, outcome: 'pass' });
          } catch (e) {
            t({ type: 'assertion', phase: pi, outcome: isInfraError(e) ? 'error' : 'fail', message: (e as Error).message });
            throw e;
          }
        }
        const finalShot = path.join(shotDir, `agent-${sc.id}-a${attempt}-final.png`);
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: finalShot }).catch(() => undefined);
        evidence.push(finalShot);
        result = {
          id: checkId(sc.id),
          category: 'browser',
          mandatory: true,
          outcome: 'pass',
          message: trunc(`deterministic assertions passed; agent verdict: ${fmtVerdicts(verdicts)}`, 1500),
          evidence: [...evidence, trace.file],
          attempts: attempt,
        };
        break;
      } catch (e) {
        const infra = e instanceof UsageLimitError || isInfraError(e) || !(e instanceof AssertionFailure || isAppError(e));
        result = {
          id: checkId(sc.id),
          category: 'browser',
          mandatory: true,
          outcome: infra ? 'error' : 'fail',
          message: trunc(
            `${infra ? 'evaluator error: ' : ''}${(e as Error).message}; agent verdict: ${fmtVerdicts(verdicts)}`,
            1500,
          ),
          evidence: [...evidence, trace.file],
          attempts: attempt,
        };
        t({ type: 'error', infra, message: (e as Error).message });
        if (infra) break; // the caller retries infrastructure failures
      } finally {
        await opts.app.setFaultMode('off').catch(() => undefined);
        await closeAgentPage?.().catch(() => undefined);
      }
    }
    results.push(result!);
    if (result!.outcome === 'error') {
      // Model/provider or browser infra failure: don't burn tokens on the remaining scenarios.
      for (const rest of scenarios.slice(scenarios.indexOf(sc) + 1)) {
        results.push({
          id: checkId(rest.id),
          category: 'browser',
          mandatory: true,
          outcome: 'error',
          message: `evaluator error: not run after an evaluator failure in ${checkId(sc.id)}`,
          attempts: 0,
        });
      }
      break;
    }
  }
  return results;
}

function fmtVerdicts(v: Array<AgentVerdict | null>): string {
  if (!v.length) return 'none';
  return v.map((x) => (x ? `${x.success ? 'success' : 'failure'} — ${trunc(x.observations, 300)}` : 'no verdict (limits reached)')).join(' | ');
}

/** Errors that are the app's fault (seeding via its API failed, DB missing, startup failure). */
function isAppError(e: unknown): boolean {
  const name = (e as Error)?.name;
  // TimeoutError: Playwright waited for the app (navigation/element) in harness code.
  return name === 'SeedError' || name === 'AppDbError' || name === 'AppStartupError' || name === 'TimeoutError';
}
