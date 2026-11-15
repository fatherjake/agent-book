/**
 * Agent configuration loading, validation, hashing and snapshotting.
 * On-disk layout: configs/<id>/{config.json, system-prompt.md, tools.json, skills/*.md}
 *   claude-code backend only (all optional): CLAUDE.md, bin/<name> (helper scripts, shebang required),
 *   agents/<name>.md (subagents), commands/<name>.md (slash commands).
 * loadConfig() also runs the anti-cheating guard (researcher/config-guard.ts) on every config except
 * 'baseline-api', so hand-made configs cannot bypass it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AgentConfig, ClaudeCodeConfig, ContextConfig, RunLimits, ToolConfig } from './types.js';
import { CONFIGS_DIR } from './env.js';
import { ALL_TOOLS } from './tools.js';
import {
  BIN_NAME_RE,
  BIN_SHEBANG_RE,
  CLAUDE_CODE_ENV_ALLOWLIST,
  CLAUDE_CODE_HOOK_EVENTS,
  CLAUDE_CODE_PERMISSIONS_KEYS,
  CLAUDE_CODE_SETTINGS_DENYLIST,
  CLAUDE_CODE_VERSION,
  HOOK_COMMAND_RE,
} from './claude-code.js';
import { formatViolations, guardConfig } from '../researcher/config-guard.js';

export class ConfigError extends Error {
  constructor(where: string, msg: string) {
    super(`Invalid agent config (${where}): ${msg}`);
    this.name = 'ConfigError';
  }
}

const CONFIG_JSON_KEYS = new Set([
  'id',
  'parentId',
  'description',
  'provider',
  'model',
  'temperature',
  'maxOutputTokensPerCall',
  'thinkingBudget',
  'effort',
  'promptCaching',
  'designDelivery',
  'inlineSpecFiles',
  'context',
  'limits',
  'backend',
  'claudeCode',
]);
const CLAUDE_CODE_KEYS = new Set(['systemPromptMode', 'tools', 'disallowedTools', 'settings', 'env', 'claudeMd']);
const BACKENDS = new Set(['api', 'claude-code']);
const TOOL_KEYS = new Set(['name', 'enabled', 'description', 'maxOutputChars', 'outputMode', 'timeoutSec']);
const CONTEXT_KEYS = new Set(['strategy', 'compactAtTokens', 'keepRecentToolResults']);
const LIMIT_KEYS = new Set(['maxTotalTokens', 'maxModelCalls', 'maxRuntimeSec']);
const PROVIDERS = new Set(['anthropic', 'mock']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function checkKeys(where: string, obj: Record<string, unknown>, allowed: Set<string>) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new ConfigError(where, `unknown field '${k}' (allowed: ${[...allowed].join(', ')})`);
}
function int(where: string, field: string, v: unknown, min: number, max: number, optional = false): number | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(where, `'${field}' must be an integer in [${min}, ${max}] (got ${JSON.stringify(v)})`);
  return v;
}
function strField(where: string, field: string, v: unknown, optional = false): string | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(where, `'${field}' must be a non-empty string`);
  return v;
}

export function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(id) || id.split('/').includes('..')) {
    throw new ConfigError(String(id), `config id must look like 'baseline' or 'experiments/001'`);
  }
}

export function validateTools(where: string, raw: unknown): ToolConfig[] {
  if (!Array.isArray(raw)) throw new ConfigError(where, 'tools.json must be a JSON array of tool configs');
  const seen = new Set<string>();
  return raw.map((t, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(t)) throw new ConfigError(w, 'tool config must be an object');
    checkKeys(w, t, TOOL_KEYS);
    if (typeof t.name !== 'string' || !(ALL_TOOLS as string[]).includes(t.name)) throw new ConfigError(w, `'name' must be one of ${ALL_TOOLS.join(', ')}`);
    if (seen.has(t.name)) throw new ConfigError(w, `duplicate tool '${t.name}'`);
    seen.add(t.name);
    if (typeof t.enabled !== 'boolean') throw new ConfigError(w, `'enabled' must be a boolean`);
    const out: ToolConfig = { name: t.name as ToolConfig['name'], enabled: t.enabled };
    if (t.description !== undefined) out.description = strField(w, 'description', t.description);
    if (t.maxOutputChars !== undefined) out.maxOutputChars = int(w, 'maxOutputChars', t.maxOutputChars, 200, 1_000_000);
    if (t.outputMode !== undefined) {
      if (!['raw', 'truncate', 'summarize'].includes(t.outputMode as string)) throw new ConfigError(w, `'outputMode' must be raw | truncate | summarize`);
      out.outputMode = t.outputMode as ToolConfig['outputMode'];
    }
    if (t.timeoutSec !== undefined) {
      if (t.name !== 'run_command') throw new ConfigError(w, `'timeoutSec' is only valid for run_command`);
      out.timeoutSec = int(w, 'timeoutSec', t.timeoutSec, 1, 900);
    }
    return out;
  });
}

function validateContext(where: string, raw: unknown): ContextConfig {
  if (raw === undefined) return { strategy: 'none' };
  if (!isObj(raw)) throw new ConfigError(where, `'context' must be an object`);
  checkKeys(`${where}.context`, raw, CONTEXT_KEYS);
  if (!['none', 'drop-old-tool-results', 'summarize'].includes(raw.strategy as string))
    throw new ConfigError(where, `'context.strategy' must be none | drop-old-tool-results | summarize`);
  const out: ContextConfig = { strategy: raw.strategy as ContextConfig['strategy'] };
  if (raw.compactAtTokens !== undefined) out.compactAtTokens = int(where, 'context.compactAtTokens', raw.compactAtTokens, 1000, 1_000_000);
  if (raw.keepRecentToolResults !== undefined) out.keepRecentToolResults = int(where, 'context.keepRecentToolResults', raw.keepRecentToolResults, 0, 1000);
  if (out.strategy !== 'none' && out.compactAtTokens === undefined) throw new ConfigError(where, `'context.compactAtTokens' is required when strategy is '${out.strategy}'`);
  return out;
}

function validateLimits(where: string, raw: unknown): RunLimits {
  if (!isObj(raw)) throw new ConfigError(where, `'limits' must be an object with maxTotalTokens, maxModelCalls, maxRuntimeSec`);
  checkKeys(`${where}.limits`, raw, LIMIT_KEYS);
  return {
    maxTotalTokens: int(where, 'limits.maxTotalTokens', raw.maxTotalTokens, 1000, 100_000_000)!,
    maxModelCalls: int(where, 'limits.maxModelCalls', raw.maxModelCalls, 1, 10_000)!,
    maxRuntimeSec: int(where, 'limits.maxRuntimeSec', raw.maxRuntimeSec, 10, 86_400)!,
  };
}

/** Validate the `claudeCode` block (backend 'claude-code'). */
export function validateClaudeCode(where: string, raw: unknown): ClaudeCodeConfig {
  if (raw === undefined) return { systemPromptMode: 'append' };
  if (!isObj(raw)) throw new ConfigError(where, `'claudeCode' must be an object`);
  checkKeys(`${where}.claudeCode`, raw, CLAUDE_CODE_KEYS);
  if (raw.systemPromptMode !== 'append' && raw.systemPromptMode !== 'replace') throw new ConfigError(where, `'claudeCode.systemPromptMode' must be append | replace`);
  const out: ClaudeCodeConfig = { systemPromptMode: raw.systemPromptMode };
  const toolList = (field: string, v: unknown, re: RegExp): string[] => {
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || !re.test(t)) || new Set(v).size !== v.length)
      throw new ConfigError(where, `'claudeCode.${field}' must be an array of unique Claude Code tool names (e.g. "Bash", "Read")`);
    return v as string[];
  };
  if (raw.tools !== undefined) out.tools = toolList('tools', raw.tools, /^[A-Z][A-Za-z0-9_]{0,63}$/);
  if (raw.disallowedTools !== undefined) out.disallowedTools = toolList('disallowedTools', raw.disallowedTools, /^[A-Z][A-Za-z0-9_]{0,63}(\([^()\n]{1,200}\))?$/);
  if (raw.settings !== undefined) {
    if (!isObj(raw.settings)) throw new ConfigError(where, `'claudeCode.settings' must be an object`);
    for (const k of Object.keys(raw.settings))
      if ((CLAUDE_CODE_SETTINGS_DENYLIST as readonly string[]).includes(k))
        throw new ConfigError(where, `'claudeCode.settings.${k}' is not allowed (denied keys: ${CLAUDE_CODE_SETTINGS_DENYLIST.join(', ')})`);
    if (JSON.stringify(raw.settings).length > 20_000) throw new ConfigError(where, `'claudeCode.settings' is too large (max 20000 chars of JSON)`);
    if (raw.settings.permissions !== undefined) validatePermissions(where, raw.settings.permissions);
    if (raw.settings.hooks !== undefined) validateHooks(where, raw.settings.hooks);
    out.settings = raw.settings;
  }
  if (raw.env !== undefined) {
    if (!isObj(raw.env)) throw new ConfigError(where, `'claudeCode.env' must be an object of string values`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (!(CLAUDE_CODE_ENV_ALLOWLIST as readonly string[]).includes(k))
        throw new ConfigError(where, `'claudeCode.env.${k}' is not allowed (allowed: ${CLAUDE_CODE_ENV_ALLOWLIST.join(', ')})`);
      if (typeof v !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(v)) throw new ConfigError(where, `'claudeCode.env.${k}' must be a short string of [A-Za-z0-9._:-]`);
      env[k] = v;
    }
    out.env = env;
  }
  if (raw.claudeMd !== undefined) {
    if (typeof raw.claudeMd !== 'boolean') throw new ConfigError(where, `'claudeCode.claudeMd' must be a boolean`);
    out.claudeMd = raw.claudeMd;
  }
  return out;
}

