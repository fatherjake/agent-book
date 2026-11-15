/**
 * Image builder for the brownfield Mastodon tasks (docs/TASKS.md §3). See ./README.md.
 *
 *   frugal-task-mastodon-base:<h>   shared: Debian bullseye, toolchain + native-gem libs, Postgres 13,
 *                                    Redis 6, user node (1000), private Node 22 + Playwright/Chromium
 *   frugal-task-<taskId>:<sha256>   task image: project Ruby/Node/Yarn, /workspace checkpoint (single
 *                                    commit), gems, node_modules, DB template. <sha256> = starterHash.
 *   frugal-task-<taskId>-cc:<h>     + Claude Code (CLAUDE_CODE_VERSION) under /opt/claude
 *   frugal-task-<taskId>-ref:<h>    HIDDEN: + upstream reference diff applied (evaluator/checks only)
 *
 * Every tag is a content hash of its inputs (Dockerfile, scripts, build.json, patches, parent tag), so
 * an existing tag is reused and any input change produces a new one. Builds refuse to start when the
 * host has less than FRUGAL_MIN_FREE_GB (default 12) free (FRUGAL_SKIP_DISK_CHECK=1 overrides).
 * FRUGAL_MASTODON_PLATFORM (e.g. linux/amd64) forces a platform; default is the native one.
 *
 * CLI (host):
 *   npx tsx benchmark/tasks/mastodon/image.ts tags     [taskId]
 *   npx tsx benchmark/tasks/mastodon/image.ts base                      [--force]
 *   npx tsx benchmark/tasks/mastodon/image.ts task     <taskId>         [--force]
 *   npx tsx benchmark/tasks/mastodon/image.ts cc       <taskId>         [--force]
 *   npx tsx benchmark/tasks/mastodon/image.ts ref      <taskId>         [--force]   (hidden reference image)
 *   npx tsx benchmark/tasks/mastodon/image.ts ref-tree <taskId> <dir>              (HIDDEN: checkpoint + reference staged; host git, no docker)
 *   npx tsx benchmark/tasks/mastodon/image.ts checkpoint-tree <taskId> <dir>       (the checkpoint only; host git, no docker)
 */
