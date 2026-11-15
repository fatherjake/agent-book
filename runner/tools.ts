/**
 * Agent tools: definitions (configurable via ToolConfig) and executors that run inside the
 * sandbox. Tool failures are returned to the model as isError results and never throw.
 */
import { posix } from 'node:path';
import type { Sandbox, ToolConfig, ToolName, ToolSpec } from './types.js';

export const WORKSPACE = '/workspace';
export const SPEC = '/spec';
export const ALL_TOOLS: ToolName[] = ['read_file', 'write_file', 'edit_file', 'list_dir', 'run_command', 'view_image'];
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
export const DEFAULT_COMMAND_TIMEOUT_SEC = 120;
export const MAX_COMMAND_TIMEOUT_SEC = 900;

export const DEFAULT_DESCRIPTIONS: Record<ToolName, string> = {
  read_file:
    'Read a text file. Paths are relative to /workspace or absolute under /workspace or /spec. Optional 1-based line offset and line limit.',
  write_file: 'Create or overwrite a file under /workspace with the given content. Parent directories are created.',
  edit_file:
    'Replace an exact string in a file under /workspace. old_string must match exactly once (include surrounding lines to make it unique) unless replace_all is true.',
  list_dir: 'List a directory under /workspace or /spec. Directories end with "/". recursive=true lists up to 3 levels, skipping node_modules, .git and dist.',
  run_command:
    'Run a bash command in /workspace (no network access). Returns exit code, stdout and stderr. Processes started in the background (cmd > /tmp/log 2>&1 &) keep running between calls.',
  view_image: 'View a PNG or JPEG image file (e.g. /spec/design.png).',
};

export const INPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  read_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer', description: '1-based first line' },
      limit: { type: 'integer', description: 'max lines' },
    },
    required: ['path'],
  },
  write_file: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  edit_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  list_dir: {
    type: 'object',
    properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
  },
  run_command: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_sec: { type: 'integer', description: `default ${DEFAULT_COMMAND_TIMEOUT_SEC}` },
    },
    required: ['command'],
  },
  view_image: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

export function enabledTools(configs: ToolConfig[]): ToolConfig[] {
  // Keep the canonical order so the tool list (and the prompt cache prefix) is deterministic.
  return ALL_TOOLS.map((n) => configs.find((c) => c.name === n)).filter((c): c is ToolConfig => !!c && c.enabled);
}

export function buildToolSpecs(configs: ToolConfig[]): ToolSpec[] {
  return enabledTools(configs).map((c) => ({
    name: c.name,
    description: c.description ?? DEFAULT_DESCRIPTIONS[c.name],
    inputSchema: INPUT_SCHEMAS[c.name],
  }));
}

export class ToolError extends Error {}

/** Resolve and confine a path. Writes: /workspace only. Reads: /workspace or /spec. */
export function resolvePath(p: unknown, mode: 'read' | 'write'): string {
  if (typeof p !== 'string' || p.trim() === '') throw new ToolError('path must be a non-empty string');
  if (p.includes('\0')) throw new ToolError('path contains a NUL byte');
  const abs = posix.normalize(p.startsWith('/') ? p : posix.join(WORKSPACE, p)).replace(/\/+$/, '') || '/';
  const under = (root: string) => abs === root || abs.startsWith(root + '/');
  if (mode === 'write') {
    if (!under(WORKSPACE)) throw new ToolError(`writes are only allowed under ${WORKSPACE} (got ${abs})`);
    if (abs === WORKSPACE) throw new ToolError('path must be a file, not /workspace itself');
  } else if (!under(WORKSPACE) && !under(SPEC)) {
    throw new ToolError(`reads are only allowed under ${WORKSPACE} or ${SPEC} (got ${abs})`);
  }
  return abs;
}

/** Keep head and tail, cutting the middle, so the total is about `max` chars. */
export function truncateOutput(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  const marker = `\n...[${s.length - max} chars truncated]...\n`;
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return s.slice(0, head) + marker + (tail > 0 ? s.slice(s.length - tail) : '');
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ToolImage {
  mediaType: 'image/png' | 'image/jpeg';
  dataBase64: string;
}

export interface ToolExecResult {
  content: string;
  isError: boolean;
  images?: ToolImage[];
  /** Characters of the output before truncation/summarisation. */
  rawChars: number;
  truncated: boolean;
  summarized: boolean;
}

export interface ToolContext {
  sandbox: Sandbox;
  /** Used by outputMode 'summarize'. Must record its own usage (coding role). */
  summarize?: (text: string, tool: ToolName, input: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new ToolError(`'${name}' must be a string`);
  return v;
};

async function readBinary(sandbox: Sandbox, path: string): Promise<Buffer> {
  const sb = sandbox as Sandbox & { readFileBuffer?: (p: string) => Promise<Buffer> };
  if (typeof sb.readFileBuffer === 'function') return sb.readFileBuffer(path);
  const r = await sandbox.exec(`base64 -w0 -- ${shellQuote(path)}`, { timeoutSec: 60 });
  if (r.exitCode !== 0) throw new ToolError(r.stderr.trim() || `cannot read ${path}`);
  return Buffer.from(r.stdout.trim(), 'base64');
}

function cleanErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error: /, '').trim() || 'unknown error';
}