/** settings.permissions: only allow/deny/ask rule lists (no defaultMode, additionalDirectories, ...). */
function validatePermissions(where: string, p: unknown): void {
  if (!isObj(p)) throw new ConfigError(where, `'claudeCode.settings.permissions' must be an object`);
  for (const [k, v] of Object.entries(p)) {
    if (!(CLAUDE_CODE_PERMISSIONS_KEYS as readonly string[]).includes(k))
      throw new ConfigError(where, `'claudeCode.settings.permissions.${k}' is not allowed (allowed: ${CLAUDE_CODE_PERMISSIONS_KEYS.join(', ')})`);
    if (!Array.isArray(v) || v.length > 50 || v.some((r) => typeof r !== 'string' || r.length > 200))
      throw new ConfigError(where, `'claudeCode.settings.permissions.${k}' must be an array (<=50) of rule strings`);
  }
}

/** Max hook handlers in one config (all events together). */
export const MAX_HOOK_HANDLERS = 16;

/**
 * settings.hooks: { <Event>: [{ matcher?: string, hooks: [{ type: 'command', command, timeout? }] }] }.
 * Only command hooks whose command is `/opt/frugal/bin/<name> [plain args]` (no shell syntax).
 * Returns the referenced bin names (loadConfigFromDir checks that each exists in bin/).
 */
