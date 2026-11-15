/**
 * Applies a research proposal to a parent config, producing a NEW immutable candidate directory
 * configs/experiments/<NNN>/ (never reused). Enforces the whitelist again (defense in depth) and the
 * anti-cheating guard (researcher/config-guard.ts) on the merged candidate before anything is written.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Db } from '../storage/db.js';
import { diffFileSets } from './diff.js';
import { loadConfigFromDir } from '../runner/config.js';
import { isAllowedPath, validateProposal, withParentBackend, type Proposal, type WhitelistOptions } from './whitelist.js';
import { formatViolations, guardConfig, type GuardOptions, type GuardViolation } from './config-guard.js';

export const DEFAULT_CONFIGS_ROOT = 'configs';
const META_FILE = 'meta.json';

export class OptimizerError extends Error {
  constructor(
    message: string,
    readonly errors: string[] = [],
    /** Set when the anti-cheating guard rejected the candidate. */
    readonly violations?: GuardViolation[],
  ) {
    super(errors.length ? `${message}: ${errors.join('; ')}` : message);
    this.name = 'OptimizerError';
  }
}

export interface ConfigMeta {
  id: string;
  parentId: string;
  hypothesis: string;
  changeSummary: string;
  changes: string;
  createdAt: string;
  hash: string;
  experimentId?: string;
  /** Research agent's cited evidence (runs/turns/tool calls) for the hypothesis. */
  evidence?: string;
  /** Research agent's expected token savings. */
  expectedSavings?: string;
}

export interface AppliedConfig {
  configId: string; // 'experiments/007'
  dir: string;
  hash: string;
  diff: string;
  meta: ConfigMeta;
  files: Record<string, string>;
}

export interface ApplyOptions {
  parentConfigId: string;
  proposal: Proposal;
  whitelist: WhitelistOptions;
  configsRoot?: string;
  db?: Db;
  experimentId?: string;
  now?: () => Date;
  /** Anti-cheating guard options for the merged candidate (default: whitelist.guard, else the default corpus). */
  guard?: GuardOptions | false;
  /** Extra research fields written into meta.json (not part of the config; not hashed). */
  research?: { evidence?: string; expectedSavings?: string };
}

/** Read a config directory's modifiable files (config.json, system-prompt.md, tools.json, CLAUDE.md, skills/*.md, bin/*, agents/*.md, commands/*.md, docs/**). */
export function readConfigFiles(configId: string, configsRoot: string = DEFAULT_CONFIGS_ROOT): Record<string, string> {
  const dir = configDir(configId, configsRoot);
  if (!existsSync(dir)) throw new OptimizerError(`config directory not found: ${dir}`);
  const out: Record<string, string> = {};
  for (const f of ['config.json', 'system-prompt.md', 'tools.json', 'CLAUDE.md']) {
    const p = join(dir, f);
    if (existsSync(p)) out[f] = readFileSync(p, 'utf8');
  }
  for (const sub of ['skills', 'bin', 'agents', 'commands']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      const rel = `${sub}/${f}`;
      if (isAllowedPath(rel) && statSync(join(d, f)).isFile()) out[rel] = readFileSync(join(d, f), 'utf8');
    }
  }
  // docs/ may be nested (docs/<dir>/<file>, up to 3 levels).
  const walkDocs = (d: string, rel: string, depth: number) => {
    if (!existsSync(d) || depth > 4) return;
    for (const f of readdirSync(d).sort()) {
      if (f.startsWith('.')) continue;
      const p = join(d, f);
      const r = `${rel}/${f}`;
      if (statSync(p).isDirectory()) walkDocs(p, r, depth + 1);
      else if (isAllowedPath(r) && statSync(p).isFile()) out[r] = readFileSync(p, 'utf8');
    }
  };
  walkDocs(join(dir, 'docs'), 'docs', 1);
  return out;
}

