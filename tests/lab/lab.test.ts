import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LabDb } from '../../lab/db.js';
import { grade, REPOS, type LabTask } from '../../lab/repos.js';
import { pairSeed } from '../../lab/run.js';
import { assertSkillDiff, overlayPatch, type RepoSkillsSpec } from '../../lab/skills.js';
import { editsToDiff } from '../../lab/analyse.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('skills overlay', () => {
  let src: string;
  let spec: RepoSkillsSpec;
  let prevCache: string | undefined;
  beforeAll(() => {
    src = mkdtempSync(join(tmpdir(), 'lab-src-'));
    git(src, 'init', '-q');
    mkdirSync(join(src, '.agents/skills/demo'), { recursive: true });
    writeFileSync(join(src, 'AGENTS.md'), '# Agents\n\nUse demo.\n');
    writeFileSync(join(src, '.agents/skills/demo/SKILL.md'), '---\nname: demo\n---\n\n1. Read.\n2. Write.\n');
    writeFileSync(join(src, 'app.py'), 'print(1)\n');
    git(src, 'add', '-A');
    git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    spec = { id: `t${Date.now()}`, url: src, commit: git(src, 'rev-parse', 'HEAD').trim(), paths: ['AGENTS.md', '.agents'], links: [{ link: '.claude/skills', target: '../.agents/skills' }] };
    prevCache = process.env.FRUGAL_LAB_CACHE;
    process.env.FRUGAL_LAB_CACHE = join(src, '.cache');
  });
  afterAll(() => {
    rmSync(src, { recursive: true, force: true });
    if (prevCache === undefined) delete process.env.FRUGAL_LAB_CACHE;
  });

  it('adds the skill files and the link, and nothing else', () => {
    const p = overlayPatch(spec);
    const files = [...p.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]).sort();
    expect(files).toEqual(['.agents/skills/demo/SKILL.md', '.claude/skills', 'AGENTS.md']);
    expect(p).toMatch(/new file mode 120000/);
  });

  it('applies suggestion diffs in order', () => {
    const d = `diff --git a/.agents/skills/demo/SKILL.md b/.agents/skills/demo/SKILL.md\n--- a/.agents/skills/demo/SKILL.md\n+++ b/.agents/skills/demo/SKILL.md\n@@ -4,2 +4,2 @@\n 1. Read.\n-2. Write.\n+2. Write tests first.\n`;
    expect(overlayPatch(spec, [d])).toContain('+2. Write tests first.');
  });

  it('turns find/replace edits into a diff that applies; rejects ambiguous, missing and non-skill edits', () => {
    const repo = { ...REPOS.tiny, skills: spec };
    const d = editsToDiff(repo, [], [{ file: '.agents/skills/demo/SKILL.md', find: '2. Write.', replace: '2. Write, then test.' }]);
    expect(d).toContain('+2. Write, then test.');
    expect(overlayPatch(spec, [d])).toContain('+2. Write, then test.');
    expect(() => editsToDiff(repo, [], [{ file: 'AGENTS.md', find: 'nothing like this', replace: 'x' }])).toThrow(/occurs 0 times/);
    expect(() => editsToDiff(repo, [], [{ file: 'app.py', find: 'print', replace: 'x' }])).toThrow(/not a skill file/);
    expect(() => editsToDiff(repo, [], [{ file: '../../etc/passwd', find: 'x', replace: 'y' }])).toThrow(/escapes|not a skill file/);
  });

  it('rejects diffs outside the skill files and diffs that do not apply', () => {
    expect(() => assertSkillDiff(spec, '--- a/app.py\n+++ b/app.py\n')).toThrow(/not a skill file/);
    const bad = `--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,1 @@\n-# Nope\n+# Agents!\n`;
    expect(() => overlayPatch(spec, [bad])).toThrow(/does not apply/);
  });
});

describe('grading against acceptance criteria', () => {
  const task: LabTask = {
    id: 't',
    kind: 'feature',
    title: 'T',
    benchmarkTask: 'x',
    source: { type: 'invented', ref: '' },
    heldOut: false,
    criteria: [
      { id: 'a', label: 'A', checks: ['c1', 'c2'] },
      { id: 'b', label: 'B', checks: ['c3'] },
      { id: 'tests', label: 'Tests', patch: (p) => ({ met: /\.test\.ts/.test(p), message: '' }) },
    ],
  };
  it('meets a criterion only when every one of its checks passes; partial credit per criterion', () => {
    const ev = { checks: [{ id: 'c1', outcome: 'pass' }, { id: 'c2', outcome: 'fail' }, { id: 'c3', outcome: 'pass' }] as any };
    const g = grade(task, ev, 'diff --git a/ui/src/x.test.ts b/ui/src/x.test.ts\nnew file mode 100644\n');
    expect(g.met).toEqual(['b', 'tests']);
    expect(g.detail.a.checks.map((c) => c.outcome)).toEqual(['pass', 'fail']);
  });
  it('a missing check is not met', () => {
    expect(grade(task, { checks: [] }, '').met).toEqual([]);
  });
  it('every tiny-depth criterion maps to real evaluator checks', async () => {
    const { uiChecks } = await import('../../evaluator/tasks/tiny-depth/ui-checks.js');
    const known = new Set([...uiChecks.map((c) => c.spec.id), 'visual.depth', 'startup.build', 'startup.app', 'startup.patch', 'regression.ui', 'regression.python']);
    for (const c of REPOS.tiny.tasks[0].criteria) for (const id of c.checks ?? []) expect(known.has(id), id).toBe(true);
  });
});

describe('lab db', () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'lab-db-'))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('sessions own runs; suggestions own their runs; accepted suggestions are listed in order', () => {
    const db = new LabDb(join(dir, 'lab.db'));
    db.upsertRepo({ id: 'r', name: 'r', url: 'u', commit: 'c' });
    const s = db.createSession({ repoId: 'r', profileVersion: 1, skillsVersion: 'r @ c' });
    db.addRun({ id: 'run1', sessionId: s.id, suggestionId: null, taskId: 't', pairKey: `${s.id}/t/0` });
    const g = db.addSuggestion({ sessionId: s.id, rank: 1, title: 'T', description: 'D', file: 'f', diff: 'd', evidence: '' });
    db.addRun({ id: 'run2', sessionId: s.id, suggestionId: g.id, taskId: 't', pairKey: `${s.id}/t/0` });
    db.updateRun('run1', { status: 'done', tokens: 10, criteriaMet: ['a'], skillsFired: true });
    expect(db.sessionRuns(s.id).map((r) => [r.id, r.status, r.criteriaMet, r.skillsFired])).toEqual([['run1', 'done', ['a'], true]]);
    expect(db.suggestionRuns(g.id).map((r) => r.id)).toEqual(['run2']);
    db.setSuggestionStatus(g.id, 'accepted');
    expect(db.acceptedSuggestions('r').map((x) => x.id)).toEqual([g.id]);
    db.close();
  });
  it('paired runs share a seed', () => {
    expect(pairSeed('sess-0001/t/0')).toBe(pairSeed('sess-0001/t/0'));
    expect(pairSeed('sess-0001/t/0')).not.toBe(pairSeed('sess-0001/t/1'));
  });
});