export function validateHooks(where: string, hooks: unknown): string[] {
  const w = `${where}: claudeCode.settings.hooks`;
  if (!isObj(hooks)) throw new ConfigError(w, 'must be an object keyed by hook event');
  const names = new Set<string>();
  let handlers = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!(CLAUDE_CODE_HOOK_EVENTS as readonly string[]).includes(event))
      throw new ConfigError(w, `unknown hook event '${event}' (allowed: ${CLAUDE_CODE_HOOK_EVENTS.join(', ')})`);
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 8) throw new ConfigError(w, `'${event}' must be a non-empty array (<=8) of matcher entries`);
    entries.forEach((m, i) => {
      const mw = `${event}[${i}]`;
      if (!isObj(m)) throw new ConfigError(w, `${mw} must be an object`);
      for (const k of Object.keys(m)) if (k !== 'matcher' && k !== 'hooks') throw new ConfigError(w, `${mw}: unknown field '${k}' (allowed: matcher, hooks)`);
      if (m.matcher !== undefined && (typeof m.matcher !== 'string' || m.matcher.length > 200 || /[\n\r]/.test(m.matcher)))
        throw new ConfigError(w, `${mw}.matcher must be a single-line string (<=200 chars)`);
      if (!Array.isArray(m.hooks) || m.hooks.length === 0 || m.hooks.length > 4) throw new ConfigError(w, `${mw}.hooks must be a non-empty array (<=4)`);
      m.hooks.forEach((h, j) => {
        const hw = `${mw}.hooks[${j}]`;
        if (!isObj(h)) throw new ConfigError(w, `${hw} must be an object`);
        for (const k of Object.keys(h)) if (!['type', 'command', 'timeout'].includes(k)) throw new ConfigError(w, `${hw}: unknown field '${k}' (allowed: type, command, timeout)`);
        if (h.type !== 'command') throw new ConfigError(w, `${hw}.type must be 'command' (prompt/agent/http hooks are not allowed)`);
        const cmd = typeof h.command === 'string' ? HOOK_COMMAND_RE.exec(h.command) : null;
        if (!cmd) throw new ConfigError(w, `${hw}.command must be '/opt/frugal/bin/<name>' plus optional plain arguments (no shell syntax); got ${JSON.stringify(h.command)}`);
        if (h.timeout !== undefined && (typeof h.timeout !== 'number' || !Number.isInteger(h.timeout) || h.timeout < 1 || h.timeout > 120))
          throw new ConfigError(w, `${hw}.timeout must be an integer in [1, 120] seconds`);
        names.add(cmd[1]);
        handlers++;
      });
    });
  }
  if (handlers > MAX_HOOK_HANDLERS) throw new ConfigError(w, `too many hook handlers (${handlers} > ${MAX_HOOK_HANDLERS})`);
  return [...names];
}

