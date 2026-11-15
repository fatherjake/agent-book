/**
 * Task registry (docs/TASKS.md §2): benchmark/tasks/<taskId>/task.json.
 *
 *   benchmark/tasks/<id>/task.json   public task definition (TaskDefinition below)
 *   benchmark/tasks/<id>/prompt.md   task prompt given to the coding agent
 *   benchmark/tasks/<id>/spec/       copied to /spec in the coding container
 *   evaluator/tasks/<id>/            HIDDEN checks (the coding and research agents never see them)
 *
 * Paths in task.json: `promptFile` and `specDir` are relative to the task directory; `image.builder`,
 * `evaluator` and `referenceDiffs` are relative to the repo root. The todo task uses the sentinel
 * 'builtin:todo' for its prompt, image builder and evaluator: it keeps the original code paths
 * (benchmark/docker, runner/claude-code-image.ts, evaluator/index.ts) unchanged.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunLimits } from './types.js';
import { REPO_ROOT } from './env.js';

export const DEFAULT_TASK_ID = 'todo';
/** Sentinel for todo's built-in prompt / image builder / evaluator. */
export const BUILTIN_TODO = 'builtin:todo';
export const TASKS_DIR = join(REPO_ROOT, 'benchmark', 'tasks');

export type TaskKind = 'greenfield' | 'brownfield';
export type SnapshotMode = 'tree' | 'git-diff';

export interface TaskSandbox {
  cpus: number;
  memory: string;
  pidsLimit: number;
  /** Anonymous writable volumes, e.g. ['/data'] for Postgres/Redis. */
  extraVolumes?: string[];
  /** Extra tmpfs mounts, e.g. ['/run/postgresql:rw,nosuid,size=1m,uid=1000']. */
  extraTmpfs?: string[];
  /** /dev/shm size (docker --shm-size), e.g. '512m' for Chromium. Default: docker's 64m. */
  shmSize?: string;
}

export interface TaskDefinition {
  id: string;
  title: string;
  kind: TaskKind;
  /** Relative to the task dir ('builtin:todo' = the original todo prompt logic). */
  promptFile: string;
  /** Relative to the task dir; copied to /spec. */
  specDir: string;
  /** image.builder: repo-relative module exporting ensureTaskImage(): Promise<TaskImageInfo> ('builtin:todo' = todo images). */
  image: { builder: string };
  workspace: { path: '/workspace'; snapshot: SnapshotMode };
  sandbox: TaskSandbox;
  /** Task budget: each field given REPLACES the config's limit for runs of this task; run overrides only tighten. */
  limits?: Partial<RunLimits>;
  /** Repo-relative module exporting evaluateTask(opts) ('builtin:todo' = evaluator/index.ts todo path). */
  evaluator: string;
  /** 'none' = deterministic checks only, still promotable. 'required' = the LLM browser agent must run. */
  browserAgent: 'required' | 'none';
  /** Promotion threshold over verification runs (todo: 1.0). */
  minPassRate: number;
  /** Case-insensitive; any config text containing one is rejected (union over every non-todo task). */
  bannedTerms: string[];
  /** HIDDEN repo-relative diff files; their added lines join the guard's similarity corpus. */
  referenceDiffs: string[];
}

/** A loaded task with resolved absolute paths. */
export interface Task extends TaskDefinition {
  /** Absolute task directory (benchmark/tasks/<id>). */
  dir: string;
  /** Absolute prompt file, or null for builtin:todo. */
  promptPath: string | null;
  /** Absolute spec dir. */
  specPath: string;
  /** Absolute paths (or null for builtin:todo). */
  builderPath: string | null;
  evaluatorPath: string | null;
  referenceDiffPaths: string[];
}

export interface TaskImageInfo {
  /** Image the coding container runs (Claude Code layer for claude-code tasks). */
  image: string;
  imageId: string;
  /** Content hash of the base image, stored as runs.starter_hash. */
  starterHash: string;
  /** Base image (no Claude Code), used by the evaluator. */
  baseImage: string;
}

export class TaskError extends Error {
  constructor(where: string, msg: string) {
    super(`Invalid task (${where}): ${msg}`);
    this.name = 'TaskError';
  }
}

