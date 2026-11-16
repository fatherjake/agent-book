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
  /** Where the task came from: a commit in the repo's history, an injected bug, or written for the suite. */
  source: { type: 'commit' | 'injected' | 'invented'; ref: string };
  /** Held-out tasks are never used to propose suggestions, only to confirm them. */
  heldOut: boolean;
  /** Only approved tasks are used by sessions. */
  approved: boolean;
}

export interface Run {
  id: string;
  taskId: string;
  /** Shared by a session run and the matching run of each of its suggestions (same task and repeat). */
  pairKey: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'queued' | 'running' | 'done' | 'error';
  tokens: number;
  costUsd: number;
  durationMs: number;
  /** Ids of the task's acceptance criteria this run met. */
  criteriaMet: string[];
  /** Per criterion: met, and the evaluator checks behind it. */
  criteriaDetail: Record<string, { met: boolean; checks: { id: string; outcome: string; message?: string }[] }>;
  /** Did the agent use the repo's skills (from its tool calls)? null = unknown. */
  skillsFired: boolean | null;
  error: string | null;
}

export type SuggestionStatus = 'proposed' | 'testing' | 'tested' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  rank: number;
  evidence: string;
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

export type SessionStatus = 'running' | 'analysing' | 'testing' | 'done' | 'failed';

export interface Session {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  status: SessionStatus;
  error: string | null;
  /** Repo profile version the session ran under (environment + activation recipe). */
  profileVersion: number;
  /** Short description of the skills under test (e.g. the commit of the skill files). */
  skillsVersion: string;
  runs: Run[];
  suggestions: Suggestion[];
}

export interface Repo {
  id: string;
  name: string;
  url: string;
  commit: string;
}

// ---- repo profile: the output of setup (environment) and repo evaluation ------------------------------

export type StepStatus = 'ok' | 'warn' | 'fail' | 'running' | 'pending';

export interface SetupStep {
  label: string;
  status: StepStatus;
  detail: string;
  durationMs: number | null;
}

export interface EnvCommand {
  purpose: string;
  command: string;
  /** Where setup found it (e.g. 'AGENTS.md › Commands') or 'inferred'. */
  source: string;
  verified: boolean;
  result: string;
}

export interface InstructionSurface {
  path: string;
  what: string;
  /** auto: Claude Code loads it by itself; wired: setup made it load; not-loaded: deliberately left out. */
  loading: 'auto' | 'wired' | 'not-loaded';
  note: string;
}

export interface SkillInfo {
  name: string;
  role: string;
  usedFor: string;
  trigger: string;
}

export interface ActivationProbe {
  recipe: string;
  example: string;
  fired: number;
  total: number;
  chosen: boolean;
}

export interface SandboxConflict {
  issue: string;
  handling: string;
}

export interface RepoProfile {
  version: number;
  evaluatedAt: string;
  setup: SetupStep[];
  commands: EnvCommand[];
  surfaces: InstructionSurface[];
  skills: SkillInfo[];
  activation: { probes: ActivationProbe[]; finding: string; probeTask: string };
  conflicts: SandboxConflict[];
}
