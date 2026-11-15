/**
 * Image builder shared by every tiny-* task (docs/TASKS.md §3). See ./README.md.
 *
 *   frugal-task-tiny:<sha256>    task image: Python 3.12 + Node 22 + uv, /workspace = tiny checkpoint
 *                                (single commit), .venv and ui/node_modules, Playwright/Chromium for
 *                                the agent's own checks. <sha256> = starterHash. Evaluator base image.
 *   frugal-task-tiny-cc:<h>      + Claude Code (CLAUDE_CODE_VERSION): the coding image
 *
 * All tiny-* tasks share these images (same checkpoint); only the prompt, spec and hidden evaluator
 * differ. Tags are content hashes of their inputs, so an existing tag is reused and any input change
 * produces a new one. Builds refuse to start below FRUGAL_MIN_FREE_GB (default 12) free.
 *
 * CLI (host):
 *   npx tsx benchmark/tasks/tiny/image.ts tags
 *   npx tsx benchmark/tasks/tiny/image.ts task                 [--force]
 *   npx tsx benchmark/tasks/tiny/image.ts cc                   [--force]
 *   npx tsx benchmark/tasks/tiny/image.ts checkpoint-tree <dir>          (the checkpoint; host git, no docker)
 *   npx tsx benchmark/tasks/tiny/image.ts ref-tree <taskId> <dir>        (HIDDEN: + evaluator/tasks/<taskId>/reference.diff, staged)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DOCKER_DIR = path.join(here, 'docker');
export const REPO_ROOT = path.resolve(here, '../../..');
export const TASK_REPO = 'frugal-task-tiny';

const TASK_FILES = ['task.Dockerfile', 'scripts/make-checkpoint.sh', 'task-bin/services', 'task-bin/app', 'task-bin/pw-node', 'task-bin/pw-preload.cjs'];

export interface BuildSpec {
  repo: string;
  commit: string;
  strip: string[];
  python: string;
  uv: string;
  node: { version: string; sha256: { arm64: string; amd64: string } };
  playwright: string;
}

export interface ImageInfo {
  image: string;
  imageId: string;
  /** Content hash of the task image inputs (its tag); stored as runs.starter_hash. */
  starterHash: string;
}

export interface CcImageInfo extends ImageInfo {
  /** The task image without Claude Code (evaluator). */
  baseImage: string;
}

export interface BuildOptions {
  force?: boolean;
  onLog?: (chunk: string) => void;
}

export function loadBuildSpec(): BuildSpec {
  const spec = JSON.parse(fs.readFileSync(path.join(here, 'build.json'), 'utf8')) as BuildSpec;
  if (!/^[0-9a-f]{40}$/.test(spec.commit)) throw new Error(`tiny build.json: bad commit ${spec.commit}`);
  for (const p of spec.strip) if (p.startsWith('/') || p.includes('..') || /\s/.test(p)) throw new Error(`tiny build.json: bad strip path ${p}`);
  return spec;
}

/** HIDDEN: a task's reference implementation (checkpoint → feature). */
export function referenceDiffPath(taskId: string): string {
  if (!/^tiny-[a-z0-9-]+$/.test(taskId)) throw new Error(`not a tiny task: ${taskId}`);
  return path.join(REPO_ROOT, 'evaluator', 'tasks', taskId, 'reference.diff');
}

function hashParts(parts: { name: string; data: Buffer | string }[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    const data = typeof p.data === 'string' ? Buffer.from(p.data) : p.data;
    h.update(`${p.name}\0${data.length}\0`);
    h.update(data);
    h.update('\0');
  }
  return h.digest('hex');
}

const dockerFile = (rel: string) => ({ name: rel, data: fs.readFileSync(path.join(DOCKER_DIR, rel)) });
const platform = () => process.env.FRUGAL_TINY_PLATFORM || undefined;

/** Full sha256 over the task image inputs (= starterHash). */
export function taskImageHash(): string {
  return hashParts([
    { name: 'platform', data: platform() ?? 'native' },
    ...TASK_FILES.map(dockerFile),
    { name: 'build.json', data: fs.readFileSync(path.join(here, 'build.json')) },
  ]);
}

export function taskImageTag(): string {
  return `${TASK_REPO}:${taskImageHash()}`;
}