export const TASK_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TASK_KEYS = new Set([
  '$comment',
  'id',
  'title',
  'kind',
  'promptFile',
  'specDir',
  'image',
  'workspace',
  'sandbox',
  'limits',
  'evaluator',
  'browserAgent',
  'minPassRate',
  'bannedTerms',
  'referenceDiffs',
]);
const SANDBOX_KEYS = new Set(['cpus', 'memory', 'pidsLimit', 'extraVolumes', 'extraTmpfs', 'shmSize']);
const LIMIT_KEYS = new Set(['maxTotalTokens', 'maxModelCalls', 'maxRuntimeSec']);
/** Mount points a task may never claim (they are the runner's). */
const RESERVED_MOUNTS = ['/', '/workspace', '/tmp', '/spec', '/home', '/home/node', '/opt', '/opt/frugal', '/opt/frugal/bin', '/opt/frugal/libexec', '/opt/frugal/docs', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/var/run/docker.sock'];
const MOUNT_PATH_RE = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const TMPFS_OPTS_RE = /^[A-Za-z0-9=,_.-]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function repoPath(where: string, field: string, p: unknown, opts: { prefixes?: string[] } = {}): string {
  if (typeof p !== 'string' || !p.trim()) throw new TaskError(where, `'${field}' must be a non-empty string`);
  if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) throw new TaskError(where, `'${field}' must be a repo-relative path without '..' (got ${p})`);
  if (opts.prefixes && !opts.prefixes.some((x) => p.startsWith(x))) throw new TaskError(where, `'${field}' must be under ${opts.prefixes.join(' or ')} (got ${p})`);
  return p;
}

function checkMount(where: string, field: string, path: string): void {
  if (!MOUNT_PATH_RE.test(path)) throw new TaskError(where, `${field}: invalid mount path ${JSON.stringify(path)}`);
  const norm = path.replace(/\/+$/, '');
  if (RESERVED_MOUNTS.includes(norm) || norm.startsWith('/workspace/') || norm.startsWith('/opt/frugal/') || norm.startsWith('/spec/'))
    throw new TaskError(where, `${field}: ${path} is reserved by the runner`);
}

