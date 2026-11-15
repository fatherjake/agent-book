/**
 * `git-diff` workspace snapshots (docs/TASKS.md §3): brownfield tasks keep a large repo in /workspace,
 * so instead of copying the tree the runner stores the agent's change as a binary git patch against the
 * checkpoint commit: results/runs/<runId>/workspace.patch. The evaluator applies it to a fresh container.
 *
 *   recordCheckpoint()  right after the container (and its services) started: `git rev-parse HEAD`
 *   snapshotGitDiff()   after the run: `git add -A` + `git diff --cached --binary <checkpoint>` with the
 *                       generated/dependency dirs excluded, written in the container to /tmp and copied
 *                       out uncapped (exec output is capped, a patch must never be truncated).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecResult } from './types.js';

/** Paths never included in workspace.patch (pathspec excludes: dependencies, build output, caches, sim databases). */
export const GIT_DIFF_EXCLUDES = ['node_modules', 'ui/node_modules', 'ui/dist', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', '*.sqlite*', 'tmp'] as const;

/** Where the patch is staged inside the container before it is copied out. */
export const CONTAINER_PATCH_FILE = '/tmp/.frugal-workspace.patch';

export interface SnapshotSandbox {
  exec(command: string, opts?: { timeoutSec?: number; cwd?: string; user?: string }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readFileBuffer?(path: string): Promise<Buffer>;
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The checkpoint commit of /workspace (HEAD at container start). Throws when /workspace is not a git repo. */
export async function recordCheckpoint(sandbox: SnapshotSandbox): Promise<string> {
  const r = await sandbox.exec('git -C /workspace rev-parse HEAD', { timeoutSec: 60, cwd: '/workspace' });
  const sha = r.stdout.trim();
  if (r.exitCode !== 0 || !SHA_RE.test(sha)) throw new Error(`cannot read the checkpoint commit of /workspace (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return sha;
}

/** Shell command that stages everything and writes the binary diff against `base` to CONTAINER_PATCH_FILE. */
export function gitDiffCommand(base: string): string {
  if (!SHA_RE.test(base)) throw new Error(`invalid checkpoint sha ${JSON.stringify(base)}`);
  const ex = GIT_DIFF_EXCLUDES.map((p) => `':(exclude)${p}'`).join(' ');
  return [
    'set -e',
    'cd /workspace',
    // No exclude pathspecs on `add`: git refuses (exit 1) when one names a gitignored path
    // (node_modules, ui/dist, .venv). `add -A .` skips ignored files anyway; the
    // excludes on `diff` keep anything else listed out of the patch.
    'git add -A -- .',
    `git diff --cached --binary --no-color --no-ext-diff ${base} -- . ${ex} > ${CONTAINER_PATCH_FILE}`,
  ].join('\n');
}

/**
 * Write the agent's change as a binary patch to `outFile` (on the host). Returns its size and the files it
 * touches. Throws on git failures (the caller records an infra error).
 */
export async function snapshotGitDiff(sandbox: SnapshotSandbox, base: string, outFile: string): Promise<{ bytes: number; files: string[] }> {
  const r = await sandbox.exec(gitDiffCommand(base), { timeoutSec: 600, cwd: '/workspace' });
  if (r.exitCode !== 0) throw new Error(`git diff snapshot failed (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}): ${(r.stderr || r.stdout).trim().slice(-1000)}`);
  const buf = sandbox.readFileBuffer ? await sandbox.readFileBuffer(CONTAINER_PATCH_FILE) : Buffer.from(await sandbox.readFile(CONTAINER_PATCH_FILE), 'utf8');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, buf);
  return { bytes: buf.length, files: patchFiles(buf.toString('utf8')) };
}

/** Paths (b/ side) touched by a git patch. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.push(m[2]);
  return out;
}

/** Added lines of a unified diff, grouped per file (b/ side). Used by the anti-cheating guard. */
export function patchAddedLines(patch: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  const flush = () => {
    if (cur && cur.lines.length) out.push({ path: cur.path, text: cur.lines.join('\n') });
  };
  for (const line of patch.split('\n')) {
    const d = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (d) {
      flush();
      cur = { path: d[1], lines: [] };
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)?.[1];
      if (p && p !== '/dev/null') {
        if (!cur) cur = { path: p, lines: [] };
        else if (!cur.lines.length) cur.path = p;
      }
      continue;
    }
    if (line.startsWith('+') && cur) cur.lines.push(line.slice(1));
  }
  flush();
  return out;
}
