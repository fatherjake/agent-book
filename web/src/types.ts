/**
 * The data model: a session runs the current skills on a suite of tasks (its runs), and from those
 * runs it proposes suggestions (edits to skill files). Each suggestion is tested with its own runs
 * on the same tasks, so its numbers can be compared with the session's.
 */

export type TaskKind = 'feature' | 'fix' | 'refactor';

export interface Criterion {
  id: string;
  label: string;
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  criteria: Criterion[];
}

export interface Run {
  id: string;
  taskId: string;
  createdAt: string;
  status: 'running' | 'done' | 'error';
  tokens: number;
  costUsd: number;
  durationMs: number;
  /** Ids of the task's acceptance criteria this run met. */
  criteriaMet: string[];
}

export type SuggestionStatus = 'proposed' | 'testing' | 'tested' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  title: string;
  /** Plain-English explanation: what it changes and why the session's runs suggest it. */
  description: string;
  /** Skill file the change edits (repo-relative). */
  file: string;
  /** Unified diff of the change. */
  diff: string;
  status: SuggestionStatus;
  createdAt: string;
  runs: Run[];
}

export interface Session {
  id: string;
  createdAt: string;
  status: 'running' | 'done';
  /** Short description of the skills under test (e.g. the commit of the skill files). */
  skillsVersion: string;
  runs: Run[];
  suggestions: Suggestion[];
}

export interface Repo {
  name: string;
  url: string;
  commit: string;
  skills: string[];
  tasks: Task[];
}
