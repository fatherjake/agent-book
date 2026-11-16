/**
 * Lab store (SQLite, results/lab.db): repos and their profiles, tasks with acceptance criteria,
 * sessions, suggestions, and runs. A run belongs to a session (the current skills) or to a suggestion
 * (the skills with that change); runs of the same task and repeat share a `pair_key`, so a suggestion's
 * runs can be compared with the session's run by run.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../runner/env.js';

export const LAB_DB_PATH = process.env.FRUGAL_LAB_DB ?? join(REPO_ROOT, 'results', 'lab.db');

export type TaskKind = 'feature' | 'fix' | 'refactor';
export interface Criterion {
  id: string;
  label: string;
}
export interface TaskRow {
  id: string;
  repoId: string;
  kind: TaskKind;
  title: string;
  criteria: Criterion[];
  source: { type: 'commit' | 'injected' | 'invented'; ref: string };
  heldOut: boolean;
  approved: boolean;
}
export interface SessionRow {
  id: string;
  repoId: string;
  profileVersion: number;
  skillsVersion: string;
  status: 'running' | 'analysing' | 'testing' | 'done' | 'failed';
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}
export type SuggestionStatus = 'proposed' | 'testing' | 'tested' | 'accepted' | 'rejected';
export interface SuggestionRow {
  id: string;
  sessionId: string;
  rank: number;
  title: string;
  description: string;
  file: string;
  diff: string;
  evidence: string;
  status: SuggestionStatus;
  createdAt: string;
}
export type RunStatusLab = 'queued' | 'running' | 'done' | 'error';
export interface RunRow {
  id: string;
  sessionId: string;
  suggestionId: string | null;
  taskId: string;
  pairKey: string;
  status: RunStatusLab;
  createdAt: string;
  finishedAt: string | null;
  tokens: number;
  costUsd: number;
  durationMs: number;
  criteriaMet: string[];
  /** Per-criterion evidence: the checks behind each criterion and their outcomes. */
  criteriaDetail: Record<string, { met: boolean; checks: { id: string; outcome: string; message?: string }[] }>;
  skillsFired: boolean | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  repo_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, version)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  criteria TEXT NOT NULL, source TEXT NOT NULL, held_out INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, profile_version INTEGER NOT NULL, skills_version TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, rank INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  file TEXT NOT NULL, diff TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, suggestion_id TEXT, task_id TEXT NOT NULL, pair_key TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
  tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
  criteria_met TEXT NOT NULL DEFAULT '[]', criteria_detail TEXT NOT NULL DEFAULT '{}', skills_fired INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS runs_suggestion ON runs(suggestion_id);
