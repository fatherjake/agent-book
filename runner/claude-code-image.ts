/**
 * Coding image for the claude-code backend: `frugal-bench-cc:<hash>` = the benchmark image
 * (frugal-bench:<starterHash>, unchanged) + Claude Code at CLAUDE_CODE_VERSION.
 * hash = sha256(base image tag + Dockerfile + Claude Code version). Idempotent: an existing tag is reused.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureImage } from '../benchmark/docker/image.js';
import { CLAUDE_CODE_VERSION } from './claude-code.js';
import { docker } from './sandbox.js';
import { logger } from './logger.js';

const log = logger('cc-image');

export const CC_IMAGE_REPO = 'frugal-bench-cc';
export const CC_DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), 'docker', 'claude-code.Dockerfile');

export function claudeCodeImageTag(baseTag: string, version = CLAUDE_CODE_VERSION, dockerfile = CC_DOCKERFILE): string {
  const h = createHash('sha256');
  h.update(`base\0${baseTag}\0version\0${version}\0dockerfile\0`);
  h.update(readFileSync(dockerfile));
  return `${CC_IMAGE_REPO}:${h.digest('hex').slice(0, 32)}`;
}

export interface ClaudeCodeImageInfo {
  image: string;
  imageId: string;
  starterHash: string;
  /** The underlying benchmark image (used for the forwarder container). */
  baseImage: string;
}

let inflight: Promise<ClaudeCodeImageInfo> | undefined;

export function ensureClaudeCodeImage(opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<ClaudeCodeImageInfo> {
  if (!opts.force && inflight) return inflight;
  const p = build(opts);
  inflight = p.catch((e) => {
    inflight = undefined;
    throw e;
  });
  return inflight;
}

async function build(opts: { force?: boolean; onLog?: (s: string) => void }): Promise<ClaudeCodeImageInfo> {
  const base = await ensureImage();
  const image = claudeCodeImageTag(base.image);
  const inspect = async () => {
    const r = await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  };
  if (!opts.force) {
    const id = await inspect();
    if (id) return { image, imageId: id, starterHash: base.starterHash, baseImage: base.image };
  }
  log.info('building Claude Code coding image', { image, base: base.image, version: CLAUDE_CODE_VERSION });
  const ctx = mkdtempSync(join(tmpdir(), 'frugal-cc-ctx-'));
  try {
    copyFileSync(CC_DOCKERFILE, join(ctx, 'Dockerfile'));
    const r = await docker(
      [
        'build',
        '--build-arg', `BASE_IMAGE=${base.image}`,
        '--build-arg', `CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`,
        '--label', 'frugal.role=benchmark-image',
        '--label', `frugal.starterHash=${base.starterHash}`,
        '--label', `frugal.claudeCodeVersion=${CLAUDE_CODE_VERSION}`,
        '-t', image,
        ctx,
      ],
      { timeoutMs: 20 * 60_000 },
    );
    opts.onLog?.(r.stderr);
    if (r.code !== 0) throw new Error(`docker build failed for ${image} (exit ${r.code}):\n${r.stderr.slice(-4000)}`);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  const id = await inspect();
  if (!id) throw new Error(`docker build reported success but ${image} was not found`);
  return { image, imageId: id, starterHash: base.starterHash, baseImage: base.image };
}
