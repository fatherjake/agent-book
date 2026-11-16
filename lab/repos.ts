/**
 * Repos the lab knows, their skill files, and their task suites. A task is a benchmark task
 * (benchmark/tasks/<id>: image, prompt, spec, hidden evaluator) plus acceptance criteria: each criterion
 * is met when all of its evaluator checks pass (or its patch check holds). Partial credit is the point:
 * a run that meets 5 of 8 criteria did 5/8 of the task.
 */
import type { CheckResult, EvaluationResult } from '../runner/types.js';
import type { Criterion, TaskKind } from './db.js';
import type { RepoSkillsSpec } from './skills.js';

export interface LabCriterion extends Criterion {
  /** Evaluator check ids that must all pass. */
  checks?: string[];
  /** Or a check on the run's workspace.patch. */
  patch?: (patch: string) => { met: boolean; message: string };
}

export interface LabTask {
  id: string;
  kind: TaskKind;
  title: string;
  /** benchmark/tasks/<id> that provides the image, prompt, spec and evaluator. */
  benchmarkTask: string;
  criteria: LabCriterion[];
  source: { type: 'commit' | 'injected' | 'invented'; ref: string };
  heldOut: boolean;
}

export interface Recipe {
  id: string;
  label: string;
  wrap: (prompt: string) => string;
}

export interface EnvCommandSpec {
  purpose: string;
  /** Run in /workspace as the sandbox user. */
  command: string;
  /** Where it comes from in the repo (shown on the repo page). */
  source: string;
}

export interface LabRepo {
  name: string;
  skills: RepoSkillsSpec;
  /** Candidate ways to invoke the skills; setup's probes measure each and pick the most reliable. */
  recipes: Recipe[];
  /** Used when setup has not measured activation yet. */
  defaultRecipe: string;
  /** The repo's own commands, verified by setup in the sandbox. */
  commands: EnvCommandSpec[];
  /** A short task for activation probes (only the first calls matter: does the skill load?). */
  probeTask: string;
  /** A run "used the skills" when its trace shows one of these (skill invocations or skill file reads). */
  skillMarkers: RegExp;
  tasks: LabTask[];
}

const addedFiles = (patch: string) => [...patch.matchAll(/^diff --git a\/\S+ b\/(\S+)\nnew file mode/gm)].map((m) => m[1]);
const touchedFiles = (patch: string) => [...patch.matchAll(/^diff --git a\/\S+ b\/(\S+)/gm)].map((m) => m[1]);

