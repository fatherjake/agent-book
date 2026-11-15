/**
 * Benchmark image management.
 *
 * The image `frugal-bench:<starterHash>` contains the starter snapshot (benchmark/starter) with its
 * dependencies installed at /workspace, owned by user `node` (uid 1000).
 *
 * starterHash = sha256 over every starter file (sorted relative path + contents, excluding
 * node_modules, build output and OS junk) plus the Dockerfile. Any change to the starter or the
 * Dockerfile therefore produces a new tag; an unchanged starter reuses the existing image.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const BENCHMARK_DIR = path.resolve(here, '..');
export const STARTER_DIR = path.join(BENCHMARK_DIR, 'starter');
export const DOCKERFILE_PATH = path.join(here, 'Dockerfile');
export const IMAGE_REPO = 'frugal-bench';

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'data', '.git']);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** Sorted (posix-style) relative paths of all starter files that belong to the snapshot. */
export function listStarterFiles(starterDir: string = STARTER_DIR): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (!EXCLUDED_FILES.has(entry.name) && !entry.name.endsWith('.db')) out.push(relPath);
      }
    }
  };
  walk(starterDir, '');
  return out.sort();
}

/** sha256 (hex) over sorted starter files (path + contents) plus the Dockerfile. */
export function computeStarterHash(
  starterDir: string = STARTER_DIR,
  dockerfilePath: string = DOCKERFILE_PATH,
): string {
  const h = createHash('sha256');
  for (const rel of listStarterFiles(starterDir)) {
    const data = fs.readFileSync(path.join(starterDir, rel));
    h.update(`file:${rel}\0${data.length}\0`);
    h.update(data);
    h.update('\0');
  }
  const df = fs.readFileSync(dockerfilePath);
  h.update(`dockerfile\0${df.length}\0`);
  h.update(df);
  return h.digest('hex');
}

/** Image tag for a given starter hash: `frugal-bench:<full sha256 hex>`. */
export function imageTag(starterHash: string = computeStarterHash()): string {
  return `${IMAGE_REPO}:${starterHash}`;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onLog?: (line: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      opts.onLog?.(d.toString());
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      opts.onLog?.(d.toString());
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function inspectImageId(tag: string): Promise<string | null> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export interface EnsureImageOptions {
  /** Rebuild even if the tag already exists. */
  force?: boolean;
  /** Receives docker build output. */
  onLog?: (chunk: string) => void;
}

/**
 * Make sure the benchmark image for the current starter exists, building it if needed.
 * Idempotent: if `frugal-bench:<hash>` exists the build is skipped.
 */
export async function ensureImage(
  opts: EnsureImageOptions = {},
): Promise<{ image: string; imageId: string; starterHash: string }> {
  const starterHash = computeStarterHash();
  const image = imageTag(starterHash);

  if (!opts.force) {
    const existing = await inspectImageId(image);
    if (existing) return { image, imageId: existing, starterHash };
  }

  // Build from a clean temporary context holding exactly the hashed files.
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-bench-ctx-'));
  try {
    for (const rel of listStarterFiles()) {
      const dest = path.join(ctx, 'starter', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(STARTER_DIR, rel), dest);
    }
    fs.copyFileSync(DOCKERFILE_PATH, path.join(ctx, 'Dockerfile'));
    const r = await run(
      'docker',
      [
        'build',
        '--label', `frugal.starterHash=${starterHash}`,
        '--label', 'frugal.role=benchmark-image',
        '-t', image,
        ctx,
      ],
      { onLog: opts.onLog },
    );
    if (r.code !== 0) {
      throw new Error(`docker build failed for ${image} (exit ${r.code}):\n${r.stderr.slice(-4000)}`);
    }
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true });
  }

  const imageId = await inspectImageId(image);
  if (!imageId) throw new Error(`docker build reported success but ${image} was not found`);
  return { image, imageId, starterHash };
}