CREATE INDEX IF NOT EXISTS suggestions_session ON suggestions(session_id);
`;

const now = () => new Date().toISOString();
const bool = (v: unknown) => (v === null || v === undefined ? null : !!v);

export class LabDb {
  readonly raw: Database.Database;
  constructor(path = LAB_DB_PATH, opts: { readonly?: boolean } = {}) {
    if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path, opts.readonly ? { readonly: true, fileMustExist: true } : {});
    if (!opts.readonly) {
      this.raw.pragma('journal_mode = WAL');
      this.raw.exec(SCHEMA);
    }
  }
  close() {
    this.raw.close();
  }

  // ---- repos, profiles, tasks ------------------------------------------------------------------------
  upsertRepo(r: { id: string; name: string; url: string; commit: string }) {
    this.raw
      .prepare(`INSERT INTO repos (id, name, url, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, commit_sha = excluded.commit_sha`)
      .run(r.id, r.name, r.url, r.commit, now());
  }
  getRepo(id: string): { id: string; name: string; url: string; commit: string } | null {
    const r = this.raw.prepare('SELECT * FROM repos WHERE id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, url: r.url, commit: r.commit_sha } : null;
  }
  listRepos() {
    return (this.raw.prepare('SELECT id FROM repos ORDER BY created_at').all() as any[]).map((r) => this.getRepo(r.id)!);
  }
  saveProfile(repoId: string, profile: unknown): number {
    const v = ((this.raw.prepare('SELECT MAX(version) v FROM profiles WHERE repo_id = ?').get(repoId) as any)?.v ?? 0) + 1;
    this.raw.prepare('INSERT INTO profiles (repo_id, version, json, created_at) VALUES (?, ?, ?, ?)').run(repoId, v, JSON.stringify({ ...(profile as object), version: v }), now());
    return v;
  }
  latestProfile(repoId: string): any | null {
    const r = this.raw.prepare('SELECT json FROM profiles WHERE repo_id = ? ORDER BY version DESC LIMIT 1').get(repoId) as any;
    return r ? JSON.parse(r.json) : null;
  }
  upsertTask(t: TaskRow) {
    this.raw
      .prepare(`INSERT INTO tasks (id, repo_id, kind, title, criteria, source, held_out, approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, criteria = excluded.criteria,
          source = excluded.source, held_out = excluded.held_out`)
      .run(t.id, t.repoId, t.kind, t.title, JSON.stringify(t.criteria), JSON.stringify(t.source), t.heldOut ? 1 : 0, t.approved ? 1 : 0);
  }
  setTaskApproved(id: string, approved: boolean) {
    this.raw.prepare('UPDATE tasks SET approved = ? WHERE id = ?').run(approved ? 1 : 0, id);
  }
  listTasks(repoId: string): TaskRow[] {
    return (this.raw.prepare('SELECT * FROM tasks WHERE repo_id = ? ORDER BY held_out, id').all(repoId) as any[]).map((r) => ({
      id: r.id,
      repoId: r.repo_id,
      kind: r.kind,
      title: r.title,
      criteria: JSON.parse(r.criteria),
      source: JSON.parse(r.source),
      heldOut: !!r.held_out,
      approved: !!r.approved,
    }));
  }

  // ---- sessions -------------------------------------------------------------------------------------
  createSession(s: { repoId: string; profileVersion: number; skillsVersion: string }): SessionRow {
    const n = ((this.raw.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n as number) + 1;
    const id = `sess-${String(n).padStart(4, '0')}`;
    this.raw
      .prepare('INSERT INTO sessions (id, repo_id, profile_version, skills_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, s.repoId, s.profileVersion, s.skillsVersion, 'running', now());
    return this.getSession(id)!;
  }
  setSessionStatus(id: string, status: SessionRow['status'], error?: string) {
    const done = status === 'done' || status === 'failed';
    this.raw.prepare('UPDATE sessions SET status = ?, error = COALESCE(?, error), finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?').run(status, error ?? null, done ? 1 : 0, now(), id);
  }
  getSession(id: string): SessionRow | null {
    const r = this.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    return r
      ? { id: r.id, repoId: r.repo_id, profileVersion: r.profile_version, skillsVersion: r.skills_version, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at, error: r.error }
      : null;
  }
  listSessions(repoId?: string): SessionRow[] {
    const rows = (repoId ? this.raw.prepare('SELECT id FROM sessions WHERE repo_id = ? ORDER BY created_at DESC').all(repoId) : this.raw.prepare('SELECT id FROM sessions ORDER BY created_at DESC').all()) as any[];
    return rows.map((r) => this.getSession(r.id)!);
  }

  // ---- suggestions ----------------------------------------------------------------------------------
  addSuggestion(s: Omit<SuggestionRow, 'id' | 'createdAt' | 'status'> & { status?: SuggestionStatus }): SuggestionRow {
    const n = ((this.raw.prepare('SELECT COUNT(*) n FROM suggestions WHERE session_id = ?').get(s.sessionId) as any).n as number) + 1;
    const id = `${s.sessionId}-s${n}`;
    this.raw
      .prepare('INSERT INTO suggestions (id, session_id, rank, title, description, file, diff, evidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.sessionId, s.rank, s.title, s.description, s.file, s.diff, s.evidence, s.status ?? 'proposed', now());
    return this.getSuggestion(id)!;
  }
  setSuggestionStatus(id: string, status: SuggestionStatus) {
    this.raw.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, id);
  }
  getSuggestion(id: string): SuggestionRow | null {
    const r = this.raw.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as any;
    return r
      ? { id: r.id, sessionId: r.session_id, rank: r.rank, title: r.title, description: r.description, file: r.file, diff: r.diff, evidence: r.evidence, status: r.status, createdAt: r.created_at }
      : null;
  }
  listSuggestions(sessionId: string): SuggestionRow[] {
    return (this.raw.prepare('SELECT id FROM suggestions WHERE session_id = ? ORDER BY rank, id').all(sessionId) as any[]).map((r) => this.getSuggestion(r.id)!);
  }
  /** Accepted suggestions of a repo, oldest first: they make up the next sessions' skills. */
  acceptedSuggestions(repoId: string): SuggestionRow[] {
    return (
      this.raw
        .prepare(`SELECT g.id FROM suggestions g JOIN sessions s ON s.id = g.session_id WHERE s.repo_id = ? AND g.status = 'accepted' ORDER BY g.created_at`)
        .all(repoId) as any[]
    ).map((r) => this.getSuggestion(r.id)!);
  }

  // ---- runs -------------------------------------------------------------------------------------------
  addRun(r: { id: string; sessionId: string; suggestionId: string | null; taskId: string; pairKey: string }) {
    this.raw
      .prepare('INSERT INTO runs (id, session_id, suggestion_id, task_id, pair_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.sessionId, r.suggestionId, r.taskId, r.pairKey, 'queued', now());
  }
  updateRun(id: string, u: Partial<Omit<RunRow, 'id' | 'sessionId' | 'suggestionId' | 'taskId' | 'pairKey' | 'createdAt'>>) {
    const map: Record<string, [string, (v: any) => unknown]> = {
      status: ['status', (v) => v],
      finishedAt: ['finished_at', (v) => v],
      tokens: ['tokens', (v) => v],
      costUsd: ['cost_usd', (v) => v],
      durationMs: ['duration_ms', (v) => v],
      criteriaMet: ['criteria_met', (v) => JSON.stringify(v)],
      criteriaDetail: ['criteria_detail', (v) => JSON.stringify(v)],
      skillsFired: ['skills_fired', (v) => (v === null ? null : v ? 1 : 0)],
      error: ['error', (v) => v],
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(u)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v));
    }
    if (sets.length) this.raw.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  private runRow(r: any): RunRow {
    return {
      id: r.id,
      sessionId: r.session_id,
      suggestionId: r.suggestion_id,
      taskId: r.task_id,
      pairKey: r.pair_key,
      status: r.status,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      tokens: r.tokens,
      costUsd: r.cost_usd,
      durationMs: r.duration_ms,
      criteriaMet: JSON.parse(r.criteria_met),
      criteriaDetail: JSON.parse(r.criteria_detail),
      skillsFired: bool(r.skills_fired),
      error: r.error,
    };
  }
  sessionRuns(sessionId: string): RunRow[] {
    return (this.raw.prepare('SELECT * FROM runs WHERE session_id = ? AND suggestion_id IS NULL ORDER BY created_at, id').all(sessionId) as any[]).map((r) => this.runRow(r));
  }
  suggestionRuns(suggestionId: string): RunRow[] {
    return (this.raw.prepare('SELECT * FROM runs WHERE suggestion_id = ? ORDER BY created_at, id').all(suggestionId) as any[]).map((r) => this.runRow(r));
  }
  /** Runs left 'running'/'queued' by a process that died are marked as errors on startup. */
  failStaleRuns(reason: string) {
    this.raw.prepare(`UPDATE runs SET status = 'error', error = ? WHERE status IN ('queued', 'running')`).run(reason);
  }
}