export function configDir(configId: string, configsRoot: string = DEFAULT_CONFIGS_ROOT): string {
  if (!/^(baseline|experiments\/\d{3,})$/.test(configId)) throw new OptimizerError(`invalid config id "${configId}"`);
  const root = resolve(configsRoot);
  const dir = resolve(root, configId);
  if (!dir.startsWith(root + sep)) throw new OptimizerError(`config id escapes configs root: ${configId}`);
  return dir;
}

/** sha256 over the sorted (path, sha256(content)) list of a file set. */
export function hashFiles(files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const p of Object.keys(files).sort()) {
    h.update(p);
    h.update('\0');
    h.update(createHash('sha256').update(files[p]).digest('hex'));
    h.update('\n');
  }
  return h.digest('hex');
}

/** Allocate the next experiments/<NNN> number from both disk and the DB (ids are never reused). */
export function nextConfigNumber(configsRoot: string, db?: Db): number {
  let max = 0;
  const expDir = join(configsRoot, 'experiments');
  if (existsSync(expDir)) {
    for (const d of readdirSync(expDir)) if (/^\d+$/.test(d)) max = Math.max(max, Number(d));
  }
  if (db) {
    for (const c of db.listConfigs()) {
      const m = /^experiments\/(\d+)$/.exec(c.configId);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

function mergeConfigJson(parentText: string | undefined, patch: Record<string, unknown>, newId: string, parentId: string): string {
  let base: Record<string, unknown> = {};
  if (parentText) {
    try {
      base = JSON.parse(parentText);
    } catch (e) {
      throw new OptimizerError(`parent config.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'context' && v && typeof v === 'object') {
      const ctx: Record<string, unknown> = { ...((base.context as Record<string, unknown>) ?? {}) };
      for (const [ck, cv] of Object.entries(v)) {
        if (cv === null) delete ctx[ck];
        else ctx[ck] = cv;
      }
      out.context = ctx;
    } else if (v === null) delete out[k];
    else out[k] = v;
  }
  if ('id' in base) out.id = newId;
  if ('id' in base || 'parentId' in base) out.parentId = parentId;
  return JSON.stringify(out, null, 2) + '\n';
}

function makeReadOnly(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) makeReadOnly(p);
    else chmodSync(p, 0o444);
  }
  chmodSync(dir, 0o555);
}

export function applyProposal(opts: ApplyOptions): AppliedConfig {
  const configsRoot = opts.configsRoot ?? DEFAULT_CONFIGS_ROOT;
  const parentFiles = readConfigFiles(opts.parentConfigId, configsRoot);
  const v = validateProposal(opts.proposal, withParentBackend(opts.whitelist, parentFiles));
  if (!v.ok) throw new OptimizerError('proposal rejected by whitelist', v.errors);
  const proposal = v.proposal;

  // Anti-cheating guard on the merged candidate (all files, total size) BEFORE an id is reserved.
  const guardOpts = opts.guard ?? opts.whitelist.guard;
  if (guardOpts !== false) {
    const preview = mergeFiles(parentFiles, proposal, 'experiments/000', opts.parentConfigId);
    const verdict = guardConfig(preview, guardOpts ?? {});
    if (!verdict.ok)
      throw new OptimizerError(
        'proposal rejected by the anti-cheating guard',
        verdict.violations.map((x) => `${x.file}: [${x.rule}] ${x.detail}`),
        verdict.violations,
      );
  }

  const next: Record<string, string> = { ...parentFiles };

  const n0 = nextConfigNumber(configsRoot, opts.db);
  mkdirSync(join(configsRoot, 'experiments'), { recursive: true });
  // Reserve a unique directory (mkdir without recursive fails if it exists).
  let n = n0;
  let dir = '';
  for (let attempt = 0; attempt < 1000; attempt++, n++) {
    const candidate = join(configsRoot, 'experiments', String(n).padStart(3, '0'));
    try {
      mkdirSync(candidate);
      dir = candidate;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  if (!dir) throw new OptimizerError('could not allocate a new config directory');
  const configId = `experiments/${String(n).padStart(3, '0')}`;

  for (const [path, content] of Object.entries(proposal.files)) {
    if (!isAllowedPath(path)) throw new OptimizerError(`path not allowed: ${path}`); // unreachable after validation
    if (path === 'config.json') next[path] = mergeConfigJson(parentFiles['config.json'], content as Record<string, unknown>, configId, opts.parentConfigId);
    else if (content === null) delete next[path];
    else next[path] = content as string;
  }
  // Even without a config.json patch, keep id/parentId of the copied config.json consistent.
  if (!('config.json' in proposal.files) && parentFiles['config.json'])
    next['config.json'] = mergeConfigJson(parentFiles['config.json'], {}, configId, opts.parentConfigId);

  const diff = diffFileSets(parentFiles, next);
  const substantive = diffFileSets(
    stripIds(parentFiles),
    stripIds(next),
  );
  if (!substantive.trim()) {
    // leave the reserved (empty) dir as a tombstone so its id is never reused
    writeFileSync(join(dir, 'REJECTED'), 'proposal made no substantive change\n');
    makeReadOnly(dir);
    throw new OptimizerError('proposal makes no substantive change to the parent config');
  }

  for (const [rel, content] of Object.entries(next)) {
    if (!isAllowedPath(rel)) throw new OptimizerError(`path not allowed: ${rel}`);
    const p = join(dir, rel);
    if (relative(dir, p).startsWith('..')) throw new OptimizerError(`path escapes candidate dir: ${rel}`);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  mkdirSync(join(dir, 'skills'), { recursive: true });
  // Final gate: the candidate must load with the runner's own strict config validation (e.g. a
  // claudeCode.claudeMd flag without CLAUDE.md, or an api-only knob on a claude-code config).
  try {
    loadConfigFromDir(dir, configId);
  } catch (e) {
    writeFileSync(join(dir, 'REJECTED'), `candidate config failed validation: ${(e as Error).message}\n`);
    makeReadOnly(dir);
    throw new OptimizerError(`candidate config is invalid: ${(e as Error).message}`);
  }
  const hash = hashFiles(next);
  const meta: ConfigMeta = {
    id: configId,
    parentId: opts.parentConfigId,
    hypothesis: proposal.hypothesis,
    changeSummary: proposal.changeSummary,
    changes: diff,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    hash,
    ...(opts.experimentId ? { experimentId: opts.experimentId } : {}),
    ...(typeof opts.research?.evidence === 'string' && opts.research.evidence.trim() ? { evidence: opts.research.evidence.trim().slice(0, 4000) } : {}),
    ...(typeof opts.research?.expectedSavings === 'string' && opts.research.expectedSavings.trim() ? { expectedSavings: opts.research.expectedSavings.trim().slice(0, 2000) } : {}),
  };
  writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n');
  makeReadOnly(dir);

  opts.db?.insertConfig({ configId, hash, parentId: opts.parentConfigId, path: relative(process.cwd(), dir) || dir, hypothesis: proposal.hypothesis, createdAt: meta.createdAt });
  return { configId, dir, hash, diff, meta, files: next };
}

/** The candidate's files (parent + proposal) with config.json merged, without touching disk. */
function mergeFiles(parentFiles: Record<string, string>, proposal: Proposal, configId: string, parentId: string): Record<string, string> {
  const next: Record<string, string> = { ...parentFiles };
  for (const [path, content] of Object.entries(proposal.files)) {
    if (path === 'config.json') next[path] = mergeConfigJson(parentFiles['config.json'], content as Record<string, unknown>, configId, parentId);
    else if (content === null) delete next[path];
    else next[path] = content as string;
  }
  return next;
}

export { formatViolations };

function stripIds(files: Record<string, string>): Record<string, string> {
  const out = { ...files };
  if (out['config.json']) {
    try {
      const o = JSON.parse(out['config.json']);
      delete o.id;
      delete o.parentId;
      out['config.json'] = canonicalJson(o);
    } catch {
      /* keep as-is */
    }
  }
  return out;
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',\n') + '}';
  return JSON.stringify(v);
}