/** Validate a raw task.json object (dirName = the directory it was read from). Returns the definition. */
export function validateTaskDefinition(raw: unknown, dirName: string): TaskDefinition {
  const where = `benchmark/tasks/${dirName}/task.json`;
  if (!isObj(raw)) throw new TaskError(where, 'must be a JSON object');
  for (const k of Object.keys(raw)) if (!TASK_KEYS.has(k)) throw new TaskError(where, `unknown field '${k}'`);
  const id = raw.id;
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) throw new TaskError(where, `'id' must match ${TASK_ID_RE}`);
  if (id !== dirName) throw new TaskError(where, `'id' (${id}) must equal the directory name (${dirName})`);
  const builtin = id === DEFAULT_TASK_ID;
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v !== 'string' || !v.trim()) throw new TaskError(where, `'${k}' must be a non-empty string`);
    return v;
  };
  const title = str('title');
  const kind = raw.kind;
  if (kind !== 'greenfield' && kind !== 'brownfield') throw new TaskError(where, `'kind' must be greenfield | brownfield`);

  const promptFile = str('promptFile');
  const specDir = str('specDir');
  for (const [k, v] of [['promptFile', promptFile], ['specDir', specDir]] as const) {
    if (v === BUILTIN_TODO) {
      if (k === 'specDir' || !builtin) throw new TaskError(where, `'${k}' may not be ${BUILTIN_TODO}`);
      continue;
    }
    if (isAbsolute(v)) throw new TaskError(where, `'${k}' must be relative to the task directory`);
  }
  if (!isObj(raw.image)) throw new TaskError(where, `'image' must be {builder: string}`);
  for (const k of Object.keys(raw.image)) if (k !== 'builder') throw new TaskError(where, `unknown field 'image.${k}'`);
  const builder = raw.image.builder === BUILTIN_TODO && builtin ? BUILTIN_TODO : repoPath(where, 'image.builder', raw.image.builder);
  if (builder !== BUILTIN_TODO && !/\.[cm]?[jt]s$/.test(builder)) throw new TaskError(where, `'image.builder' must be a .ts/.js module`);

  if (!isObj(raw.workspace)) throw new TaskError(where, `'workspace' must be {path: '/workspace', snapshot: 'tree' | 'git-diff'}`);
  for (const k of Object.keys(raw.workspace)) if (k !== 'path' && k !== 'snapshot') throw new TaskError(where, `unknown field 'workspace.${k}'`);
  if (raw.workspace.path !== '/workspace') throw new TaskError(where, `'workspace.path' must be '/workspace'`);
  const snapshot = raw.workspace.snapshot;
  if (snapshot !== 'tree' && snapshot !== 'git-diff') throw new TaskError(where, `'workspace.snapshot' must be tree | git-diff`);

  if (!isObj(raw.sandbox)) throw new TaskError(where, `'sandbox' must be an object`);
  for (const k of Object.keys(raw.sandbox)) if (!SANDBOX_KEYS.has(k)) throw new TaskError(where, `unknown field 'sandbox.${k}'`);
  const s = raw.sandbox;
  if (typeof s.cpus !== 'number' || !(s.cpus >= 0.5 && s.cpus <= 16)) throw new TaskError(where, `'sandbox.cpus' must be a number in [0.5, 16]`);
  if (typeof s.memory !== 'string' || !/^[1-9][0-9]*[mg]$/.test(s.memory)) throw new TaskError(where, `'sandbox.memory' must look like '2g' or '4096m'`);
  if (!Number.isInteger(s.pidsLimit) || (s.pidsLimit as number) < 64 || (s.pidsLimit as number) > 8192) throw new TaskError(where, `'sandbox.pidsLimit' must be an integer in [64, 8192]`);
  const sandbox: TaskSandbox = { cpus: s.cpus, memory: s.memory, pidsLimit: s.pidsLimit as number };
  if (s.shmSize !== undefined) {
    if (typeof s.shmSize !== 'string' || !/^[1-9][0-9]*[mg]$/.test(s.shmSize)) throw new TaskError(where, `'sandbox.shmSize' must look like '512m' or '1g'`);
    sandbox.shmSize = s.shmSize;
  }
  if (s.extraVolumes !== undefined) {
    if (!Array.isArray(s.extraVolumes) || s.extraVolumes.some((v) => typeof v !== 'string')) throw new TaskError(where, `'sandbox.extraVolumes' must be an array of absolute paths`);
    for (const v of s.extraVolumes as string[]) checkMount(where, 'sandbox.extraVolumes', v);
    sandbox.extraVolumes = s.extraVolumes as string[];
  }
  if (s.extraTmpfs !== undefined) {
    if (!Array.isArray(s.extraTmpfs) || s.extraTmpfs.some((v) => typeof v !== 'string')) throw new TaskError(where, `'sandbox.extraTmpfs' must be an array of '<path>[:<options>]'`);
    for (const t of s.extraTmpfs as string[]) {
      const [p, o, ...rest] = t.split(':');
      if (rest.length || (o !== undefined && !TMPFS_OPTS_RE.test(o))) throw new TaskError(where, `'sandbox.extraTmpfs': invalid entry ${JSON.stringify(t)}`);
      checkMount(where, 'sandbox.extraTmpfs', p);
    }
    sandbox.extraTmpfs = s.extraTmpfs as string[];
  }

  let limits: Partial<RunLimits> | undefined;
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) throw new TaskError(where, `'limits' must be an object`);
    limits = {};
    for (const [k, v] of Object.entries(raw.limits)) {
      if (!LIMIT_KEYS.has(k)) throw new TaskError(where, `unknown field 'limits.${k}'`);
      if (!Number.isInteger(v) || (v as number) < 1) throw new TaskError(where, `'limits.${k}' must be a positive integer`);
      (limits as Record<string, number>)[k] = v as number;
    }
  }

  const evaluator = raw.evaluator === BUILTIN_TODO && builtin ? BUILTIN_TODO : repoPath(where, 'evaluator', raw.evaluator, { prefixes: ['evaluator/'] });
  if (evaluator !== BUILTIN_TODO && !/\.[cm]?[jt]s$/.test(evaluator)) throw new TaskError(where, `'evaluator' must be a .ts/.js module`);
  const browserAgent = raw.browserAgent;
  if (browserAgent !== 'required' && browserAgent !== 'none') throw new TaskError(where, `'browserAgent' must be required | none`);
  const minPassRate = raw.minPassRate;
  if (typeof minPassRate !== 'number' || !(minPassRate > 0 && minPassRate <= 1)) throw new TaskError(where, `'minPassRate' must be a number in (0, 1]`);
  if (!Array.isArray(raw.bannedTerms) || raw.bannedTerms.some((t) => typeof t !== 'string' || !t.trim() || t.length > 64))
    throw new TaskError(where, `'bannedTerms' must be an array of non-empty strings (<= 64 chars)`);
  if (!Array.isArray(raw.referenceDiffs)) throw new TaskError(where, `'referenceDiffs' must be an array of repo-relative paths`);
  const referenceDiffs = raw.referenceDiffs.map((p, i) => repoPath(where, `referenceDiffs[${i}]`, p, { prefixes: ['evaluator/'] }));

  const def: TaskDefinition = {
    id,
    title,
    kind,
    promptFile,
    specDir,
    image: { builder },
    workspace: { path: '/workspace', snapshot },
    sandbox,
    evaluator,
    browserAgent,
    minPassRate,
    bannedTerms: raw.bannedTerms.map((t: string) => t.trim()),
    referenceDiffs,
  };
  if (limits) def.limits = limits;
  return def;
}

