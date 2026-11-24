/**
 * Where the lab's analyst reads and its replays run, worked out from the session itself. Git is used when
 * it's there, never required:
 *
 *   git     the session's folder is in a git repository: a detached worktree at the commit the session
 *           started from (the most faithful start)
 *   folder  the folder exists but isn't in a repository (or the repository has no commits): a copy of it as it is now (heavy folders such as
 *           node_modules left out, capped in size). It may have changed since the session.
 *   empty   no folder, or it's gone: an empty folder. Fits sessions that didn't depend on local files
 *           (research, questions, lookups); suggestions then create setup files such as CLAUDE.md.
 *
 * Every workspace is a git repository internally (a folder copy or an empty folder gets `git init` and a
 * first commit), so applying a suggestion and diffing what a replay did work the same way for all three.
 * The user's own folder is never written to.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionDetail } from '../session-detail.js';
import type { TelemetryDb } from '../store.js';
import { addWorktree, baseRevision, commitAll, git, removeWorktree, repoRoot } from './git.js';
import { LAB_DIR } from './state.js';

export type Source =
  | { kind: 'git'; repo: string; rev: string; from: 'telemetry' | 'history' | 'head' }
  | { kind: 'folder'; path: string }
  | { kind: 'empty'; reason?: string };

/** Folders left out of a copy: dependencies, build output, caches, VCS data. */
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'target', '.turbo', '.cache', 'coverage', '.pytest_cache', '.mypy_cache', 'Pods', 'DerivedData']);
const MAX_COPY_BYTES = 300 * 1024 * 1024;
const MAX_COPY_FILES = 50_000;

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** The workspace source for a session. */
export function sourceFor(db: TelemetryDb, d: SessionDetail): Source {
  const folder = d.session.folder ? expand(d.session.folder) : null;
  const root = repoRoot(folder);
  if (root)
    try {
      const base = baseRevision(db, d.session.id, root, d.session.branch, d.session.start);
      return { kind: 'git', repo: root, rev: base.rev, from: base.from };
    } catch {
      // A repository with no commits (or an unreadable one): no history to start from, so copy the folder.
    }
  if (!folder || !existsSync(folder)) return { kind: 'empty' };
  // A home folder or a filesystem root isn't a project: copying it would be wrong (and huge).
  if (folder === homedir() || folder === '/') return { kind: 'empty', reason: 'the session ran in your home folder' };
  if (!fitsCopy(folder)) return { kind: 'empty', reason: 'the project folder is too big to copy' };
  return { kind: 'folder', path: folder };
}

/** One line for the UI. */
export function describeSource(s: Source): string {
  if (s.kind === 'git') return `git ${s.rev.slice(0, 8)} (${s.from === 'telemetry' ? 'recorded' : s.from === 'history' ? 'branch at start' : 'HEAD'})`;
  if (s.kind === 'folder') return `copy of ${s.path.replace(homedir(), '~')} (no git; as it is now)`;
  return `empty folder (${s.reason ?? 'no project folder'})`;
}

/** Where the analyst can read the project, if anywhere (it only reads, so a folder is used in place). */
export function readableProject(s: Source, analysisTree: string | null): string | null {
  if (s.kind === 'git') return analysisTree;
  if (s.kind === 'folder') return s.path;
  return null;
}

/** Whether a folder is small enough to copy for every replay (stops counting once it isn't). */
function fitsCopy(dir: string): boolean {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): boolean => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return true;
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!walk(p)) return false;
      } else if (st.isFile()) {
        bytes += st.size;
        if (++files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) return false;
      }
    }
    return true;
  };
  return walk(dir);
}

/** Copy a folder, leaving out heavy folders, symlinks and anything past the size cap. */
function copyFolder(from: string, to: string): void {
  let bytes = 0;
  let files = 0;
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      if (src === from) return true;
      if (SKIP.has(basename(src))) return false;
      const st = lstatSync(src);
      if (st.isSymbolicLink()) return false;
      if (st.isFile()) {
        bytes += st.size;
        files++;
        if (bytes > MAX_COPY_BYTES || files > MAX_COPY_FILES)
          throw new Error(`${from} is too big to copy for a replay (over ${MAX_COPY_BYTES / 1024 / 1024} MB or ${MAX_COPY_FILES} files, not counting node_modules and build output).`);
      }
      return true;
    },
  });
}

export interface Workspace {
  dir: string;
  /** The commit everything is measured from. */
  start: string;
  remove(): void;
}

/** A fresh workspace from the source, ready to apply edits to. */
export function makeWorkspace(s: Source, name: string): Workspace {
  if (s.kind === 'git') {
    const dir = addWorktree(s.repo, s.rev, name);
    return { dir, start: s.rev, remove: () => removeWorktree(s.repo, dir) };
  }
  const dir = join(LAB_DIR(), 'worktrees', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    if (s.kind === 'folder') {
      if (!existsSync(s.path)) throw new Error(`${s.path} no longer exists.`);
      copyFolder(s.path, dir);
    }
    git(dir, ['init', '-q']);
    const start = commitAll(dir, 'Agent Book: start');
    return { dir, start, remove: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Put a workspace back to its starting commit (to try the next suggestion in the same one). */
export function resetWorkspace(w: Workspace): void {
  git(w.dir, ['reset', '-q', '--hard', w.start]);
  git(w.dir, ['clean', '-q', '-fd']);
}

/** True when nothing is in the folder (beyond .git): what a replay prompt should mention. */
export const isEmpty = (dir: string) => readdirSync(dir).every((n) => n === '.git');