/** Limits for the optional claude-code dirs (content size limits are the guard's, see researcher/config-guard.ts). */
export const MAX_BIN_SCRIPTS = 8;
export const MAX_AGENTS = 8;
export const MAX_COMMANDS = 8;
/** Markdown name for skills/agents/commands files. */
export const MD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Frontmatter keys allowed in agents/<name>.md and commands/<name>.md. */
export const AGENT_FRONTMATTER_KEYS = ['name', 'description', 'tools', 'disallowedTools', 'model', 'color'] as const;
export const COMMAND_FRONTMATTER_KEYS = ['description', 'argument-hint', 'allowed-tools', 'model', 'disable-model-invocation'] as const;

/** Top-level keys of a leading YAML frontmatter block (null when there is none). */
export function frontmatter(content: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Frontmatter must not pick another model (model changes go through the whitelist) or add unknown keys. */
function checkFrontmatter(where: string, file: string, content: string, allowed: readonly string[] | null): void {
  const fm = frontmatter(content);
  if (!fm) return;
  if (fm.model !== undefined && fm.model !== 'inherit') throw new ConfigError(where, `${file}: frontmatter 'model' may only be 'inherit' (got '${fm.model}')`);
  if (allowed) for (const k of Object.keys(fm)) if (!allowed.includes(k)) throw new ConfigError(where, `${file}: frontmatter key '${k}' is not allowed (allowed: ${allowed.join(', ')})`);
}

/** Read <dir>/<sub>/ entries: names validated, text only (no NUL), non-empty. Missing dir = []. */
function readNamedFiles(where: string, dir: string, sub: string, opts: { ext: '' | '.md'; nameRe: RegExp; max: number; maxBytes: number }): { name: string; content: string }[] {
  const d = join(dir, sub);
  if (!existsSync(d)) return [];
  if (!statSync(d).isDirectory()) throw new ConfigError(where, `${sub} must be a directory`);
  const out: { name: string; content: string }[] = [];
  for (const f of readdirSync(d).sort()) {
    if (f.startsWith('.')) continue;
    const p = join(d, f);
    if (!statSync(p).isFile()) throw new ConfigError(where, `${sub}/${f} must be a regular file`);
    const name = opts.ext ? (f.endsWith(opts.ext) ? f.slice(0, -opts.ext.length) : null) : f;
    if (name === null || !opts.nameRe.test(name)) throw new ConfigError(where, `${sub}/${f}: invalid file name (expected ${sub}/<${opts.nameRe.source}>${opts.ext})`);
    const buf = readFileSync(p);
    if (buf.length > opts.maxBytes) throw new ConfigError(where, `${sub}/${f} is too large (${buf.length} > ${opts.maxBytes} bytes)`);
    if (buf.includes(0)) throw new ConfigError(where, `${sub}/${f} must be a text file`);
    const content = buf.toString('utf8');
    if (!content.trim()) throw new ConfigError(where, `${sub}/${f} is empty`);
    out.push({ name, content });
  }
  if (out.length > opts.max) throw new ConfigError(where, `too many files in ${sub}/ (${out.length} > ${opts.max})`);
  return out;
}

/** Load and strictly validate a config from an explicit directory. */
export function loadConfigFromDir(dir: string, id?: string): AgentConfig {
  const where = id ?? dir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ConfigError(where, `config directory not found: ${dir}`);
  const readJson = (file: string): unknown => {
    const p = join(dir, file);
    if (!existsSync(p)) throw new ConfigError(where, `missing ${file}`);
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new ConfigError(where, `${file} is not valid JSON: ${(e as Error).message}`);
    }
  };
  const raw = readJson('config.json');
  if (!isObj(raw)) throw new ConfigError(where, 'config.json must be a JSON object');
  checkKeys(`${where}/config.json`, raw, CONFIG_JSON_KEYS);
  const cfgId = id ?? (raw.id as string | undefined);
  if (!cfgId) throw new ConfigError(where, 'config id unknown (pass an id or set "id" in config.json)');
  validateId(cfgId);
  if (raw.id !== undefined && id !== undefined && raw.id !== id) throw new ConfigError(where, `config.json id '${String(raw.id)}' does not match directory id '${id}'`);

  const provider = strField(where, 'provider', raw.provider)!;
  if (!PROVIDERS.has(provider)) throw new ConfigError(where, `'provider' must be one of ${[...PROVIDERS].join(', ')}`);
  const model = strField(where, 'model', raw.model)!;
  if (raw.backend !== undefined && !BACKENDS.has(raw.backend as string)) throw new ConfigError(where, `'backend' must be api | claude-code`);
  const isCC = raw.backend === 'claude-code';
  if (raw.claudeCode !== undefined && !isCC) throw new ConfigError(where, `'claudeCode' is only valid with backend 'claude-code'`);
  if (isCC) {
    if (provider !== 'anthropic') throw new ConfigError(where, `backend 'claude-code' requires provider 'anthropic'`);
    if (raw.temperature !== undefined) throw new ConfigError(where, `'temperature' is not supported by backend 'claude-code'`);
    if (raw.promptCaching === undefined) raw.promptCaching = true; // Claude Code always caches; informational only
    if (raw.maxOutputTokensPerCall === undefined) raw.maxOutputTokensPerCall = 0; // 0 = Claude Code's default
  }
  if (typeof raw.promptCaching !== 'boolean') throw new ConfigError(where, `'promptCaching' must be a boolean`);
  if (raw.designDelivery !== 'inline-image' && raw.designDelivery !== 'file-only') throw new ConfigError(where, `'designDelivery' must be inline-image | file-only`);
  const inlineSpecFiles = raw.inlineSpecFiles ?? [];
  if (!Array.isArray(inlineSpecFiles) || inlineSpecFiles.some((f) => typeof f !== 'string' || f.includes('..') || f.startsWith('/')))
    throw new ConfigError(where, `'inlineSpecFiles' must be an array of file names relative to the spec directory`);
  if (raw.temperature !== undefined && (typeof raw.temperature !== 'number' || raw.temperature < 0 || raw.temperature > 1))
    throw new ConfigError(where, `'temperature' must be a number in [0, 1]`);
  if (raw.effort !== undefined && !EFFORTS.has(raw.effort as string)) throw new ConfigError(where, `'effort' must be one of ${[...EFFORTS].join(', ')}`);

  const systemPromptPath = join(dir, 'system-prompt.md');
  if (!existsSync(systemPromptPath)) throw new ConfigError(where, 'missing system-prompt.md');
  const systemPrompt = readFileSync(systemPromptPath, 'utf8');
  if (!systemPrompt.trim()) throw new ConfigError(where, 'system-prompt.md is empty');

  // tools.json configures the 'api' backend's tools. For 'claude-code' it is optional, validated when
  // present, and ignored (Claude Code tools are set with claudeCode.tools / disallowedTools).
  const tools = isCC && !existsSync(join(dir, 'tools.json')) ? [] : validateTools(`${where}/tools.json`, readJson('tools.json'));
  if (!isCC && !tools.some((t) => t.enabled)) throw new ConfigError(where, 'at least one tool must be enabled');

  const skillsDir = join(dir, 'skills');
  const skills: AgentConfig['skills'] = [];
  if (existsSync(skillsDir)) {
    for (const f of readdirSync(skillsDir).sort()) {
      if (f.startsWith('.')) continue;
      if (!f.endsWith('.md')) throw new ConfigError(where, `skills/ may only contain .md files (found ${f})`);
      const content = readFileSync(join(skillsDir, f), 'utf8');
      if (!content.trim()) throw new ConfigError(where, `skills/${f} is empty`);
      checkFrontmatter(where, `skills/${f}`, content, null);
      skills.push({ name: f.slice(0, -3), content });
    }
  }

  const cfg: AgentConfig = {
    id: cfgId,
    provider,
    model,
    maxOutputTokensPerCall: isCC && raw.maxOutputTokensPerCall === 0 ? 0 : int(where, 'maxOutputTokensPerCall', raw.maxOutputTokensPerCall, 256, 128_000)!,
    promptCaching: raw.promptCaching,
    designDelivery: raw.designDelivery,
    inlineSpecFiles: inlineSpecFiles as string[],
    systemPrompt,
    skills,
    tools,
    context: validateContext(where, raw.context),
    limits: validateLimits(where, raw.limits),
  };
  if (raw.parentId !== undefined) cfg.parentId = strField(where, 'parentId', raw.parentId);
  if (raw.description !== undefined) cfg.description = String(raw.description);
  if (raw.temperature !== undefined) cfg.temperature = raw.temperature as number;
  if (raw.thinkingBudget !== undefined) cfg.thinkingBudget = int(where, 'thinkingBudget', raw.thinkingBudget, 0, 128_000);
  if (raw.effort !== undefined) cfg.effort = raw.effort as AgentConfig['effort'];
  if (raw.backend !== undefined) cfg.backend = raw.backend as AgentConfig['backend'];
  if (isCC) {
    const cc = validateClaudeCode(where, raw.claudeCode);
    if (cfg.context.strategy !== 'none') throw new ConfigError(where, `backend 'claude-code' requires context.strategy 'none' (use claudeCode.env DISABLE_AUTO_COMPACT / CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)`);
    if (cfg.thinkingBudget !== undefined && cc.env?.MAX_THINKING_TOKENS !== undefined) throw new ConfigError(where, `set either 'thinkingBudget' or claudeCode.env.MAX_THINKING_TOKENS, not both`);
    if (cfg.maxOutputTokensPerCall > 0 && cc.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS !== undefined)
      throw new ConfigError(where, `set either 'maxOutputTokensPerCall' or claudeCode.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, not both`);
    cfg.claudeCode = cc;
    const mdPath = join(dir, 'CLAUDE.md');
    if (cc.claudeMd) {
      if (!existsSync(mdPath)) throw new ConfigError(where, `claudeCode.claudeMd is true but CLAUDE.md is missing`);
      const md = readFileSync(mdPath, 'utf8');
      if (!md.trim()) throw new ConfigError(where, 'CLAUDE.md is empty');
      cfg.claudeMdContent = md;
    }
    const bin = readNamedFiles(where, dir, 'bin', { ext: '', nameRe: BIN_NAME_RE, max: MAX_BIN_SCRIPTS, maxBytes: 64 * 1024 });
    for (const b of bin) if (!BIN_SHEBANG_RE.test(b.content)) throw new ConfigError(where, `bin/${b.name} must start with a shebang line (#!/bin/sh, #!/bin/bash, #!/usr/bin/env node, ...)`);
    const agents = readNamedFiles(where, dir, 'agents', { ext: '.md', nameRe: MD_NAME_RE, max: MAX_AGENTS, maxBytes: 64 * 1024 });
    for (const a of agents) checkFrontmatter(where, `agents/${a.name}.md`, a.content, AGENT_FRONTMATTER_KEYS);
    const commands = readNamedFiles(where, dir, 'commands', { ext: '.md', nameRe: MD_NAME_RE, max: MAX_COMMANDS, maxBytes: 64 * 1024 });
    for (const c of commands) checkFrontmatter(where, `commands/${c.name}.md`, c.content, COMMAND_FRONTMATTER_KEYS);
    if (cc.settings?.hooks !== undefined) {
      const have = new Set(bin.map((b) => b.name));
      for (const n of validateHooks(where, cc.settings.hooks))
        if (!have.has(n)) throw new ConfigError(where, `claudeCode.settings.hooks references /opt/frugal/bin/${n}, but bin/${n} does not exist`);
    }
    // Only set when present, so configs without these dirs keep their hashes.
    if (bin.length) cfg.bin = bin;
    if (agents.length) cfg.agents = agents;
    if (commands.length) cfg.commands = commands;
  } else {
    for (const sub of ['bin', 'agents', 'commands'])
      if (existsSync(join(dir, sub)) && readdirSync(join(dir, sub)).some((f) => !f.startsWith('.')))
        throw new ConfigError(where, `${sub}/ is only supported with backend 'claude-code'`);
  }
  return cfg;
}