/** Load and validate benchmark/tasks/<id>/task.json, resolving paths. Checks that prompt and spec exist. */
export function loadTaskFromDir(dir: string, repoRoot = REPO_ROOT): Task {
  const dirName = dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const file = join(dir, 'task.json');
  if (!existsSync(file)) throw new TaskError(`benchmark/tasks/${dirName}`, 'missing task.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new TaskError(`benchmark/tasks/${dirName}/task.json`, `not valid JSON: ${(e as Error).message}`);
  }
  const def = validateTaskDefinition(raw, dirName);
  const where = `benchmark/tasks/${dirName}/task.json`;
  const inside = (p: string, root: string) => {
    const r = relative(root, p);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  const promptPath = def.promptFile === BUILTIN_TODO ? null : resolve(dir, def.promptFile);
  if (promptPath && (!inside(promptPath, repoRoot) || !existsSync(promptPath) || !statSync(promptPath).isFile()))
    throw new TaskError(where, `promptFile ${def.promptFile} does not exist`);
  const specPath = resolve(dir, def.specDir);
  if (!inside(specPath, repoRoot) || !existsSync(specPath) || !statSync(specPath).isDirectory()) throw new TaskError(where, `specDir ${def.specDir} is not a directory`);
  if (inside(specPath, join(repoRoot, 'evaluator'))) throw new TaskError(where, 'specDir must not point into evaluator/ (hidden material)');
  return {
    ...def,
    dir,
    promptPath,
    specPath,
    builderPath: def.image.builder === BUILTIN_TODO ? null : resolve(repoRoot, def.image.builder),
    evaluatorPath: def.evaluator === BUILTIN_TODO ? null : resolve(repoRoot, def.evaluator),
    referenceDiffPaths: def.referenceDiffs.map((p) => resolve(repoRoot, p)),
  };
}

const cache = new Map<string, Task[]>();
const taskCache = new Map<string, Task>();

/** Every task under `tasksDir` (default benchmark/tasks), sorted by id. Invalid tasks throw. */
export function listTasks(opts: { tasksDir?: string; repoRoot?: string; fresh?: boolean } = {}): Task[] {
  const tasksDir = opts.tasksDir ?? TASKS_DIR;
  if (!opts.fresh && cache.has(tasksDir)) return cache.get(tasksDir)!;
  const out: Task[] = [];
  if (existsSync(tasksDir)) {
    for (const e of readdirSync(tasksDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (!existsSync(join(tasksDir, e.name, 'task.json'))) continue; // e.g. a docker-only dir under construction
      out.push(loadTaskFromDir(join(tasksDir, e.name), opts.repoRoot ?? REPO_ROOT));
    }
  }
  cache.set(tasksDir, out);
  return out;
}

export function clearTaskCache(): void {
  cache.clear();
  taskCache.clear();
}

/** Task dirs that have a task.json (no validation). */
function taskDirIds(tasksDir: string): string[] {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(tasksDir, e.name, 'task.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * The task with this id (default 'todo'). Only that task's task.json is loaded and validated, so a task
 * under construction elsewhere in the registry never breaks the others. Throws for unknown ids.
 */
export function getTask(id: string = DEFAULT_TASK_ID, opts: { tasksDir?: string; repoRoot?: string } = {}): Task {
  if (!TASK_ID_RE.test(id)) throw new TaskError(id, `invalid task id (must match ${TASK_ID_RE})`);
  const tasksDir = opts.tasksDir ?? TASKS_DIR;
  const key = `${tasksDir}\0${id}`;
  const hit = taskCache.get(key);
  if (hit) return hit;
  if (!existsSync(join(tasksDir, id, 'task.json'))) throw new TaskError(id, `unknown task; available: ${taskDirIds(tasksDir).join(', ') || '(none)'}`);
  const t = loadTaskFromDir(join(tasksDir, id), opts.repoRoot ?? REPO_ROOT);
  taskCache.set(key, t);
  return t;
}

/** Raw task.json objects of every task dir (parse errors skipped). Used where a half-built task must still count. */
function rawTaskDefs(tasksDir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const id of taskDirIds(tasksDir)) {
    try {
      const raw = JSON.parse(readFileSync(join(tasksDir, id, 'task.json'), 'utf8'));
      if (isObj(raw)) out.push({ ...raw, id });
    } catch {
      /* unparsable task.json: nothing to take from it */
    }
  }
  return out;
}

export function isTodoTask(t: Pick<TaskDefinition, 'id'> | string | undefined | null): boolean {
  return !t || (typeof t === 'string' ? t : t.id) === DEFAULT_TASK_ID;
}

/**
 * Union of bannedTerms over every non-todo task (dev and holdout alike). Read from the raw task.json files,
 * so a task that does not validate yet still contributes its terms (the guard never silently weakens).
 */
export function allBannedTerms(opts: { tasksDir?: string; repoRoot?: string } = {}): string[] {
  const out = new Set<string>();
  for (const raw of rawTaskDefs(opts.tasksDir ?? TASKS_DIR)) {
    if (raw.id === DEFAULT_TASK_ID || !Array.isArray(raw.bannedTerms)) continue;
    for (const term of raw.bannedTerms) if (typeof term === 'string' && term.trim()) out.add(term.trim());
  }
  return [...out];
}

/** Every task's existing referenceDiffs (absolute paths; raw task.json, repo-relative paths inside evaluator/ only). */
export function allReferenceDiffPaths(opts: { tasksDir?: string; repoRoot?: string } = {}): string[] {
  const root = opts.repoRoot ?? REPO_ROOT;
  const out: string[] = [];
  for (const raw of rawTaskDefs(opts.tasksDir ?? TASKS_DIR)) {
    if (!Array.isArray(raw.referenceDiffs)) continue;
    for (const p of raw.referenceDiffs) {
      if (typeof p !== 'string' || isAbsolute(p) || p.split(/[\\/]/).includes('..') || !p.startsWith('evaluator/')) continue;
      const abs = resolve(root, p);
      if (existsSync(abs)) out.push(abs);
    }
  }
  return out;
}

/** Effective limits of a run of `task`: task fields replace the config's, then `override` only tightens. */
export function taskLimits(base: RunLimits, task?: Pick<TaskDefinition, 'limits'> | null): RunLimits {
  const l = task?.limits;
  if (!l) return base;
  return {
    maxTotalTokens: l.maxTotalTokens ?? base.maxTotalTokens,
    maxModelCalls: l.maxModelCalls ?? base.maxModelCalls,
    maxRuntimeSec: l.maxRuntimeSec ?? base.maxRuntimeSec,
  };
}

/** Coding image of a task. todo: the claude-code image (or the plain benchmark image for the api loop). */
export async function ensureTaskImage(task: Task, opts: { backend?: 'api' | 'claude-code' } = {}): Promise<TaskImageInfo> {
  if (task.image.builder === BUILTIN_TODO) {
    if (opts.backend === 'api') {
      const { ensureImage } = await import('../benchmark/docker/image.js');
      const i = await ensureImage();
      return { ...i, baseImage: i.image };
    }
    const { ensureClaudeCodeImage } = await import('./claude-code-image.js');
    return ensureClaudeCodeImage();
  }
  const mod = (await import(pathToFileURL(task.builderPath!).href)) as { ensureTaskImage?: (o?: { backend?: 'api' | 'claude-code' }) => Promise<TaskImageInfo> };
  if (typeof mod.ensureTaskImage !== 'function') throw new TaskError(task.id, `${task.image.builder} does not export ensureTaskImage()`);
  const info = await mod.ensureTaskImage(opts.backend ? { backend: opts.backend } : {});
  if (!info?.image || !info.baseImage) throw new TaskError(task.id, `${task.image.builder} ensureTaskImage() returned no image/baseImage`);
  return { image: info.image, imageId: info.imageId ?? '', starterHash: info.starterHash ?? '', baseImage: info.baseImage };
}

/** The coding agent's task prompt text of a non-todo task (prompt.md). */
export function readTaskPrompt(task: Task): string {
  if (!task.promptPath) throw new TaskError(task.id, 'builtin prompt has no file');
  return readFileSync(task.promptPath, 'utf8').replace(/\s+$/, '');
}
