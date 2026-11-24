/**
 * Git for the lab: find a session's repository and the commit it started from, make throwaway worktrees
 * at that commit, apply a suggestion's edits, and diff what a replay changed. The user's own checkout is
 * never modified: everything happens in detached worktrees under ~/.agent-book/lab/worktrees.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { TelemetryDb } from '../store.js';
import { LAB_DIR, type Edit } from './state.js';

const MAX_DIFF = 200_000;

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** The top of the git repository a folder belongs to, or null. */
export function repoRoot(folder: string | null): string | null {
  if (!folder) return null;
  const dir = expand(folder);
  if (!existsSync(dir)) return null;
  try {
    return git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

const isCommit = (root: string, rev: string) => {
  try {
    git(root, ['cat-file', '-e', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * The commit a session started from: the earliest `vcs.ref.head.revision` Claude Code recorded (newer
 * versions do), else the last commit on its branch before it started, else HEAD.
 */
export function baseRevision(db: TelemetryDb, sessionId: string, root: string, branch: string | null, startTs: string | null): { rev: string; from: 'telemetry' | 'history' | 'head' } {
  const recorded = db.raw
    .prepare(
      `SELECT json_extract(attrs, '$."vcs.ref.head.revision"') AS rev FROM events
       WHERE session_id = ? AND json_extract(attrs, '$."vcs.ref.head.revision"') IS NOT NULL ORDER BY ts LIMIT 1`,
    )
    .get(sessionId) as { rev: string } | undefined;
  if (recorded?.rev && isCommit(root, recorded.rev)) return { rev: recorded.rev, from: 'telemetry' };
  if (startTs)
    for (const ref of [branch, 'HEAD'].filter((r): r is string => !!r))
      try {
        const rev = git(root, ['rev-list', '-1', `--before=${startTs}`, ref]);
        if (rev) return { rev, from: 'history' };
      } catch {
        /* branch gone */
      }
  return { rev: git(root, ['rev-parse', 'HEAD']), from: 'head' };
}

/** A detached worktree of `root` at `rev`. */
export function addWorktree(root: string, rev: string, name: string): string {
  const dir = join(LAB_DIR(), 'worktrees', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '--detach', '--force', dir, rev]);
  return dir;
}

export function removeWorktree(root: string, dir: string): void {
  try {
    git(root, ['worktree', 'remove', '--force', dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
  }
}

/** A path inside the worktree, refusing anything that escapes it or touches .git. */
function inside(dir: string, file: string): string {
  const abs = resolve(dir, file);
  const rel = relative(dir, abs);
  if (!rel || rel.startsWith('..') || rel.split(sep)[0] === '.git') throw new Error(`${file}: outside the repository`);
  return abs;
}

/** Apply edits to a worktree. Each `find` must occur exactly once; an empty `find` appends or creates. */
export function applyEdits(dir: string, edits: Edit[]): void {
  for (const e of edits) {
    const abs = inside(dir, e.file);
    if (!existsSync(abs)) {
      if (e.find) throw new Error(`${e.file}: file doesn't exist at the base commit`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, e.replace);
      continue;
    }
    const cur = readFileSync(abs, 'utf8');
    if (!e.find) {
      writeFileSync(abs, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + e.replace);
      continue;
    }
    const n = cur.split(e.find).length - 1;
    if (n !== 1) throw new Error(`${e.file}: the text to replace occurs ${n} times (must be exactly once): ${JSON.stringify(e.find.slice(0, 80))}`);
    writeFileSync(abs, cur.replace(e.find, () => e.replace));
  }
}

const ID = ['-c', 'user.name=Agent Book', '-c', 'user.email=agent-book@localhost'];

/** Commit everything in the worktree (so a later diff shows only what came after). */
export function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, [...ID, 'commit', '-q', '--no-verify', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Everything changed since `ref`, committed or not, untracked files included. */
export function diffSince(dir: string, ref: string): { stat: string; diff: string } {
  git(dir, ['add', '-A']);
  const stat = git(dir, ['diff', '--cached', '--stat', '--no-color', ref]);
  let diff = git(dir, ['diff', '--cached', '--no-color', '--no-ext-diff', ref]);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (${diff.length - MAX_DIFF} more characters)`;
  return { stat, diff };
}
