/**
 * The research agent's modification surface. Everything else (limits, provider, evaluator,
 * benchmark, thresholds, token accounting) is out of bounds. Used both to validate the research
 * agent's raw proposal and again (defense in depth) by the optimizer before writing files.
 */
import type { AgentBackend, ToolName } from '../runner/types.js';
import { BIN_SHEBANG_RE, CLAUDE_CODE_ENV_ALLOWLIST, CLAUDE_CODE_HOOK_EVENTS, CLAUDE_CODE_SETTINGS_DENYLIST, DOC_PATH_RE } from '../runner/claude-code.js';
import { MAX_AGENTS, MAX_BIN_SCRIPTS, MAX_COMMANDS, validateClaudeCode } from '../runner/config.js';
import { GUARD_LIMITS, guardConfig, type GuardOptions } from './config-guard.js';

export const TOOL_NAMES: readonly ToolName[] = ['read_file', 'write_file', 'edit_file', 'list_dir', 'run_command', 'view_image'];

/** Top-level config.json fields the research agent may set. `model` only if allowed by settings. */
export const APPROVED_CONFIG_FIELDS = [
  'temperature',
  'maxOutputTokensPerCall',
  'thinkingBudget',
  'effort',
  'promptCaching',
  'designDelivery',
  'inlineSpecFiles',
  'context',
  'model',
  'claudeCode',
] as const;

/** Never changeable by the research agent (listed for clear error messages). */
export const FORBIDDEN_CONFIG_FIELDS = ['backend', 'provider', 'limits', 'id', 'parentId'] as const;

/** Claude Code built-in tool names the research agent may list in claudeCode.tools / disallowedTools. */
export const CLAUDE_CODE_BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Agent',
  'Skill',
  'WebFetch',
  'WebSearch',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
] as const;

export const APPROVED_CONTEXT_FIELDS = ['strategy', 'compactAtTokens', 'keepRecentToolResults'] as const;

export const SKILL_PATH_RE = /^skills\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;
/** claude-code only: helper scripts (installed at /opt/frugal/bin/<name>), subagents, slash commands. */
export const BIN_PATH_RE = /^bin\/[a-z][a-z0-9_-]{0,31}$/;
export const AGENT_PATH_RE = /^agents\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;
export const COMMAND_PATH_RE = /^commands\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;
/** docs/<path>: reference files installed read-only at /opt/frugal/docs (not auto-loaded). */
export function isDocPath(p: string): boolean {
  return p.startsWith('docs/') && DOC_PATH_RE.test(p.slice(5));
}

export const MAX_FILE_CHARS = 60_000;
export const MAX_SKILLS = 12;

export interface WhitelistOptions {
  allowModelChange: boolean;
  /** When non-empty, a model change must name one of these. */
  allowedModels?: string[];
  /**
   * Backend of the PARENT config (the research agent can never change it). Decides which part of the
   * surface applies: 'claude-code' allows claudeCode + CLAUDE.md and rejects api-only knobs.
   * Default: 'api'. Callers that know the parent files should use backendOfConfigFiles().
   */
  backend?: AgentBackend;
  /**
   * Anti-cheating guard (researcher/config-guard.ts) over the proposal's changed files. Violations are
   * returned as validation errors, so the research agent's single retry sees them. false disables it
   * (unit tests of the whitelist only). Default: guard with the default corpus (results/runs + reference app).
   */
  guard?: GuardOptions | false;
}

/** Backend declared by a config's config.json text (absent/invalid → 'api'). */
export function backendOfConfigFiles(files: Record<string, string>): AgentBackend {
  try {
    return JSON.parse(files['config.json'] ?? '{}').backend === 'claude-code' ? 'claude-code' : 'api';
  } catch {
    return 'api';
  }
}