export const REPOS: Record<string, LabRepo> = {
  tiny: {
    name: 'tiny',
    skills: {
      id: 'tiny',
      url: 'https://github.com/fatherjake/tiny.git',
      commit: 'f14513a913969ea30bf15a46832f978005205995',
      paths: ['CLAUDE.md', 'AGENTS.md', '.agents'],
      links: [{ link: '.claude/skills', target: '../.agents/skills' }],
    },
    recipes: [
      { id: 'plain', label: 'Task prompt only', wrap: (p) => p },
      { id: 'mode', label: 'Prompt + "use saiyan mode"', wrap: (p) => `Use saiyan mode.\n\n${p}` },
      { id: 'slash', label: 'Slash command', wrap: (p) => `/saiyan ${p}` },
    ],
    defaultRecipe: 'mode',
    commands: [
      { purpose: 'Test (Python)', command: '.venv/bin/python -m pytest -q -p no:cacheprovider', source: 'AGENTS.md › Commands (uv run pytest)' },
      { purpose: 'Test (UI)', command: 'cd ui && npx vitest run --reporter=dot', source: 'README › Run the tests (npm test)' },
      { purpose: 'Build (UI)', command: 'cd ui && npm run build', source: 'ui/package.json' },
      { purpose: 'Lint and line limit', command: '.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/python scripts/check_loc.py', source: 'AGENTS.md › Commands' },
      { purpose: 'Run (sim + UI)', command: '/opt/frugal/task/app start --no-build --bots 5', source: 'README › Run the sim / Run the UI' },
      { purpose: 'Health check', command: 'curl -sf http://127.0.0.1:8000/status && curl -sf -o /dev/null http://127.0.0.1:3000/', source: '.agents/skills/verify-tiny › Doctor' },
    ],
    probeTask: 'Add a --quiet flag to scripts/check_loc.py that suppresses the output when every file is within the limit. Keep the exit codes unchanged.',
    skillMarkers: /saiyan/i,
    tasks: [
      {
        id: 'depth-chart',
        kind: 'feature',
        title: 'Add a depth chart tab to the order book card',
        benchmarkTask: 'tiny-depth',
        source: { type: 'invented', ref: 'written for the suite (spec + hidden reference)' },
        heldOut: false,
        criteria: [
          { id: 'tab', label: 'Depth tab after Order Book; Order Book stays the default and still works', checks: ['ui.depth.tab', 'ui.depth.book_tab_intact'] },
          { id: 'plot', label: 'The plot renders with the Mid and Spread summary', checks: ['ui.depth.render', 'ui.depth.summary'] },
          { id: 'tooltip', label: 'Hover tooltip shows the right level, total and value on both sides', checks: ['ui.depth.hover_bids', 'ui.depth.hover_asks', 'ui.depth.hover_leave'] },
          { id: 'live', label: 'New book frames redraw the chart (pinned book and live sim)', checks: ['ui.depth.live_update', 'ui.depth.live_sim'] },
          { id: 'empty', label: 'Empty and one-sided books are handled', checks: ['ui.depth.empty', 'ui.depth.one_sided'] },
          { id: 'design', label: 'Looks like the design (visual score at least 75)', checks: ['visual.depth'] },
          {
            id: 'tests',
            label: 'The depth logic has unit tests',
            patch: (patch) => {
              const tests = addedFiles(patch).filter((f) => /^ui\/src\/.*\.test\.tsx?$/.test(f));
              return { met: tests.length > 0, message: tests.length ? `added ${tests.join(', ')}` : 'no new ui/src/**/*.test.ts file' };
            },
          },
          { id: 'build', label: 'Build passes, existing tests pass, no page errors', checks: ['startup.build', 'regression.ui', 'regression.python', 'startup.app', 'ui.no_page_errors'] },
        ],
      },
    ],
  },
};

export function getRepo(id: string): LabRepo {
  const r = REPOS[id];
  if (!r) throw new Error(`unknown repo ${id} (known: ${Object.keys(REPOS).join(', ')})`);
  return r;
}

export function recipeOf(repo: LabRepo, id: string | null | undefined): Recipe {
  return repo.recipes.find((r) => r.id === id) ?? repo.recipes.find((r) => r.id === repo.defaultRecipe)!;
}

export function getTask(repo: LabRepo, id: string): LabTask {
  const t = repo.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id} in ${repo.name}`);
  return t;
}

export interface Graded {
  met: string[];
  detail: Record<string, { met: boolean; checks: { id: string; outcome: string; message?: string }[] }>;
}

/** Acceptance criteria met by a run, from its evaluation and its patch. */
export function grade(task: LabTask, evaluation: Pick<EvaluationResult, 'checks'>, patch: string): Graded {
  const byId = new Map<string, CheckResult>(evaluation.checks.map((c) => [c.id, c]));
  const detail: Graded['detail'] = {};
  for (const c of task.criteria) {
    if (c.patch) {
      const r = c.patch(patch);
      detail[c.id] = { met: r.met, checks: [{ id: 'patch', outcome: r.met ? 'pass' : 'fail', message: r.message }] };
      continue;
    }
    const checks = (c.checks ?? []).map((id) => {
      const r = byId.get(id);
      return { id, outcome: r?.outcome ?? 'missing', ...(r?.message ? { message: r.message.slice(0, 300) } : {}) };
    });
    detail[c.id] = { met: checks.length > 0 && checks.every((x) => x.outcome === 'pass'), checks };
  }
  return { met: task.criteria.filter((c) => detail[c.id].met).map((c) => c.id), detail };
}

export { touchedFiles };
