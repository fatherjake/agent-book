/**
 * The skills under test. A repo's skill files (its instruction files and skill folders, found by setup)
 * are taken from the repo at the pinned commit; a skills version is those files plus a list of diffs
 * (accepted suggestions, then the suggestion under test). A run receives a version as a workspace
 * overlay: a patch that adds the files to the checkpoint (which ships without them) and wires them the
 * way the repo's setup instructions say (tiny: `.claude/skills` → `.agents/skills`).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../runner/env.js';

/** Clone cache (FRUGAL_LAB_CACHE overrides, read at call time). */
export const labCache = () => process.env.FRUGAL_LAB_CACHE ?? join(REPO_ROOT, 'results', 'lab', 'cache');

export interface RepoSkillsSpec {
  id: string;
  url: string;
  commit: string;
  /** Repo-relative instruction files and skill folders the agent loads. */
  paths: string[];
  /** Symlinks to create (link → target, both repo-relative; target relative to the link's folder). */
  links: { link: string; target: string }[];
}

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** A clone of the repo with the pinned commit checked out (cached). */
export function ensureClone(spec: RepoSkillsSpec): string {
  const dir = join(labCache(), 'repos', spec.id);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    git(dir, ['remote', 'add', 'origin', spec.url]);
  }
  const head = (() => {
    try {
      return git(dir, ['rev-parse', 'HEAD']).trim();
    } catch {
      return '';
    }
  })();
  if (head !== spec.commit) {
    git(dir, ['fetch', '-q', '--depth', '1', 'origin', spec.commit]);
    git(dir, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', spec.commit]);
  }
  return dir;
}

/** The repo's skill files at the pinned commit, copied into a fresh directory. */
function baseTree(spec: RepoSkillsSpec, into: string): void {
  const clone = ensureClone(spec);
  for (const p of spec.paths) {
    const src = join(clone, p);
    if (!existsSync(src)) continue;
    const dst = join(into, p);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
}

/** Validate that every diff only touches the spec's skill paths (suggestions may not edit app code). */
export function diffPaths(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]).concat([...diff.matchAll(/^--- a\/(\S+)/gm)].map((m) => m[1]));
}
export function assertSkillDiff(spec: RepoSkillsSpec, diff: string): void {
  const paths = diffPaths(diff);
  if (!paths.length) throw new Error('the diff names no files (expected git-style --- a/… +++ b/… headers)');
  for (const p of paths) if (!spec.paths.some((root) => p === root || p.startsWith(root.replace(/\/?$/, '/')))) throw new Error(`the diff edits ${p}, which is not a skill file (${spec.paths.join(', ')})`);
}

/**
 * The overlay patch for a skills version: base skill files + `diffs` applied in order + links, as new
 * files relative to a tree without them. Throws if a diff does not apply.
 */
export function overlayPatch(spec: RepoSkillsSpec, diffs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-skills-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['-c', 'user.name=lab', '-c', 'user.email=lab@localhost', 'commit', '-q', '--allow-empty', '-m', 'empty']);
    const empty = git(dir, ['rev-parse', 'HEAD']).trim();
    baseTree(spec, dir);
    git(dir, ['add', '-A']);
    for (const [i, d] of diffs.entries()) {
      assertSkillDiff(spec, d);
      const f = join(dir, `.lab-diff-${i}.patch`);
      writeFileSync(f, d.endsWith('\n') ? d : d + '\n');
      try {
        git(dir, ['apply', '--index', '--whitespace=nowarn', '--recount', f]);
      } catch (e) {
        throw new Error(`skill diff ${i + 1} does not apply: ${String((e as { stderr?: string }).stderr ?? e).trim().slice(0, 600)}`);
      } finally {
        rmSync(f, { force: true });
      }
    }
    for (const l of spec.links) {
      const at = join(dir, l.link);
      mkdirSync(dirname(at), { recursive: true });
      symlinkSync(l.target, at);
    }
    git(dir, ['add', '-A']);
    return git(dir, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', empty]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Current text of a skill file in a skills version (for showing context and for the analysis agent). */
export function skillsTreeDir(spec: RepoSkillsSpec, diffs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-skills-tree-'));
  const patch = overlayPatch(spec, diffs);
  git(dir, ['init', '-q']);
  git(dir, ['apply', '--whitespace=nowarn', '-'], patch);
  return dir;
}