/** The whitelist with `backend` filled in from the parent config files when the caller did not set it. */
export function withParentBackend(opts: WhitelistOptions, parentFiles: Record<string, string>): WhitelistOptions {
  return opts.backend ? opts : { ...opts, backend: backendOfConfigFiles(parentFiles) };
}

export type ProposalFiles = {
  'system-prompt.md'?: string;
  'tools.json'?: string;
  'config.json'?: Record<string, unknown>;
  'CLAUDE.md'?: string | null;
} & { [skillPath: `skills/${string}.md`]: string | null } & { [binPath: `bin/${string}`]: string | null } & {
  [agentPath: `agents/${string}.md`]: string | null;
} & { [commandPath: `commands/${string}.md`]: string | null } & { [docPath: `docs/${string}`]: string | null };

export interface Proposal {
  hypothesis: string;
  changeSummary: string;
  files: ProposalFiles;
}

export function isAllowedPath(p: string): boolean {
  return p === 'system-prompt.md' || p === 'tools.json' || p === 'config.json' || p === 'CLAUDE.md' || SKILL_PATH_RE.test(p) || isClaudeCodeOnlyPath(p);
}

/** bin/*, agents/*.md, commands/*.md, docs/**: only for configs with backend 'claude-code'. */
export function isClaudeCodeOnlyPath(p: string): boolean {
  return BIN_PATH_RE.test(p) || AGENT_PATH_RE.test(p) || COMMAND_PATH_RE.test(p) || isDocPath(p);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Validate a partial config.json patch. Returns error strings (empty = ok). */
export function validateConfigPatch(patch: unknown, opts: WhitelistOptions): string[] {
  const errs: string[] = [];
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return ['config.json must be an object of approved fields'];
  const cc = opts.backend === 'claude-code';
  for (const [k, v] of Object.entries(patch)) {
    if ((FORBIDDEN_CONFIG_FIELDS as readonly string[]).includes(k)) {
      errs.push(`config.json field "${k}" is not approved (forbidden: never changeable by the research agent)`);
      continue;
    }
    if (!(APPROVED_CONFIG_FIELDS as readonly string[]).includes(k)) {
      errs.push(`config.json field "${k}" is not approved (forbidden or unknown)`);
      continue;
    }
    switch (k) {
      case 'temperature':
        if (cc && v !== null) errs.push('temperature is not supported by the claude-code backend');
        else if (v !== null && (typeof v !== 'number' || v < 0 || v > 1)) errs.push('temperature must be a number in [0,1] or null');
        break;
      case 'maxOutputTokensPerCall':
        if (cc && v === 0) break; // 0 = Claude Code's default
        if (!isInt(v) || v < 256 || v > 128_000)
          errs.push(`maxOutputTokensPerCall must be an integer in [256,128000]${cc ? ' (or 0 = Claude Code default)' : ''}`);
        break;
      case 'promptCaching':
        if (typeof v !== 'boolean') errs.push('promptCaching must be boolean');
        else if (cc && v === false) errs.push('promptCaching cannot be turned off with the claude-code backend (Claude Code always caches)');
        break;
      case 'claudeCode': {
        if (!cc) {
          errs.push('claudeCode is only valid for configs with backend "claude-code" (the backend itself cannot be changed)');
          break;
        }
        errs.push(...validateClaudeCodePatch(v));
        break;
      }
      case 'thinkingBudget':
        if (v !== null && (!isInt(v) || v < 0 || v > 64_000)) errs.push('thinkingBudget must be an integer in [0,64000] or null');
        break;
      case 'effort':
        if (v !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(v as string))
          errs.push('effort must be low | medium | high | xhigh | max (or null for the model default)');
        break;
      case 'designDelivery':
        if (v !== 'inline-image' && v !== 'file-only') errs.push('designDelivery must be "inline-image" or "file-only"');
        break;
      case 'inlineSpecFiles':
        if (
          !Array.isArray(v) ||
          v.length > 10 ||
          !v.every((f) => typeof f === 'string' && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(f) && !f.split('/').includes('..'))
        )
          errs.push('inlineSpecFiles must be an array (<=10) of relative spec file names');
        break;
      case 'context': {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          errs.push('context must be an object');
          break;
        }
        for (const [ck, cv] of Object.entries(v)) {
          if (!(APPROVED_CONTEXT_FIELDS as readonly string[]).includes(ck)) errs.push(`context.${ck} is not approved`);
          else if (cc && ck === 'strategy' && cv !== 'none')
            errs.push('context.strategy must stay "none" with the claude-code backend (tune compaction via claudeCode.env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE / DISABLE_AUTO_COMPACT)');
          else if (ck === 'strategy' && !['none', 'drop-old-tool-results', 'summarize'].includes(cv as string))
            errs.push('context.strategy must be none | drop-old-tool-results | summarize');
          else if (ck === 'compactAtTokens' && cv !== null && (!isInt(cv) || cv < 1000 || cv > 1_000_000))
            errs.push('context.compactAtTokens must be an integer in [1000,1000000]');
          else if (ck === 'keepRecentToolResults' && cv !== null && (!isInt(cv) || cv < 0 || cv > 200))
            errs.push('context.keepRecentToolResults must be an integer in [0,200]');
        }
        break;
      }
      case 'model':
        if (!opts.allowModelChange) errs.push('changing "model" is not allowed by configs/research.json');
        else if (typeof v !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(v)) errs.push('model must be a model id string');
        else if (opts.allowedModels?.length && !opts.allowedModels.includes(v)) errs.push(`model must be one of: ${opts.allowedModels.join(', ')}`);
        break;
    }
  }
  return errs;
}

