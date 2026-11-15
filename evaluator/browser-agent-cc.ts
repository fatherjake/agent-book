/**
 * Browser agent on the Claude Code CLI + Playwright MCP (subscription auth, no API key).
 *
 * Per scenario attempt the HARNESS launches its own headless Chromium (persistent temp profile,
 * fixed desktop viewport, remote debugging on 127.0.0.1) and opens the app there. Per goal phase it
 * runs one host `claude -p` (runner/claude-code.ts runClaudeHeadless, gateway role 'evaluator'):
 *  - fresh EMPTY temp cwd, ALL built-in tools disabled (`--tools ""`: no Bash/Read/Write/Glob/Grep,
 *    so it can never read evaluator source or holdout files), no skills/slash commands;
 *  - exactly one MCP server, Playwright MCP (`--mcp-config` + `--strict-mcp-config`), attached to the
 *    harness's browser over CDP (`--cdp-endpoint`), with file:// navigation blocked (MCP default),
 *    allowed origins restricted to the app, screenshots written to a temp output dir;
 *  - only an explicit allowlist of MCP browser tools is permitted; code execution, file upload,
 *    tab/route/storage manipulation tools are disallowed;
 *  - the verdict comes back through `--json-schema` {success, observations}.
 * Because the harness and the MCP share the same page, the deterministic post-assertions run on the
 * very page the agent used (filter state, reload, role="alert" recorder) exactly as before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Effort } from '../runner/types.js';
import type { GatewayHandle } from '../runner/gateway.js';
import type { HeadlessResult } from '../runner/claude-code.js';
import { EvaluatorInfraError } from './app-launcher.js';
import { trunc } from './checks.js';
import { contextOptions } from './ui-helpers.js';

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

/** Everything the claude-code browser agent needs (injected so the harness is testable with fakes). */
export interface ClaudeCodeBrowserBackend {
  /** Gateway with role 'evaluator' (started/stopped by evaluateRun). */
  gateway: GatewayHandle;
  model: string;
  effort?: Effort;
  runHeadless: RunHeadlessFn;
  /** Wall-clock limit per goal phase (default 420 s). */
  phaseTimeoutSec?: number;
  /** Abort a phase once it used this many gateway tokens (default 400k). */
  phaseMaxTokens?: number;
  /** Abort a phase after this many main-model calls (default 40). */
  phaseMaxModelCalls?: number;
}

export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean', description: 'Whether the goal was achieved, as far as you can tell from the UI.' },
    observations: { type: 'string', description: 'What you did and saw, including any messages the app showed.' },
  },
  required: ['success', 'observations'],
  additionalProperties: false,
} as const;

/** MCP tools the agent may use (a real user's capabilities: look, click, type, navigate in-app). */
export const ALLOWED_MCP_TOOLS = [
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_fill_form',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_find',
  'browser_console_messages',
] as const;

/** Never available: code execution, host file access, tabs/window, network/route/storage tampering. */
export const DISALLOWED_MCP_TOOLS = [
  'browser_evaluate',
  'browser_run_code_unsafe',
  'browser_file_upload',
  'browser_drop',
  'browser_drag',
  'browser_close',
  'browser_resize',
  'browser_tabs',
  'browser_install',
  'browser_emulate_media',
  'browser_network_requests',
  'browser_network_request',
  'browser_network_state_set',
  'browser_route',
  'browser_route_list',
  'browser_unroute',
  'browser_pdf_save',
  'browser_set_storage_state',
  'browser_storage_state',
  'browser_cookie_clear',
  'browser_cookie_delete',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_cookie_set',
  'browser_localstorage_clear',
  'browser_localstorage_delete',
  'browser_localstorage_get',
  'browser_localstorage_list',
  'browser_localstorage_set',
  'browser_sessionstorage_clear',
  'browser_sessionstorage_delete',
  'browser_sessionstorage_get',
  'browser_sessionstorage_list',
  'browser_sessionstorage_set',
  'browser_mouse_click_xy',
  'browser_mouse_down',
  'browser_mouse_drag_xy',
  'browser_mouse_move_xy',
  'browser_mouse_up',
  'browser_mouse_wheel',
  'browser_start_tracing',
  'browser_stop_tracing',
  'browser_start_video',
  'browser_stop_video',
  'browser_start_recording',
  'browser_stop_recording',
  'browser_video_chapter',
  'browser_video_hide_actions',
  'browser_video_show_actions',
  'browser_generate_locator',
  'browser_get_config',
  'browser_annotate',
  'browser_highlight',
  'browser_hide_highlight',
  'browser_resume',
  'browser_verify_element_visible',
  'browser_verify_list_visible',
  'browser_verify_text_visible',
  'browser_verify_value',
] as const;

const mcpName = (t: string) => `mcp__playwright__${t}`;