/** Execute one tool call. Never throws. */
export async function executeTool(name: string, rawInput: unknown, configs: ToolConfig[], ctx: ToolContext): Promise<ToolExecResult> {
  const cfg = configs.find((c) => c.name === name);
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  if (!cfg || !cfg.enabled) {
    return { content: `Unknown or disabled tool: ${name}`, isError: true, rawChars: 0, truncated: false, summarized: false };
  }
  let out: { content: string; isError: boolean; images?: ToolImage[] };
  try {
    out = await runTool(cfg, input, ctx.sandbox);
  } catch (e) {
    out = { content: `Error: ${cleanErr(e)}`, isError: true };
  }
  return shapeOutput(out, cfg, input, ctx);
}

async function shapeOutput(
  out: { content: string; isError: boolean; images?: ToolImage[] },
  cfg: ToolConfig,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecResult> {
  const mode = cfg.outputMode ?? 'truncate';
  const max = cfg.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const rawChars = out.content.length;
  const base = { isError: out.isError, images: out.images, rawChars };
  if (mode === 'raw' || rawChars <= max) return { ...base, content: out.content, truncated: false, summarized: false };
  if (mode === 'summarize' && ctx.summarize) {
    try {
      const summary = await ctx.summarize(out.content, cfg.name, input);
      return { ...base, content: `[output of ${rawChars} chars summarized]\n${summary}`, truncated: false, summarized: true };
    } catch {
      /* fall back to truncation */
    }
  }
  return { ...base, content: truncateOutput(out.content, max), truncated: true, summarized: false };
}

async function runTool(cfg: ToolConfig, input: Record<string, unknown>, sandbox: Sandbox): Promise<{ content: string; isError: boolean; images?: ToolImage[] }> {
  switch (cfg.name) {
    case 'read_file': {
      const path = resolvePath(input.path, 'read');
      if (/\.(png|jpe?g|gif|webp|ico)$/i.test(path)) return { content: `${path} is an image; use view_image instead.`, isError: true };
      const text = await sandbox.readFile(path);
      const offset = typeof input.offset === 'number' && input.offset > 1 ? Math.floor(input.offset) : 1;
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : undefined;
      if (offset === 1 && limit === undefined) return { content: text, isError: false };
      const lines = text.split('\n');
      const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      return { content: `[lines ${offset}-${offset + slice.length - 1} of ${lines.length}]\n${slice.join('\n')}`, isError: false };
    }
    case 'write_file': {
      const path = resolvePath(input.path, 'write');
      const content = str(input.content, 'content');
      await sandbox.writeFile(path, content);
      return { content: `Wrote ${content.length} chars to ${path}`, isError: false };
    }
    case 'edit_file': {
      const path = resolvePath(input.path, 'write');
      const oldS = str(input.old_string, 'old_string');
      const newS = str(input.new_string, 'new_string');
      if (oldS === '') throw new ToolError('old_string must not be empty (use write_file to create files)');
      if (oldS === newS) throw new ToolError('old_string and new_string are identical');
      const text = await sandbox.readFile(path);
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new ToolError(`old_string not found in ${path}`);
      if (count > 1 && input.replace_all !== true)
        throw new ToolError(`old_string matches ${count} times in ${path}; add surrounding context to make it unique or set replace_all`);
      const updated = input.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      await sandbox.writeFile(path, updated);
      return { content: `Edited ${path} (${input.replace_all === true ? count : 1} replacement${count > 1 && input.replace_all ? 's' : ''})`, isError: false };
    }
    case 'list_dir': {
      const path = resolvePath(input.path ?? WORKSPACE, 'read');
      if (input.recursive === true) {
        const cmd = `cd ${shellQuote(path)} && find . -mindepth 1 -maxdepth 3 \\( -name node_modules -o -name .git -o -name dist \\) -prune -o -printf '%y %P\\n' | sort -k2 | awk '{ if ($1=="d") print $2"/"; else print $2 }'`;
        const r = await sandbox.exec(cmd, { timeoutSec: 60 });
        if (r.exitCode !== 0) throw new ToolError(r.stderr.trim() || `cannot list ${path}`);
        return { content: r.stdout.trim() || '(empty)', isError: false };
      }
      const entries = await sandbox.listDir(path);
      return { content: entries.length ? entries.join('\n') : '(empty)', isError: false };
    }
    case 'run_command': {
      const command = str(input.command, 'command');
      if (!command.trim()) throw new ToolError('command is empty');
      const def = cfg.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC;
      const req = typeof input.timeout_sec === 'number' && input.timeout_sec > 0 ? input.timeout_sec : def;
      const timeoutSec = Math.min(Math.max(1, Math.floor(req)), MAX_COMMAND_TIMEOUT_SEC);
      const r = await sandbox.exec(command, { timeoutSec, cwd: WORKSPACE });
      const parts = [`exit code: ${r.exitCode}${r.timedOut ? ` (timed out after ${timeoutSec}s; process killed)` : ''}`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout.replace(/\s+$/, '')}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr.replace(/\s+$/, '')}`);
      return { content: parts.join('\n'), isError: r.exitCode !== 0 || r.timedOut };
    }
    case 'view_image': {
      const path = resolvePath(input.path, 'read');
      const buf = await readBinary(sandbox, path);
      let mediaType: ToolImage['mediaType'];
      if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mediaType = 'image/png';
      else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mediaType = 'image/jpeg';
      else throw new ToolError(`${path} is not a PNG or JPEG image`);
      if (buf.length > 5 * 1024 * 1024) throw new ToolError(`${path} is larger than 5 MB`);
      return { content: `Image ${path} (${buf.length} bytes) attached below.`, isError: false, images: [{ mediaType, dataBase64: buf.toString('base64') }] };
    }
  }
}