/** Configs exempt from the anti-cheating guard at load time (the api reference baseline). */
export const GUARD_EXEMPT_CONFIG_IDS = ['baseline-api'] as const;

export interface LoadConfigOptions {
  configsDir?: string;
  /**
   * Run the anti-cheating guard (default true; GUARD_EXEMPT_CONFIG_IDS are always skipped). A violation
   * throws a ConfigError listing every violation. Tests may pass false or guard options.
   */
  guard?: boolean | import('../researcher/config-guard.js').GuardOptions;
}

/**
 * loadConfig('baseline' | 'experiments/001'), resolved under configs/. An explicit directory path
 * ('/abs/dir', './dir', '../dir') is also accepted (scratch configs); its id becomes 'local/<dirname>'.
 */
export function loadConfig(id: string, opts: LoadConfigOptions = {}): AgentConfig {
  let dir: string;
  let cfgId: string;
  if (/^(\/|\.\.?\/)/.test(id)) {
    dir = resolve(id);
    cfgId = `local/${basename(dir)}`;
    validateId(cfgId);
  } else {
    validateId(id);
    const root = resolve(opts.configsDir ?? CONFIGS_DIR);
    dir = resolve(root, id);
    if (!dir.startsWith(root + '/')) throw new ConfigError(id, 'config id escapes the configs directory');
    cfgId = id;
  }
  const cfg = loadConfigFromDir(dir, cfgId);
  if (opts.guard !== false && !(GUARD_EXEMPT_CONFIG_IDS as readonly string[]).includes(cfgId)) {
    const g = typeof opts.guard === 'object' ? opts.guard : {};
    const verdict = guardConfig(dir, { ...g, excludeConfigHashes: [...(g.excludeConfigHashes ?? []), hashConfig(cfg)] });
    if (!verdict.ok) throw new ConfigError(cfgId, `rejected by the anti-cheating guard (researcher/config-guard.ts):\n${formatViolations(verdict.violations)}`);
  }
  return cfg;
}

