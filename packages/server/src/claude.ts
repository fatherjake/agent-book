/**
 * Runs `claude -p` and turns its stream-json output into simple callbacks: text deltas and one-line tool
 * labels. (The same runner as CV Hub's chat pane.)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';

export interface RunHandlers {
  /** A text delta from Claude. `newBlock` is true for the first delta of a new text block. */
  onText?: (text: string, newBlock: boolean) => void;
  /** A tool call, as a short label such as "Bash sqlite3 -readonly …". */
  onTool?: (label: string) => void;
}

export interface RunResult {
  /** Error message, or null when Claude finished (or was stopped) cleanly. */
  error: string | null;
  stopped: boolean;
  /** Claude's final reply text. */
  result: string;
}

/**
 * The environment for a chat session. Variables that tie a process to the Claude Code session that
 * started it are dropped, so the chat isn't recorded as a session launched by whichever Claude Code
 * session happened to start this server.
 */
function chatEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH'])
    delete env[k];
  return env;
}

export function runClaude(cwd: string, args: string[], prompt: string, handlers: RunHandlers = {}): { proc: ChildProcess; done: Promise<RunResult> } {
  const proc = spawn(process.env.AGENT_BOOK_CLAUDE_BIN || 'claude', ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...args], {
    cwd,
    env: chatEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin!.end(prompt);

  let buffer = '';
  let stderr = '';
  let resultError: string | null = null;
  let result = '';
  let freshBlock = true;

  const home = homedir();
  const toolLabel = (name: string, input: Record<string, unknown>) => {
    const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url;
    if (typeof target !== 'string') return name;
    const shown = target.startsWith(home) ? '~' + target.slice(home.length) : target;
    const line = shown.split('\n')[0];
    return `${name} ${line.length > 100 ? `${line.slice(0, 97)}…` : line}`;
  };

  const handle = (line: string) => {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'stream_event' && !event.parent_tool_use_id) {
      const inner = event.event;
      if (inner?.type === 'content_block_start' && inner.content_block?.type === 'text') freshBlock = true;
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        handlers.onText?.(inner.delta.text, freshBlock);
        freshBlock = false;
      }
    } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        handlers.onTool?.(toolLabel(block.name, block.input ?? {}));
        freshBlock = true;
      }
    } else if (event.type === 'result') {
      if (typeof event.result === 'string') result = event.result;
      if (event.is_error) resultError = result || 'Claude reported an error';
    }
  };

  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const done = new Promise<RunResult>((resolve) => {
    proc.on('error', (error) => resolve({ error: `Could not start claude: ${error.message}`, stopped: false, result }));
    proc.on('close', (code, signal) => {
      if (buffer.trim()) handle(buffer);
      if (signal) return resolve({ error: null, stopped: true, result });
      if (resultError) return resolve({ error: resultError, stopped: false, result });
      if (code !== 0) {
        const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1);
        return resolve({ error: lastLine ?? `claude exited with code ${code}`, stopped: false, result });
      }
      resolve({ error: null, stopped: false, result });
    });
  });

  return { proc, done };
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
