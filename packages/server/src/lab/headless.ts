/**
 * One headless `claude -p` run for the lab, keeping what the lab measures: the final result event (cost,
 * tokens, turns, how it ended, structured output) and the number of tool calls, subagents' included.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chatEnv } from '../claude.js';
import type { Tokens } from './state.js';

export interface HeadlessResult {
  /** success, error_max_turns, error_max_budget_usd, error_during_execution, timeout, stopped, failed */
  ending: string;
  isError: boolean;
  costUsd: number;
  tokens: Tokens;
  durationMs: number;
  turns: number;
  toolCalls: number;
  /** The final message. */
  result: string;
  structured: unknown;
  /** Why it failed to run at all, when it did. */
  error: string | null;
}

export interface HeadlessRun {
  proc: ChildProcess;
  done: Promise<HeadlessResult>;
}

export function runHeadless(cwd: string, args: string[], prompt: string, o: { timeoutMs: number }): HeadlessRun {
  const proc = spawn(process.env.AGENT_BOOK_CLAUDE_BIN || 'claude', ['-p', '--output-format', 'stream-json', '--verbose', ...args], {
    cwd,
    env: chatEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin!.end(prompt);

  let buffer = '';
  let stderr = '';
  let toolCalls = 0;
  let final: any = null;
  let timedOut = false;
  const started = Date.now();

  const handle = (line: string) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) if (b?.type === 'tool_use') toolCalls++;
    if (ev.type === 'result') final = ev;
  };
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  });
  proc.stderr!.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-20_000);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGINT');
    setTimeout(() => proc.kill('SIGKILL'), 10_000).unref();
  }, o.timeoutMs);

  const done = new Promise<HeadlessResult>((resolve) => {
    const finish = (error: string | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (buffer.trim()) handle(buffer);
      const r = final ?? {};
      // modelUsage covers every model the run used (subagents included); usage only the main one.
      const byModel = Object.values((r.modelUsage ?? {}) as Record<string, any>);
      const tokens: Tokens = byModel.length
        ? {
            input: byModel.reduce((n, m) => n + (m.inputTokens ?? 0), 0),
            output: byModel.reduce((n, m) => n + (m.outputTokens ?? 0), 0),
            cacheRead: byModel.reduce((n, m) => n + (m.cacheReadInputTokens ?? 0), 0),
            cacheWrite: byModel.reduce((n, m) => n + (m.cacheCreationInputTokens ?? 0), 0),
          }
        : {
            input: r.usage?.input_tokens ?? 0,
            output: r.usage?.output_tokens ?? 0,
            cacheRead: r.usage?.cache_read_input_tokens ?? 0,
            cacheWrite: r.usage?.cache_creation_input_tokens ?? 0,
          };
      const ending = timedOut ? 'timeout' : signal && !final ? 'stopped' : (r.subtype ?? (error ? 'failed' : 'unknown'));
      resolve({
        ending,
        isError: !!r.is_error || timedOut || !final,
        costUsd: r.total_cost_usd ?? 0,
        tokens,
        durationMs: r.duration_ms ?? Date.now() - started,
        turns: r.num_turns ?? 0,
        toolCalls,
        result: typeof r.result === 'string' ? r.result : '',
        structured: r.structured_output ?? null,
        error: final ? null : (error ?? (stderr.trim().split('\n').filter(Boolean).at(-1) || 'claude exited without a result')),
      });
    };
    proc.on('error', (e) => finish(`Could not start claude: ${e.message}`, null));
    proc.on('close', (_code, signal) => finish(null, signal));
  });
  return { proc, done };
}