/**
 * Validate a claudeCode block (it replaces the parent's block as a whole). Delegates to the runner's
 * own config validation (runner/config.ts validateClaudeCode) so the two can never disagree, and
 * additionally restricts tool names to Claude Code's built-in set.
 */
export function validateClaudeCodePatch(v: unknown): string[] {
  if (v === null) return ['claudeCode cannot be removed (give the complete block instead)'];
  const errs: string[] = [];
  try {
    const parsed = validateClaudeCode('proposal', v);
    for (const field of ['tools', 'disallowedTools'] as const) {
      for (const t of parsed[field] ?? []) {
        const base = t.replace(/\(.*\)$/, '');
        if (!(CLAUDE_CODE_BUILTIN_TOOLS as readonly string[]).includes(base))
          errs.push(`claudeCode.${field}: "${t}" is not a Claude Code built-in tool (${CLAUDE_CODE_BUILTIN_TOOLS.join(', ')})`);
      }
    }
  } catch (e) {
    errs.push((e as Error).message);
  }
  return errs;
}

export { CLAUDE_CODE_ENV_ALLOWLIST, CLAUDE_CODE_SETTINGS_DENYLIST };

/** Validate tools.json content (a JSON array of ToolConfig). */
export function validateToolsJson(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return [`tools.json is not valid JSON: ${(e as Error).message}`];
  }
  if (!Array.isArray(parsed)) return ['tools.json must be a JSON array of tool configs'];
  const errs: string[] = [];
  const seen = new Set<string>();
  const allowedKeys = new Set(['name', 'enabled', 'description', 'maxOutputChars', 'outputMode', 'timeoutSec']);
  parsed.forEach((t, i) => {
    if (typeof t !== 'object' || t === null) return void errs.push(`tools[${i}] must be an object`);
    const o = t as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!allowedKeys.has(k)) errs.push(`tools[${i}].${k} is not a known tool field`);
    if (!TOOL_NAMES.includes(o.name as ToolName)) errs.push(`tools[${i}].name must be one of ${TOOL_NAMES.join(', ')}`);
    else if (seen.has(o.name as string)) errs.push(`tools[${i}].name duplicates ${o.name}`);
    else seen.add(o.name as string);
    if (typeof o.enabled !== 'boolean') errs.push(`tools[${i}].enabled must be boolean`);
    if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 4000))
      errs.push(`tools[${i}].description must be a string <= 4000 chars`);
    if (o.maxOutputChars !== undefined && (!isInt(o.maxOutputChars) || o.maxOutputChars < 200 || o.maxOutputChars > 1_000_000))
      errs.push(`tools[${i}].maxOutputChars must be an integer in [200,1000000]`);
    if (o.outputMode !== undefined && !['raw', 'truncate', 'summarize'].includes(o.outputMode as string))
      errs.push(`tools[${i}].outputMode must be raw | truncate | summarize`);
    if (o.timeoutSec !== undefined && (!isInt(o.timeoutSec) || o.timeoutSec < 1 || o.timeoutSec > 1800))
      errs.push(`tools[${i}].timeoutSec must be an integer in [1,1800]`);
  });
  if (!parsed.some((t) => (t as Record<string, unknown>)?.enabled === true)) errs.push('tools.json must enable at least one tool');
  return errs;
}