/** JSON with recursively sorted object keys. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (isObj(x)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = norm(x[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * sha256 over the canonical JSON of everything that affects agent behaviour. Metadata
 * (id, parentId, description) is excluded so identical configurations hash identically.
 * New fields (backend, claudeCode, claudeMdContent) are covered automatically; absent fields don't
 * change the hash, so existing 'api' configs keep their hashes. For backend 'claude-code' the ignored
 * tools.json is left out and the pinned Claude Code version is added (it changes agent behaviour).
 */
export function hashConfig(cfg: AgentConfig): string {
  const { id: _id, parentId: _p, description: _d, ...behaviour } = cfg;
  // backend 'api' is the default: hash it like an absent field so existing configs keep their hashes.
  if (behaviour.backend === 'api') delete behaviour.backend;
  if (cfg.backend === 'claude-code') {
    const { tools: _t, ...cc } = behaviour;
    return createHash('sha256').update(canonicalJson({ ...cc, claudeCodeVersion: CLAUDE_CODE_VERSION })).digest('hex');
  }
  return createHash('sha256').update(canonicalJson(behaviour)).digest('hex');
}

/** Write a loadable copy of the config (same on-disk layout) plus resolved.json and hash.txt. */
export function snapshotConfig(cfg: AgentConfig, destDir: string): void {
  mkdirSync(join(destDir, 'skills'), { recursive: true });
  const { systemPrompt, skills, tools, claudeMdContent, bin, agents, commands, ...rest } = cfg;
  const writeDir = (sub: string, files: { name: string; content: string }[] | undefined, ext: string) => {
    if (!files?.length) return;
    mkdirSync(join(destDir, sub), { recursive: true });
    for (const f of files) writeFileSync(join(destDir, sub, f.name + ext), f.content, sub === 'bin' ? { mode: 0o755 } : undefined);
  };
  writeDir('bin', bin, '');
  writeDir('agents', agents, '.md');
  writeDir('commands', commands, '.md');
  writeFileSync(join(destDir, 'config.json'), JSON.stringify(rest, null, 2) + '\n');
  if (claudeMdContent !== undefined) writeFileSync(join(destDir, 'CLAUDE.md'), claudeMdContent);
  writeFileSync(join(destDir, 'system-prompt.md'), systemPrompt);
  writeFileSync(join(destDir, 'tools.json'), JSON.stringify(tools, null, 2) + '\n');
  for (const s of skills) writeFileSync(join(destDir, 'skills', `${s.name}.md`), s.content);
  writeFileSync(join(destDir, 'resolved.json'), JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync(join(destDir, 'hash.txt'), hashConfig(cfg) + '\n');
}