export const CC_BROWSER_SYSTEM_PROMPT = `You are a careful QA tester operating a web application through a real browser.
The app is already open in the browser's current tab. You can only perceive the page through your browser tools: "browser_snapshot" (accessibility tree with element refs, the main way to see the page) and "browser_take_screenshot".
Act like a real user: discover the controls yourself, use the visible interface, and check the result with a fresh snapshot after each action (action results do not include the page state).
Do not assume an action worked — look. If the app shows a message (for example an error), read it and report it.
Stay inside the app under test; do not open other sites.
When you are done, or if the goal cannot be achieved, give your final answer with success (true/false) and concise observations.
Be efficient: prefer snapshots over screenshots, and do not repeat actions unnecessarily.`;

/** Absolute path of the pinned Playwright MCP CLI (root devDependency @playwright/mcp). */
export function playwrightMcpCli(): string {
  const req = createRequire(import.meta.url);
  return path.join(path.dirname(req.resolve('@playwright/mcp/package.json')), 'cli.js');
}

export function buildBrowserMcpConfig(o: { cdpEndpoint: string; appOrigin: string; outputDir: string }): Record<string, unknown> {
  return {
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: process.execPath,
        args: [
          playwrightMcpCli(),
          '--cdp-endpoint', o.cdpEndpoint,
          '--allowed-origins', o.appOrigin,
          '--output-dir', o.outputDir,
          '--codegen', 'none',
          '--snapshot-mode', 'none',
          '--image-responses', 'allow',
          '--timeout-action', '5000',
          '--timeout-navigation', '20000',
          '--no-webmcp',
        ],
        env: {},
      },
    },
  };
}

/**
 * The exact claude flags of a browser-agent phase (exported so tests can assert there is no built-in
 * tool). runClaudeHeadless adds -p, stream-json, --no-session-persistence, --strict-mcp-config and
 * --setting-sources "".
 */
export function buildBrowserClaudeArgs(o: { model: string; effort?: Effort; mcpConfig: Record<string, unknown> }): string[] {
  const args = [
    '--model', o.model,
    '--system-prompt', CC_BROWSER_SYSTEM_PROMPT,
    '--tools', '',
    '--disable-slash-commands',
    '--permission-mode', 'dontAsk',
    '--json-schema', JSON.stringify(VERDICT_JSON_SCHEMA),
    '--mcp-config', JSON.stringify(o.mcpConfig),
    '--allowedTools', ALLOWED_MCP_TOOLS.map(mcpName).join(','),
    '--disallowedTools', DISALLOWED_MCP_TOOLS.map(mcpName).join(','),
  ];
  if (o.effort) args.push('--effort', o.effort);
  return args;
}

// ---------------------------------------------------------------------------
// Harness-owned browser shared with the MCP over CDP
// ---------------------------------------------------------------------------

export interface AgentBrowser {
  context: BrowserContext;
  page: Page;
  /** http://127.0.0.1:<port> */
  cdpEndpoint: string;
  close(): Promise<void>;
}