/** Validate the whole files map of a proposal. */
export function validateProposalFiles(files: unknown, opts: WhitelistOptions): string[] {
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return ['"files" must be an object'];
  const errs: string[] = [];
  const entries = Object.entries(files);
  if (entries.length === 0) errs.push('"files" must change at least one file');
  let skills = 0;
  let bins = 0;
  let agents = 0;
  let commands = 0;
  let docs = 0;
  for (const [path, content] of entries) {
    if (!isAllowedPath(path)) {
      errs.push(
        `path "${path}" is outside the allowed modification surface (system-prompt.md, tools.json, config.json, CLAUDE.md, skills/<name>.md${opts.backend === 'claude-code' ? ', bin/<name>, agents/<name>.md, commands/<name>.md, docs/<path>' : ''})`,
      );
      continue;
    }
    if (isClaudeCodeOnlyPath(path)) {
      if (opts.backend !== 'claude-code') errs.push(`${path}: bin/, agents/, commands/ and docs/ are only used by configs with backend "claude-code"`);
      else if (content !== null && typeof content !== 'string') errs.push(`${path} must be a string or null (delete)`);
      else if (typeof content === 'string') {
        const isBin = path.startsWith('bin/');
        const max = isBin ? GUARD_LIMITS.scriptFileBytes : isDocPath(path) ? GUARD_LIMITS.docsFileBytes : GUARD_LIMITS.mdFileBytes;
        if (!content.trim()) errs.push(`${path} must not be empty (use null to delete)`);
        else if (Buffer.byteLength(content, 'utf8') > max) errs.push(`${path} exceeds ${max} bytes`);
        else if (content.includes('\0')) errs.push(`${path} must be text`);
        else if (isBin && !BIN_SHEBANG_RE.test(content)) errs.push(`${path} must start with a shebang line: #!/bin/sh, #!/bin/bash, #!/usr/bin/env bash or #!/usr/bin/env node`);
      }
      if (path.startsWith('bin/')) bins++;
      else if (path.startsWith('agents/')) agents++;
      else if (isDocPath(path)) docs++;
      else commands++;
      continue;
    }
    if (path === 'CLAUDE.md') {
      if (opts.backend !== 'claude-code') errs.push('CLAUDE.md is only used by configs with backend "claude-code"');
      else if (content !== null && typeof content !== 'string') errs.push('CLAUDE.md must be a string or null (delete)');
      else if (typeof content === 'string' && (content.length > MAX_FILE_CHARS || !content.trim()))
        errs.push(`CLAUDE.md must be non-empty and at most ${MAX_FILE_CHARS} chars`);
      continue;
    }
    if (path === 'tools.json' && opts.backend === 'claude-code') {
      errs.push('tools.json is ignored by the claude-code backend; restrict tools with config.json claudeCode.tools / claudeCode.disallowedTools');
      continue;
    }
    if (path === 'config.json') {
      errs.push(...validateConfigPatch(content, opts));
    } else if (path.startsWith('skills/')) {
      skills++;
      if (content !== null && typeof content !== 'string') errs.push(`${path} must be a string or null (delete)`);
      else if (typeof content === 'string' && content.length > MAX_FILE_CHARS) errs.push(`${path} exceeds ${MAX_FILE_CHARS} chars`);
    } else {
      if (typeof content !== 'string') errs.push(`${path} must be a string`);
      else if (content.length > MAX_FILE_CHARS) errs.push(`${path} exceeds ${MAX_FILE_CHARS} chars`);
      else if (path === 'tools.json') errs.push(...validateToolsJson(content));
      else if (path === 'system-prompt.md' && content.trim() === '') errs.push('system-prompt.md must not be empty');
    }
  }
  if (skills > MAX_SKILLS) errs.push(`too many skill changes (max ${MAX_SKILLS})`);
  if (bins > MAX_BIN_SCRIPTS) errs.push(`too many bin/ changes (max ${MAX_BIN_SCRIPTS})`);
  if (agents > MAX_AGENTS) errs.push(`too many agents/ changes (max ${MAX_AGENTS})`);
  if (commands > MAX_COMMANDS) errs.push(`too many commands/ changes (max ${MAX_COMMANDS})`);
  if (docs > GUARD_LIMITS.docsMaxFiles) errs.push(`too many docs/ changes (max ${GUARD_LIMITS.docsMaxFiles})`);
  if (!errs.length && opts.guard !== false) errs.push(...guardProposalFiles(files as Record<string, unknown>, opts.guard ?? {}));
  return errs;
}