export function ccImageTag(claudeCodeVersion: string): string {
  const h = hashParts([{ name: 'base', data: taskImageTag() }, { name: 'version', data: claudeCodeVersion }, dockerFile('cc.Dockerfile')]);
  return `${TASK_REPO}-cc:${h.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// docker helpers
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  opts: { onLog?: (s: string) => void; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      opts.onLog?.(d.toString());
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-200_000);
      opts.onLog?.(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function inspectImageId(tag: string): Promise<string | null> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Free space (GiB) where image layers land (Docker Desktop keeps its VM disk under the home dir). */
export function hostFreeGb(): number {
  let target: string | undefined;
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], { encoding: 'utf8', timeout: 15_000 });
    const root = r.status === 0 ? r.stdout.trim() : '';
    if (process.platform === 'linux' && root && fs.existsSync(root)) target = root;
  } catch {
    /* fall back */
  }
  const s = fs.statfsSync(target ?? os.homedir());
  return (s.bavail * s.bsize) / 1024 ** 3;
}

export function assertDiskSpace(what: string): void {
  if (process.env.FRUGAL_SKIP_DISK_CHECK === '1') return;
  const min = Number(process.env.FRUGAL_MIN_FREE_GB ?? 12);
  const free = hostFreeGb();
  if (free < min)
    throw new Error(
      `refusing to build ${what}: only ${free.toFixed(1)} GB free on the host (< ${min} GB). ` +
        'Free disk space, or set FRUGAL_MIN_FREE_GB / FRUGAL_SKIP_DISK_CHECK=1 if you know it fits.',
    );
}

async function buildImage(opts: {
  tag: string;
  dockerfile: string;
  files: string[];
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  onLog?: (s: string) => void;
}): Promise<string> {
  assertDiskSpace(opts.tag);
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-tiny-ctx-'));
  try {
    fs.copyFileSync(path.join(DOCKER_DIR, opts.dockerfile), path.join(ctx, 'Dockerfile'));
    for (const rel of opts.files) {
      const src = path.join(DOCKER_DIR, rel);
      const dest = path.join(ctx, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
    }
    const args = ['build', '--progress=plain', '-t', opts.tag];
    const plat = platform();
    if (plat) args.push('--platform', plat);
    for (const [k, v] of Object.entries(opts.buildArgs ?? {})) args.push('--build-arg', `${k}=${v}`);
    for (const [k, v] of Object.entries({ 'frugal.role': 'benchmark-image', ...(opts.labels ?? {}) })) args.push('--label', `${k}=${v}`);
    args.push(ctx);
    const t0 = Date.now();
    const r = await run('docker', args, { onLog: opts.onLog, env: { ...process.env, DOCKER_BUILDKIT: '1' }, timeoutMs: 3600_000 });
    if (r.code !== 0) throw new Error(`docker build failed for ${opts.tag} (exit ${r.code}):\n${r.stderr.slice(-6000)}`);
    opts.onLog?.(`\n[frugal] built ${opts.tag} in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true });
  }
  const id = await inspectImageId(opts.tag);
  if (!id) throw new Error(`docker build reported success but ${opts.tag} was not found`);
  return id;
}

/** One build per tag at a time (concurrent callers share it; failures are not cached). */
const inflight = new Map<string, Promise<string>>();
function ensureTag(tag: string, force: boolean | undefined, build: () => Promise<string>): Promise<string> {
  const key = `${tag}:${force ? 'force' : ''}`;
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = (async () => {
    if (!force) {
      const id = await inspectImageId(tag);
      if (id) return id;
    }
    return build();
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// ensure* API
// ---------------------------------------------------------------------------

/** The task image (no Claude Code): what the evaluator runs. */
export async function ensureTinyTaskImage(opts: BuildOptions = {}): Promise<ImageInfo> {
  const spec = loadBuildSpec();
  const starterHash = taskImageHash();
  const image = taskImageTag();
  const imageId = await ensureTag(image, opts.force, () =>
    buildImage({
      tag: image,
      dockerfile: 'task.Dockerfile',
      files: TASK_FILES.filter((f) => f !== 'task.Dockerfile'),
      buildArgs: {
        TINY_REPO: spec.repo,
        TINY_COMMIT: spec.commit,
        TINY_STRIP: spec.strip.join(' '),
        UV_VERSION: spec.uv,
        NODE_VERSION: spec.node.version,
        NODE_SHA256_ARM64: spec.node.sha256.arm64,
        NODE_SHA256_AMD64: spec.node.sha256.amd64,
        PLAYWRIGHT_VERSION: spec.playwright,
      },
      labels: { 'frugal.task': 'tiny', 'frugal.starterHash': starterHash, 'frugal.checkpoint': spec.commit },
      onLog: opts.onLog,
    }),
  );
  return { image, imageId, starterHash };
}

async function claudeCodeVersion(): Promise<string> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, 'runner', 'claude-code.ts')).href).catch(() =>
    import(pathToFileURL(path.join(REPO_ROOT, 'runner', 'claude-code.js')).href),
  )) as { CLAUDE_CODE_VERSION: string };
  return mod.CLAUDE_CODE_VERSION;
}