export async function launchAgentBrowser(): Promise<AgentBrowser> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-agent-browser-'));
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...contextOptions('desktop'),
      headless: true,
      args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (e) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new EvaluatorInfraError(`could not launch the agent browser: ${(e as Error).message}`);
  }
  const close = async () => {
    await context.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  try {
    let port = '';
    for (let i = 0; i < 50 && !port; i++) {
      try {
        port = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!/^\d+$/.test(port)) throw new EvaluatorInfraError('agent browser did not expose a CDP port');
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(20_000);
    const page = context.pages()[0] ?? (await context.newPage());
    for (const p of context.pages()) if (p !== page) await p.close().catch(() => undefined);
    return { context, page, cdpEndpoint: `http://127.0.0.1:${port}`, close };
  } catch (e) {
    await close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// One goal phase
// ---------------------------------------------------------------------------

export interface CcPhaseResult {
  verdict: { success: boolean; observations: string } | null;
  stop: 'finished' | 'max_tokens' | 'max_steps' | 'timeout' | 'no_verdict';
  steps: number;
  tokens: number;
  modelCalls: number;
  streamFile: string;
  screenshots: string[];
  /** Set when the subscription usage limit was hit (ISO reset time or ''). */
  usageLimitResetAt?: string;
}

export class UsageLimitError extends Error {
  constructor(readonly resetAt: string) {
    super(`evaluator subscription usage limit reached${resetAt ? ` (resets ${resetAt})` : ''}`);
    this.name = 'UsageLimitError';
  }
}

function phasePrompt(o: { appUrl: string; goal: string; previous?: { goal: string; observations: string | null }[] }): string {
  const lines = [`The app under test is open in the browser's current tab at ${o.appUrl}.`];
  if (o.previous?.length) {
    lines.push('', 'Earlier in this session (same browser tab, still open):');
    for (const p of o.previous) lines.push(`- Goal: ${p.goal}`, `  Your report: ${p.observations ?? '(no report)'}`);
  }
  lines.push('', `Goal: ${o.goal}`);
  return lines.join('\n');
}

export async function runClaudeBrowserPhase(o: {
  backend: ClaudeCodeBrowserBackend;
  appUrl: string;
  cdpEndpoint: string;
  goal: string;
  previous?: { goal: string; observations: string | null }[];
  streamFile: string;
  screenshotDir: string;
  screenshotPrefix: string;
  trace?: (e: Record<string, unknown>) => void;
}): Promise<CcPhaseResult> {
  const b = o.backend;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-browser-agent-'));
  const mcpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-browser-mcp-out-'));
  const origin = new URL(o.appUrl).origin;
  const args = buildBrowserClaudeArgs({ model: b.model, effort: b.effort, mcpConfig: buildBrowserMcpConfig({ cdpEndpoint: o.cdpEndpoint, appOrigin: origin, outputDir: mcpOut }) });
  const maxTokens = b.phaseMaxTokens ?? 400_000;
  const maxCalls = b.phaseMaxModelCalls ?? 40;
  const before = b.gateway.tracker.records().length;
  const phaseRecords = () => b.gateway.tracker.records().slice(before);
  const ctrl = new AbortController();
  let limitStop: 'max_tokens' | 'max_steps' | null = null;
  const poll = setInterval(() => {
    const recs = phaseRecords();
    const tokens = recs.reduce((a, r) => a + r.totalTokens, 0);
    const calls = recs.filter((r) => r.purpose === 'agent-turn').length;
    if (!limitStop && tokens >= maxTokens) limitStop = 'max_tokens';
    else if (!limitStop && calls >= maxCalls) limitStop = 'max_steps';
    if (limitStop || b.gateway.usageLimitResetAt() !== null) ctrl.abort();
  }, 1000);
  poll.unref?.();
  let res: HeadlessResult;
  try {
    res = await b.runHeadless({
      cwd,
      prompt: phasePrompt(o),
      gateway: b.gateway,
      args,
      timeoutSec: b.phaseTimeoutSec ?? 420,
      streamFile: o.streamFile,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new EvaluatorInfraError(`browser agent claude process failed: ${(e as Error).message}`);
  } finally {
    clearInterval(poll);
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  // Screenshots: move the MCP's auto-named PNGs next to the other evaluation screenshots.
  const screenshots: string[] = [];
  try {
    fs.mkdirSync(o.screenshotDir, { recursive: true });
    const pngs = fs.readdirSync(mcpOut).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
    pngs.forEach((f, i) => {
      const dest = path.join(o.screenshotDir, `${o.screenshotPrefix}-${String(i + 1).padStart(2, '0')}${path.extname(f)}`);
      fs.copyFileSync(path.join(mcpOut, f), dest);
      screenshots.push(dest);
    });
  } catch {
    /* screenshots are evidence only */
  } finally {
    fs.rmSync(mcpOut, { recursive: true, force: true });
  }

  const recs = phaseRecords();
  const tokens = recs.reduce((a, r) => a + r.totalTokens, 0);
  const modelCalls = recs.filter((r) => r.purpose === 'agent-turn').length;
  // Trace: every tool call / result of the transcript (full transcript in streamFile).
  let steps = 0;
  for (const e of res.events) {
    if (e?.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c?.type === 'tool_use') {
          steps++;
          o.trace?.({ type: 'tool', tool: String(c.name).replace(/^mcp__playwright__/, ''), input: c.input });
        } else if (c?.type === 'text' && c.text?.trim()) o.trace?.({ type: 'model', text: trunc(c.text, 2000) });
      }
    } else if (e?.type === 'user') {
      for (const c of e.message?.content ?? []) {
        if (c?.type === 'tool_result') {
          const text = Array.isArray(c.content)
            ? c.content.map((x: { type?: string; text?: string }) => (x?.type === 'text' ? x.text : `[${x?.type}]`)).join('\n')
            : String(c.content ?? '');
          o.trace?.({ type: 'tool_result', isError: !!c.is_error, result: trunc(text, 3000) });
        }
      }
    }
  }

  const resetAt = b.gateway.usageLimitResetAt();
  const resultText = typeof res.result?.result === 'string' ? res.result.result : '';
  if (resetAt !== null || (res.result?.is_error && /usage limit|limit reached/i.test(resultText))) throw new UsageLimitError(resetAt ?? '');

  const base = { steps, tokens, modelCalls, streamFile: o.streamFile, screenshots };
  if (limitStop) return { ...base, verdict: null, stop: limitStop };
  if (res.timedOut) return { ...base, verdict: null, stop: 'timeout' };
  const so = res.result?.structured_output;
  if (res.result && !res.result.is_error && so && typeof so.success === 'boolean') {
    return { ...base, verdict: { success: so.success, observations: String(so.observations ?? '').slice(0, 4000) }, stop: 'finished' };
  }
  // The agent ran but produced no verdict (e.g. error_max_turns). Assertions still decide.
  if (res.result && res.result.subtype && res.result.subtype !== 'success') return { ...base, verdict: null, stop: 'no_verdict' };
  if (!res.result) throw new EvaluatorInfraError(`browser agent claude process produced no result (exit ${res.exitCode}); see ${o.streamFile}`);
  return { ...base, verdict: null, stop: 'no_verdict' };
}
