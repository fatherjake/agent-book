/**
 * Sessions: run the current skills (the repo's skill files + every accepted suggestion) on each approved
 * task, `runsPerTask` times, then (phase 3) analyse the runs into suggestions and test the top ones.
 */
import { logger } from '../runner/logger.js';
import type { LabDb, SessionRow } from './db.js';
import { getRepo, recipeOf, type LabRepo, type Recipe } from './repos.js';
import { analyseSession } from './analyse.js';
import { executeRun, newLabRunId } from './run.js';
import { overlayPatch } from './skills.js';

const log = logger('lab.session');

/** Make sure the repo and its task suite are in the DB (tasks from the registry; approval state is kept). */
export function registerRepo(db: LabDb, repoId: string): LabRepo {
  const repo = getRepo(repoId);
  db.upsertRepo({ id: repoId, name: repo.name, url: repo.skills.url.replace(/\.git$/, ''), commit: repo.skills.commit });
  const known = new Map(db.listTasks(repoId).map((t) => [t.id, t]));
  for (const t of repo.tasks)
    db.upsertTask({
      id: t.id,
      repoId,
      kind: t.kind,
      title: t.title,
      criteria: t.criteria.map((c) => ({ id: c.id, label: c.label })),
      source: t.source,
      heldOut: t.heldOut,
      approved: known.get(t.id)?.approved ?? true,
    });
  return repo;
}

/** Skills version of the next session: the repo's files plus accepted suggestions, in order. */
export function currentSkills(db: LabDb, repoId: string, repo: LabRepo): { label: string; diffs: string[] } {
  const accepted = db.acceptedSuggestions(repoId);
  return {
    label: `${repo.name} @ ${repo.skills.commit.slice(0, 7)}${accepted.length ? ` + ${accepted.length} accepted` : ''}`,
    diffs: accepted.map((s) => s.diff),
  };
}

/** Run `items` with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const x = items[i++];
      await fn(x);
    }
  });
  await Promise.all(workers);
}

export interface SessionOptions {
  runsPerTask: number;
  concurrency: number;
  /** How many of the ranked suggestions are tested (each with one paired run per session run). */
  testTop?: number;
  signal?: AbortSignal;
}

/** The activation recipe sessions use: the one setup measured as most reliable, else the repo default. */
export function sessionRecipe(db: LabDb, repoId: string, repo: LabRepo): Recipe {
  return recipeOf(repo, db.latestProfile(repoId)?.activation?.chosenId);
}

/** Diffs of the skills a session ran with (accepted suggestions at session start, in order). */
export function sessionSkillDiffs(db: LabDb, sessionId: string): string[] {
  const s = db.getSession(sessionId)!;
  return db.acceptedSuggestions(s.repoId).filter((g) => db.getSession(g.sessionId)!.createdAt < s.createdAt).map((g) => g.diff);
}

export function createSession(db: LabDb, repoId: string, opts: SessionOptions): { session: SessionRow; overlay: string; repo: LabRepo } {
  const repo = registerRepo(db, repoId);
  const profile = db.latestProfile(repoId);
  const skills = currentSkills(db, repoId, repo);
  const overlay = overlayPatch(repo.skills, skills.diffs);
  const session = db.createSession({ repoId, profileVersion: profile?.version ?? 0, skillsVersion: skills.label });
  const tasks = db.listTasks(repoId).filter((t) => t.approved && !t.heldOut);
  for (let k = 0; k < opts.runsPerTask; k++)
    for (const t of tasks) db.addRun({ id: newLabRunId(), sessionId: session.id, suggestionId: null, taskId: t.id, pairKey: `${session.id}/${t.id}/${k}` });
  return { session, overlay, repo };
}

/** Execute a session's queued runs. Returns when all have finished. */
export async function runSessionRuns(db: LabDb, sessionId: string, overlay: string, repo: LabRepo, opts: SessionOptions): Promise<void> {
  const queued = db.sessionRuns(sessionId).filter((r) => r.status === 'queued');
  log.info('session runs starting', { sessionId, runs: queued.length, concurrency: opts.concurrency });
  await pool(queued, opts.concurrency, (r) =>
    executeRun(db, { runId: r.id, repo, recipe: sessionRecipe(db, repo.skills.id, repo), task: repo.tasks.find((t) => t.id === r.taskId)!, overlay, pairKey: r.pairKey, signal: opts.signal }),
  );
}