import { spawn, spawnSync as require_spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DOCKER_DIR = path.join(here, 'docker');
export const TASKS_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(here, '../../..');
export const MASTODON_TASK_IDS = ['mastodon-bookmarks', 'mastodon-filters'] as const;
export type MastodonTaskId = (typeof MASTODON_TASK_IDS)[number];

export const BASE_REPO = 'frugal-task-mastodon-base';

const BASE_FILES = ['base.Dockerfile', 'scripts/apt-sources.sh', 'task-bin/pw-node', 'task-bin/pw-preload.cjs', 'task-bin/pw-screenshot.js'];
const TASK_FILES = [
  'task.Dockerfile',
  'scripts/make-checkpoint.sh',
  'scripts/verify-checkpoint.sh',
  'scripts/build-db-template.sh',
  'task-bin/services',
  'task-bin/app',
];

export interface BuildSpec {
  taskId: MastodonTaskId;
  upstream: { repo: string; pr: number; featureCommit: string; checkpointCommit: string };
  ruby: { version: string; sha256: string };
  bundler: string;
  node: { version: string; sha256: { arm64: string; amd64: string } };
  yarn: { version: string; sha256: string };
}

export interface ImageInfo {
  image: string;
  imageId: string;
  /** Content hash of the task image (its tag); stored as runs.starter_hash. */
  starterHash: string;
}

export interface CcImageInfo extends ImageInfo {
  /** The task image without Claude Code (evaluator, forwarder). */
  baseImage: string;
}

export interface BuildOptions {
  force?: boolean;
  onLog?: (chunk: string) => void;
}

// ---------------------------------------------------------------------------
// Inputs and tags
// ---------------------------------------------------------------------------

export function assertTaskId(taskId: string): asserts taskId is MastodonTaskId {
  if (!(MASTODON_TASK_IDS as readonly string[]).includes(taskId))
    throw new Error(`unknown Mastodon task '${taskId}' (expected one of ${MASTODON_TASK_IDS.join(', ')})`);
}

export function taskDockerDir(taskId: MastodonTaskId): string {
  return path.join(TASKS_DIR, taskId, 'docker');
}

export function loadBuildSpec(taskId: string): BuildSpec {
  assertTaskId(taskId);
  const spec = JSON.parse(fs.readFileSync(path.join(taskDockerDir(taskId), 'build.json'), 'utf8')) as BuildSpec;
  if (spec.taskId !== taskId) throw new Error(`build.json of ${taskId} says taskId=${spec.taskId}`);
  for (const c of [spec.upstream.checkpointCommit, spec.upstream.featureCommit])
    if (!/^[0-9a-f]{40}$/.test(c)) throw new Error(`build.json of ${taskId}: bad commit ${c}`);
  return spec;
}

export function patchFiles(taskId: MastodonTaskId): string[] {
  const dir = path.join(taskDockerDir(taskId), 'patches');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.patch'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** HIDDEN: the upstream squash diff (checkpoint → feature). */
export function referenceDiffPath(taskId: MastodonTaskId): string {
  return path.join(REPO_ROOT, 'evaluator', 'tasks', taskId, 'reference.diff');
}

function platform(): string | undefined {
  return process.env.FRUGAL_MASTODON_PLATFORM || undefined;
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

export function baseImageTag(): string {
  const h = hashParts([{ name: 'platform', data: platform() ?? 'native' }, ...BASE_FILES.map(dockerFile)]);
  return `${BASE_REPO}:${h.slice(0, 32)}`;
}

/** Full sha256 over the task image inputs (= starterHash). */
export function taskImageHash(taskId: string): string {
  assertTaskId(taskId);
  return hashParts([
    { name: 'base', data: baseImageTag() },
    ...TASK_FILES.map(dockerFile),
    { name: 'build.json', data: fs.readFileSync(path.join(taskDockerDir(taskId), 'build.json')) },
    ...patchFiles(taskId).map((f) => ({ name: `patch:${path.basename(f)}`, data: fs.readFileSync(f) })),
  ]);
}

export function taskImageTag(taskId: string): string {
  return `frugal-task-${taskId}:${taskImageHash(taskId)}`;
}

export function ccImageTag(taskId: string, claudeCodeVersion: string): string {
  const h = hashParts([
    { name: 'base', data: taskImageTag(taskId) },
    { name: 'version', data: claudeCodeVersion },
    dockerFile('cc.Dockerfile'),
  ]);
  return `frugal-task-${taskId}-cc:${h.slice(0, 32)}`;
}

export function referenceImageTag(taskId: string): string {
  assertTaskId(taskId);
  const h = hashParts([
    { name: 'base', data: taskImageTag(taskId) },
    dockerFile('reference.Dockerfile'),
    { name: 'reference.diff', data: fs.readFileSync(referenceDiffPath(taskId)) },
  ]);
  return `frugal-task-${taskId}-ref:${h.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// docker helpers
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onLog?: (s: string) => void; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Free space (GiB) where image layers land: Docker's root dir when it is on this host (native Linux
 * dockerd, e.g. /var/lib/docker), otherwise the user's home filesystem (Docker Desktop keeps its VM
 * disk image there; its DockerRootDir is a path inside the VM).
 */
export function hostFreeGb(dir?: string): number {
  let target = dir;
  if (!target) {
    try {
      const r = require_spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], { encoding: 'utf8', timeout: 15_000 });
      const root = r.status === 0 ? r.stdout.trim() : '';
      if (process.platform === 'linux' && root && fs.existsSync(root)) target = root;
    } catch {
      /* fall back */
    }
  }
  const s = fs.statfsSync(target ?? os.homedir());
  return (s.bavail * s.bsize) / 1024 ** 3;
}

export function assertDiskSpace(what: string): void {
  if (process.env.FRUGAL_SKIP_DISK_CHECK === '1') return;
  // Measured: a full rebuild of base + one task + its Claude Code layer is ~8 GB of images, plus build
  // cache; 12 GB leaves headroom. (30 GB was a pre-build guess and blocked a live research session.)
  const min = Number(process.env.FRUGAL_MIN_FREE_GB ?? 12);
  const free = hostFreeGb();
  if (free < min)
    throw new Error(
      `refusing to build ${what}: only ${free.toFixed(1)} GB free on the host (< ${min} GB). ` +
        'Free disk space, or set FRUGAL_MIN_FREE_GB / FRUGAL_SKIP_DISK_CHECK=1 if you know it fits.',
    );
}

interface ContextFile {
  /** Path inside the build context. */
  dest: string;
  src: string;
}

async function buildImage(opts: {
  tag: string;
  dockerfile: string;
  files: ContextFile[];
  dirs?: string[];
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  onLog?: (s: string) => void;
}): Promise<string> {
  assertDiskSpace(opts.tag);
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-mastodon-ctx-'));
  try {
    fs.copyFileSync(path.join(DOCKER_DIR, opts.dockerfile), path.join(ctx, 'Dockerfile'));
    for (const d of opts.dirs ?? []) fs.mkdirSync(path.join(ctx, d), { recursive: true });
    for (const f of opts.files) {
      const dest = path.join(ctx, f.dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.src, dest);
      fs.chmodSync(dest, fs.statSync(f.src).mode & 0o777);
    }
    const args = ['build', '--progress=plain', '-t', opts.tag];
    const plat = platform();
    if (plat) args.push('--platform', plat);
    for (const [k, v] of Object.entries(opts.buildArgs ?? {})) args.push('--build-arg', `${k}=${v}`);
    for (const [k, v] of Object.entries({ 'frugal.role': 'benchmark-image', ...(opts.labels ?? {}) })) args.push('--label', `${k}=${v}`);
    args.push(ctx);
    const t0 = Date.now();
    const r = await run('docker', args, { onLog: opts.onLog, env: { ...process.env, DOCKER_BUILDKIT: '1' }, timeoutMs: 3 * 3600_000 });
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

export async function ensureBaseImage(opts: BuildOptions = {}): Promise<{ image: string; imageId: string }> {
  const image = baseImageTag();
  const imageId = await ensureTag(image, opts.force, () =>
    buildImage({
      tag: image,
      dockerfile: 'base.Dockerfile',
      files: BASE_FILES.filter((f) => f !== 'base.Dockerfile').map((f) => ({ dest: f, src: path.join(DOCKER_DIR, f) })),
      labels: { 'frugal.task': 'mastodon-base' },
      onLog: opts.onLog,
    }),
  );
  return { image, imageId };
}

/** The task image (no Claude Code): what the evaluator runs. */
export async function ensureTaskImage(taskId: string, opts: BuildOptions = {}): Promise<ImageInfo> {
  assertTaskId(taskId);
  const spec = loadBuildSpec(taskId);
  const base = await ensureBaseImage({ onLog: opts.onLog });
  const starterHash = taskImageHash(taskId);
  const image = taskImageTag(taskId);
  const imageId = await ensureTag(image, opts.force, () =>
    buildImage({
      tag: image,
      dockerfile: 'task.Dockerfile',
      files: [
        ...TASK_FILES.filter((f) => f !== 'task.Dockerfile').map((f) => ({ dest: f, src: path.join(DOCKER_DIR, f) })),
        ...patchFiles(taskId).map((f) => ({ dest: `task/patches/${path.basename(f)}`, src: f })),
      ],
      dirs: ['task/patches'], // COPY task/patches/ needs the directory even without patches
      buildArgs: {
        BASE_IMAGE: base.image,
        TASK_ID: taskId,
        MASTODON_COMMIT: spec.upstream.checkpointCommit,
        RUBY_VERSION: spec.ruby.version,
        RUBY_SHA256: spec.ruby.sha256,
        BUNDLER_VERSION: spec.bundler,
        NODE_VERSION: spec.node.version,
        NODE_SHA256_ARM64: spec.node.sha256.arm64,
        NODE_SHA256_AMD64: spec.node.sha256.amd64,
        YARN_VERSION: spec.yarn.version,
        YARN_SHA256: spec.yarn.sha256,
      },
      labels: { 'frugal.task': taskId, 'frugal.starterHash': starterHash, 'frugal.checkpoint': spec.upstream.checkpointCommit },
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

/** The coding image: task image + Claude Code (private runtime under /opt/claude). */
export async function ensureTaskCcImage(taskId: string, opts: BuildOptions & { claudeCodeVersion?: string } = {}): Promise<CcImageInfo> {
  assertTaskId(taskId);
  const task = await ensureTaskImage(taskId, { onLog: opts.onLog });
  const version = opts.claudeCodeVersion ?? (await claudeCodeVersion());
  const image = ccImageTag(taskId, version);
  const imageId = await ensureTag(image, opts.force, () =>
    buildImage({
      tag: image,
      dockerfile: 'cc.Dockerfile',
      files: [],
      buildArgs: { BASE_IMAGE: task.image, CLAUDE_CODE_VERSION: version },
      labels: { 'frugal.task': taskId, 'frugal.starterHash': task.starterHash, 'frugal.claudeCodeVersion': version },
      onLog: opts.onLog,
    }),
  );
  return { image, imageId, starterHash: task.starterHash, baseImage: task.image };
}

/**
 * Entry point for runner/tasks.ts (via the per-task builder modules): the image the coding container
 * runs (the Claude Code layer, or the plain task image for the 'api' backend) plus the base image.
 */
export async function ensureRunnerImages(taskId: string, opts: BuildOptions & { backend?: 'api' | 'claude-code' } = {}): Promise<CcImageInfo> {
  if (opts.backend === 'api') {
    const t = await ensureTaskImage(taskId, opts);
    return { ...t, baseImage: t.image };
  }
  return ensureTaskCcImage(taskId, opts);
}

/** HIDDEN reference image: task image + upstream reference diff, staged in /workspace. */
export async function ensureReferenceImage(taskId: string, opts: BuildOptions = {}): Promise<ImageInfo & { baseImage: string }> {
  assertTaskId(taskId);
  const task = await ensureTaskImage(taskId, { onLog: opts.onLog });
  const image = referenceImageTag(taskId);
  const imageId = await ensureTag(image, opts.force, () =>
    buildImage({
      tag: image,
      dockerfile: 'reference.Dockerfile',
      files: [{ dest: 'reference.diff', src: referenceDiffPath(taskId) }],
      buildArgs: { BASE_IMAGE: task.image },
      labels: { 'frugal.task': taskId, 'frugal.role': 'reference-image', 'frugal.starterHash': task.starterHash },
      onLog: opts.onLog,
    }),
  );
  return { image, imageId, starterHash: task.starterHash, baseImage: task.image };
}

/**
 * HIDDEN reference tree on the host (no docker): the checkpoint exactly as in the image (same
 * script, same commit id) with the reference diff applied and staged. `outDir` must not exist or be
 * empty. Returns the checkpoint commit id.
 */
export async function exportReferenceTree(taskId: string, outDir: string, opts: { onLog?: (s: string) => void; applyReference?: boolean } = {}): Promise<string> {
  assertTaskId(taskId);
  const spec = loadBuildSpec(taskId);
  const patchDir = path.join(taskDockerDir(taskId), 'patches');
  let r = await run('bash', [path.join(DOCKER_DIR, 'scripts', 'make-checkpoint.sh'), outDir, spec.upstream.checkpointCommit, patchDir], { onLog: opts.onLog });
  if (r.code !== 0) throw new Error(`make-checkpoint failed (exit ${r.code}): ${r.stderr.slice(-3000)}`);
  const head = (await run('git', ['-C', outDir, 'rev-parse', 'HEAD'])).stdout.trim();
  if (opts.applyReference !== false) {
    r = await run('git', ['-C', outDir, 'apply', '--index', '--whitespace=nowarn', referenceDiffPath(taskId)]);
    if (r.code !== 0) throw new Error(`reference.diff does not apply: ${r.stderr}`);
  }
  return head;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const [cmd, taskId, dir] = argv.filter((a) => !a.startsWith('--'));
  const onLog = (s: string) => process.stderr.write(s);
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  switch (cmd) {
    case 'tags': {
      const ids = taskId ? [taskId] : [...MASTODON_TASK_IDS];
      const v = await claudeCodeVersion();
      out({
        base: baseImageTag(),
        tasks: Object.fromEntries(
          ids.map((id) => [id, { task: taskImageTag(id), cc: ccImageTag(id, v), ref: referenceImageTag(id), starterHash: taskImageHash(id) }]),
        ),
        hostFreeGb: Number(hostFreeGb().toFixed(1)),
      });
      return;
    }
    case 'base':
      return out(await ensureBaseImage({ force, onLog }));
    case 'task':
      return out(await ensureTaskImage(taskId, { force, onLog }));
    case 'cc':
      return out(await ensureTaskCcImage(taskId, { force, onLog }));
    case 'ref':
      return out(await ensureReferenceImage(taskId, { force, onLog }));
    case 'ref-tree': {
      if (!dir) throw new Error('usage: ref-tree <taskId> <dir>');
      const head = await exportReferenceTree(taskId, path.resolve(dir), { onLog });
      return out({ dir: path.resolve(dir), checkpoint: head, reference: 'applied and staged (git diff --cached)' });
    }
    case 'checkpoint-tree': {
      if (!dir) throw new Error('usage: checkpoint-tree <taskId> <dir>');
      const head = await exportReferenceTree(taskId, path.resolve(dir), { onLog, applyReference: false });
      return out({ dir: path.resolve(dir), checkpoint: head });
    }
    default:
      console.error('usage: image.ts tags [taskId] | base | task <taskId> | cc <taskId> | ref <taskId> | ref-tree <taskId> <dir> | checkpoint-tree <taskId> <dir>  [--force]');
      process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