/**
 * Run the anti-cheating guard over the proposal's new/changed file contents (the merged config is
 * guarded again, including the total size, by optimizer.applyProposal).
 */
export function guardProposalFiles(files: Record<string, unknown>, guard: GuardOptions): string[] {
  const changed: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') changed[path] = content;
    else if (path === 'config.json' && content && typeof content === 'object') changed[path] = JSON.stringify(content);
  }
  if (!Object.keys(changed).length) return [];
  const r = guardConfig(changed, { ...guard, skipTotal: true });
  return r.violations.map((v) => `anti-cheating guard: ${v.file}: [${v.rule}] ${v.detail}`);
}

/**
 * Text for the research agent's system prompt: the claude-code extension surface and the guard rules.
 * Kept here so the prompt and the validation can never drift apart.
 */
export function claudeCodeSurfaceDoc(): string {
  return `- "bin/<name>" (name [a-z][a-z0-9_-]*, max ${MAX_BIN_SCRIPTS}, <= ${GUARD_LIMITS.scriptFileBytes} bytes each, shebang required: #!/bin/sh, #!/bin/bash, #!/usr/bin/env node): helper scripts installed read-only at /opt/frugal/bin (on PATH) in the coding container. Use them to replace many agent turns with one command, e.g. a "check" that builds, starts the server on a spare port with a temp DATABASE_PATH, smoke-tests the API with fetch and prints ONLY errors; or a compact project map. They may run builds, tests, linters, greps and node checks and may write only under /tmp. /opt/frugal/bin/<name> is a /bin/sh audit wrapper around your script: call scripts by name (e.g. "smoke 4789") or path, never as "node /opt/frugal/bin/<name>". Every run is logged; a bin script that creates or modifies app source fails the run. null deletes.
- "agents/<name>.md" (max ${MAX_AGENTS}): custom subagents (~/.claude/agents/). Frontmatter keys: name, description, tools, disallowedTools, color, model (only "inherit"). Subagents start a fresh conversation with its own overhead: use them only when that clearly saves tokens (e.g. a focused reviewer). null deletes.
- "commands/<name>.md" (max ${MAX_COMMANDS}): slash commands (~/.claude/commands/). Frontmatter keys: description, argument-hint, allowed-tools, disable-model-invocation, model (only "inherit"). null deletes.
- "docs/<path>" (any text files, up to 3 directory levels, <= ${GUARD_LIMITS.docsFileBytes / 1024} KB each, <= ${GUARD_LIMITS.docsTotalBytes / 1024} KB and ${GUARD_LIMITS.docsMaxFiles} files in total): reference material installed read-only at /opt/frugal/docs/<path> in the coding container (e.g. a codebase map or a feature-area guide). NOT loaded into context: it costs nothing until the agent reads a file, so tell it where to look (CLAUDE.md, system prompt or a skill). The guard rules below apply to docs too. null deletes.
- claudeCode.settings.hooks: Claude Code hooks, {"<Event>": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "/opt/frugal/bin/<name> [plain args]", "timeout": 10}]}]}. Events: ${CLAUDE_CODE_HOOK_EVENTS.join(', ')}. Commands may only call your own bin scripts (no shell syntax). Verified in Claude Code 2.1.325: the hook gets JSON on stdin (tool_name, tool_input, tool_response for PostToolUse; error for PostToolUseFailure). A PostToolUse hook can REPLACE what the model sees by printing {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{...tool_response, "stdout": "<trimmed>"}}} (Bash tool_response = {stdout, stderr, interrupted, isImage, noOutputExpected}). PostToolUseFailure (failed commands) cannot replace output. A PreToolUse hook can rewrite the command with {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...tool_input,"command":"<new>"}}}, e.g. pipe noisy commands through a clipping bin script (bash; keep the exit code with \${PIPESTATUS[0]}); this trims failing builds too. Printing nothing leaves the call unchanged. When a hook replaces output, also write "frugal: orig_chars=<N> new_chars=<M> tool_use_id=<tool_use_id from the input>" to stderr (exit 0 stderr never reaches the model) so run profiles can report the saving.
ANTI-CHEATING GUARD (automatic; violations reject the proposal): configs must not name any benchmark task's hidden feature (a fixed list of banned terms) and must not carry application code. Rejected: Express routes/handlers or server imports, the todos SQL schema or SQL data-access code, React components, JSX/HTML markup, fetch wrappers for /api, CSS rule blocks or design-token sheets (many hex colors + px values), scripts or snippets that write files into the app (frontend/, backend/, /workspace), base64/hex/compressed blobs or decoders, long string literals, more than ${GUARD_LIMITS.maxCodeBlockLines} lines in one code block or ${GUARD_LIMITS.maxCodeLinesPerFile} per markdown file, files over ${GUARD_LIMITS.mdFileBytes} bytes (markdown) / ${GUARD_LIMITS.scriptFileBytes} bytes (scripts), configs over ${GUARD_LIMITS.totalBytes} bytes, and any text that overlaps code from earlier runs' app snapshots (even renamed). Describe requirements in prose and give workflow advice; the coding agent must write the app itself every run.`;
}

export function validateProposal(raw: unknown, opts: WhitelistOptions): { ok: true; proposal: Proposal } | { ok: false; errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['proposal must be a JSON object'] };
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (!['hypothesis', 'changeSummary', 'files'].includes(k)) errors.push(`unknown top-level key "${k}"`);
  if (typeof o.hypothesis !== 'string' || o.hypothesis.trim().length < 5 || o.hypothesis.length > 2000)
    errors.push('"hypothesis" must be a string (5-2000 chars)');
  if (typeof o.changeSummary !== 'string' || o.changeSummary.trim().length < 3 || o.changeSummary.length > 2000)
    errors.push('"changeSummary" must be a string (3-2000 chars)');
  errors.push(...validateProposalFiles(o.files, opts));
  if (errors.length) return { ok: false, errors };
  return { ok: true, proposal: { hypothesis: (o.hypothesis as string).trim(), changeSummary: (o.changeSummary as string).trim(), files: o.files as ProposalFiles } };
}