/** The coding image: task image + Claude Code. */
export async function ensureTinyCcImage(opts: BuildOptions & { claudeCodeVersion?: string } = {}): Promise<CcImageInfo> {
  const task = await ensureTinyTaskImage({ onLog: opts.onLog });
  const version = opts.claudeCodeVersion ?? (await claudeCodeVersion());
  const image = ccImageTag(version);
  const imageId = await ensureTag(image, opts.force, () =>
    buildImage({
      tag: image,
      dockerfile: 'cc.Dockerfile',
      files: [],
      buildArgs: { BASE_IMAGE: task.image, CLAUDE_CODE_VERSION: version },
      labels: { 'frugal.task': 'tiny', 'frugal.starterHash': task.starterHash, 'frugal.claudeCodeVersion': version },
      onLog: opts.onLog,
    }),
  );
  return { image, imageId, starterHash: task.starterHash, baseImage: task.image };
}

/** Entry point for the per-task builder modules (runner/tasks.ts): coding image + base image. */
export async function ensureRunnerImages(opts: BuildOptions & { backend?: 'api' | 'claude-code' } = {}): Promise<CcImageInfo> {
  if (opts.backend === 'api') {
    const t = await ensureTinyTaskImage(opts);
    return { ...t, baseImage: t.image };
  }
  return ensureTinyCcImage(opts);
}

/**
 * The checkpoint on the host (no docker), exactly as in the image (same script, same commit id),
 * optionally with a task's HIDDEN reference diff applied and staged. Returns the checkpoint commit.
 */
export async function exportTree(outDir: string, opts: { referenceTaskId?: string; onLog?: (s: string) => void } = {}): Promise<string> {
  const spec = loadBuildSpec();
  let r = await run('bash', [path.join(DOCKER_DIR, 'scripts', 'make-checkpoint.sh'), outDir, spec.repo, spec.commit, ...spec.strip], { onLog: opts.onLog });
  if (r.code !== 0) throw new Error(`make-checkpoint failed (exit ${r.code}): ${r.stderr.slice(-3000)}`);
  const head = (await run('git', ['-C', outDir, 'rev-parse', 'HEAD'])).stdout.trim();
  if (opts.referenceTaskId) {
    r = await run('git', ['-C', outDir, 'apply', '--index', '--whitespace=nowarn', referenceDiffPath(opts.referenceTaskId)]);
    if (r.code !== 0) throw new Error(`reference.diff does not apply: ${r.stderr}`);
  }
  return head;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const [cmd, a, b] = argv.filter((x) => !x.startsWith('--'));
  const onLog = (s: string) => process.stderr.write(s);
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  switch (cmd) {
    case 'tags':
      return out({ task: taskImageTag(), cc: ccImageTag(await claudeCodeVersion()), starterHash: taskImageHash(), hostFreeGb: Number(hostFreeGb().toFixed(1)) });
    case 'task':
      return out(await ensureTinyTaskImage({ force, onLog }));
    case 'cc':
      return out(await ensureTinyCcImage({ force, onLog }));
    case 'checkpoint-tree': {
      if (!a) throw new Error('usage: checkpoint-tree <dir>');
      return out({ dir: path.resolve(a), checkpoint: await exportTree(path.resolve(a), { onLog }) });
    }
    case 'ref-tree': {
      if (!a || !b) throw new Error('usage: ref-tree <taskId> <dir>');
      return out({ dir: path.resolve(b), checkpoint: await exportTree(path.resolve(b), { referenceTaskId: a, onLog }), reference: 'applied and staged' });
    }
    default:
      console.error('usage: image.ts tags | task | cc | checkpoint-tree <dir> | ref-tree <taskId> <dir>  [--force]');
      process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
