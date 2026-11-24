/**
 * The suggestions lab's state, one JSON file per analysed session: ~/.agent-book/lab/<session id>.json.
 *
 *   analysis     the analyst's run over the session (status, base commit, cost)
 *   brief        the task the evaluations replay, with checks for what done looks like; editable. Each
 *                edit bumps `version`; runs record the version they ran against, and only runs on the
 *                current version are compared.
 *   suggestions  ranked changes to the repo's agent setup, each with its edits, diff and candidate runs
 *   baseline     runs of the brief without any suggestion, shared by every suggestion
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Source } from './workspace.js';

export const LAB_DIR = () => process.env.AGENT_BOOK_LAB_DIR ?? join(homedir(), '.agent-book', 'lab');

export type SuggestionKind = 'instructions' | 'skill' | 'process' | 'lint' | 'hook' | 'docs' | 'other';

export interface Edit {
  /** Repo-relative path. */
  file: string;
  /** Exact text that occurs once in the file; empty means append (or create the file). */
  find: string;
  replace: string;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CheckResult {
  check: string;
  met: boolean;
  why: string;
}

export interface Run {
  id: string;
  arm: 'baseline' | 'candidate';
  /** The brief version it ran against. */
  briefVersion: number;
  status: 'running' | 'judging' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  /** The replay's Claude Code session id (its telemetry is under it). */
  sessionId: string;
  costUsd?: number;
  tokens?: Tokens;
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
  /** How the replay ended: success, error_max_budget_usd, timeout, … */
  ending?: string;
  /** The replay's final message. */
  result?: string;
  diffStat?: string;
  diff?: string;
  judge?: { checks: CheckResult[]; summary: string; costUsd: number; sessionId: string };
  error?: string;
}

export interface Suggestion {
  id: string;
  rank: number;
  title: string;
  kind: SuggestionKind;
  description: string;
  evidence: string;
  /** What should get better: fewer tokens, less time, more checks met, … */
  expected: string;
  edits: Edit[];
  /** The edits as a git diff against the base commit. */
  diff: string;
  runs: Run[];
  /** Your call on it: accepted or rejected (none while undecided). Recorded only; nothing is applied. */
  decision?: 'accepted' | 'rejected';
  decidedAt?: string;
}

export interface LabState {
  sessionId: string;
  analysis: {
    status: 'running' | 'done' | 'failed';
    startedAt: string;
    finishedAt?: string;
    error?: string;
    costUsd?: number;
    sessionId: string;
    /** Where replays start from: a git worktree at the session's start, a copy of its folder, or empty. */
    source: Source;
    /** The source in one line, for the UI. */
    sourceLabel: string;
    /** The model replays use: the one the session itself mostly used. */
    model: string;
    /** Suggestions whose edits didn't apply, with the reason. */
    rejected: { title: string; reason: string }[];
  } | null;
  brief: { version: number; task: string; checks: string[]; budgetUsd: number; edited: boolean } | null;
  suggestions: Suggestion[];
  baseline: Run[];
}

const file = (sessionId: string) => join(LAB_DIR(), `${sessionId}.json`);

export function loadLab(sessionId: string): LabState {
  try {
    const s = JSON.parse(readFileSync(file(sessionId), 'utf8')) as LabState;
    // Files from before workspace sources: the analysis always used a git worktree.
    const a = s.analysis as any;
    if (a && !a.source && a.repo) {
      a.source = { kind: 'git', repo: a.repo, rev: a.rev, from: a.revFrom ?? 'head' };
      a.sourceLabel = `git ${String(a.rev).slice(0, 8)}`;
    }
    return s;
  } catch {
    return { sessionId, analysis: null, brief: null, suggestions: [], baseline: [] };
  }
}

/** Write atomically: the UI polls these files while jobs update them. */
export function saveLab(state: LabState): void {
  mkdirSync(LAB_DIR(), { recursive: true });
  const tmp = `${file(state.sessionId)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file(state.sessionId));
}

/** Load, change and save in one step (jobs run concurrently against the same file). */
export function updateLab(sessionId: string, change: (s: LabState) => void): LabState {
  const s = loadLab(sessionId);
  change(s);
  saveLab(s);
  return s;
}

/** Every Claude Code session the lab started (analyst, replays, judges): kept out of the session list. */
export function labSessionIds(): Set<string> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(LAB_DIR()).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const n of names) {
    const s = loadLab(n.slice(0, -5));
    if (s.analysis?.sessionId) out.add(s.analysis.sessionId);
    for (const r of [...s.baseline, ...s.suggestions.flatMap((x) => x.runs)]) {
      out.add(r.sessionId);
      if (r.judge?.sessionId) out.add(r.judge.sessionId);
    }
  }
  return out;
}

/** A session's lab status in brief, for the session list. */
export interface LabSummary {
  /** analysing: the analyst is running; testing: an evaluation is; ready: analysed (with or without suggestions); failed. */
  status: 'analysing' | 'testing' | 'ready' | 'failed';
  suggestions: number;
  /** Suggestions not yet accepted or rejected. */
  open: number;
  accepted: number;
  /** Suggestions with no finished run on the current brief. */
  untested: number;
}

/** Every analysed session's lab status, by session id. */
export function labSummaries(): Map<string, LabSummary> {
  const out = new Map<string, LabSummary>();
  let names: string[] = [];
  try {
    names = readdirSync(LAB_DIR()).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const n of names) {
    const s = loadLab(n.slice(0, -5));
    if (!s.analysis) continue;
    const v = s.brief?.version;
    const going = (r: Run) => r.status === 'running' || r.status === 'judging';
    const testing = s.baseline.some(going) || s.suggestions.some((x) => x.runs.some(going));
    out.set(s.sessionId, {
      status: s.analysis.status === 'running' ? 'analysing' : s.analysis.status === 'failed' ? 'failed' : testing ? 'testing' : 'ready',
      suggestions: s.suggestions.length,
      open: s.suggestions.filter((x) => !x.decision).length,
      accepted: s.suggestions.filter((x) => x.decision === 'accepted').length,
      untested: s.suggestions.filter((x) => !x.runs.some((r) => r.briefVersion === v && r.status === 'done')).length,
    });
  }
  return out;
}