/** Ask the analyst for suggestions (skipped when the session already has some). */
export async function analyse(db: LabDb, sessionId: string, repo: LabRepo, opts: { signal?: AbortSignal } = {}): Promise<void> {
  if (db.listSuggestions(sessionId).length) return;
  if (!db.sessionRuns(sessionId).some((r) => r.status === 'done')) throw new Error('no finished runs to analyse');
  db.setSessionStatus(sessionId, 'analysing');
  const res = await analyseSession(db, sessionId, repo, sessionSkillDiffs(db, sessionId), opts);
  log.info('analysis done', { sessionId, suggestions: res.stored, rejected: res.rejected.length, analystTokens: res.tokens });
}

/**
 * Test the top `testTop` suggestions: for every finished session run, one run with the suggestion applied
 * and the same task, repeat and seed (pair key). A suggestion is 'tested' once all its runs have finished.
 */
export async function testSuggestions(db: LabDb, sessionId: string, repo: LabRepo, opts: SessionOptions): Promise<void> {
  const base = sessionSkillDiffs(db, sessionId);
  const top = db
    .listSuggestions(sessionId)
    .filter((g) => g.status === 'proposed' || g.status === 'testing')
    .slice(0, opts.testTop ?? 3);
  if (!top.length) return;
  db.setSessionStatus(sessionId, 'testing');
  const sessionRuns = db.sessionRuns(sessionId).filter((r) => r.status === 'done');
  const jobs: { runId: string; overlay: string; taskId: string; pairKey: string }[] = [];
  for (const g of top) {
    let overlay: string;
    try {
      overlay = overlayPatch(repo.skills, [...base, g.diff]);
    } catch (e) {
      log.warn('suggestion does not apply; rejected', { id: g.id, error: String(e) });
      db.setSuggestionStatus(g.id, 'rejected');
      continue;
    }
    db.setSuggestionStatus(g.id, 'testing');
    const have = new Set(db.suggestionRuns(g.id).map((r) => r.pairKey));
    for (const r of sessionRuns) if (!have.has(r.pairKey)) db.addRun({ id: newLabRunId(), sessionId, suggestionId: g.id, taskId: r.taskId, pairKey: r.pairKey });
    for (const r of db.suggestionRuns(g.id).filter((x) => x.status === 'queued')) jobs.push({ runId: r.id, overlay, taskId: r.taskId, pairKey: r.pairKey });
  }
  log.info('testing suggestions', { sessionId, suggestions: top.length, runs: jobs.length });
  await pool(jobs, opts.concurrency, (j) =>
    executeRun(db, { runId: j.runId, repo, recipe: sessionRecipe(db, repo.skills.id, repo), task: repo.tasks.find((t) => t.id === j.taskId)!, overlay: j.overlay, pairKey: j.pairKey, signal: opts.signal }),
  );
  for (const g of top) {
    const runs = db.suggestionRuns(g.id);
    if (db.getSuggestion(g.id)!.status === 'testing' && runs.length && runs.every((r) => r.status === 'done' || r.status === 'error')) db.setSuggestionStatus(g.id, 'tested');
  }
}

/** The whole session: runs → analysis → testing the top suggestions. Resumable: finished phases are skipped. */
export async function runSession(db: LabDb, sessionId: string, overlay: string, repo: LabRepo, opts: SessionOptions): Promise<void> {
  try {
    await runSessionRuns(db, sessionId, overlay, repo, opts);
    if (opts.signal?.aborted) throw new Error('interrupted');
    await analyse(db, sessionId, repo, opts);
    if (opts.signal?.aborted) throw new Error('interrupted');
    await testSuggestions(db, sessionId, repo, opts);
    db.setSessionStatus(sessionId, 'done');
  } catch (e) {
    db.setSessionStatus(sessionId, 'failed', String((e as Error)?.message ?? e));
    throw e;
  }
}
