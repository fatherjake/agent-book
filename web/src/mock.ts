/**
 * MOCK DATA for the UI mockup. Deterministic: the same numbers on every load; only the timestamps
 * are relative to the time the page loads. Replace with the real API once the backend exists.
 */
import type { Repo, Run, Session, Suggestion, SuggestionStatus, Task } from './types';

const SKILLS = '.agents/skills/saiyan';

export const TASKS: Task[] = [
  {
    id: 'depth-chart',
    kind: 'feature',
    title: 'Add a depth chart tab to the order book card',
    criteria: [
      { id: 'tab', label: 'Depth tab after Order Book; Order Book stays the default' },
      { id: 'axis', label: 'Plot centred on the mid price with a symmetric price axis' },
      { id: 'tooltip', label: 'Hover tooltip shows the right level, total and value' },
      { id: 'live', label: 'New book frames redraw the chart' },
      { id: 'empty', label: 'An empty book shows "No liquidity"' },
      { id: 'tests', label: 'Depth logic has unit tests' },
      { id: 'build', label: 'Build passes, no test regressions' },
    ],
  },
  {
    id: 'funding-sign',
    kind: 'fix',
    title: 'Funding payments have the wrong sign for short positions',
    criteria: [
      { id: 'repro', label: 'A failing test reproduces the bug before the fix' },
      { id: 'shorts', label: 'Shorts receive funding when the rate is negative' },
      { id: 'longs', label: 'Long positions are unchanged' },
      { id: 'regress', label: 'Full test suite passes' },
      { id: 'scope', label: 'No changes outside the funding code path' },
    ],
  },
  {
    id: 'candle-gap',
    kind: 'fix',
    title: 'Candle chart shows a gap after the sim restarts',
    criteria: [
      { id: 'repro', label: 'The gap is reproduced from a restarted sim' },
      { id: 'fill', label: 'Candles are continuous across a restart' },
      { id: 'regress', label: 'Full test suite passes' },
      { id: 'scope', label: 'No changes outside the candle and store code' },
    ],
  },
  {
    id: 'split-api',
    kind: 'refactor',
    title: 'Move the history routes out of core/api.py',
    criteria: [
      { id: 'moved', label: 'History routes live in their own module' },
      { id: 'same', label: 'API responses are byte-identical before and after' },
      { id: 'loc', label: 'Every file stays under the 1,000-line limit' },
      { id: 'dead', label: 'No compatibility layer or dead code left behind' },
      { id: 'lint', label: 'ruff check and format pass' },
    ],
  },
];

export const REPO: Repo = {
  name: 'tiny',
  url: 'https://github.com/fatherjake/tiny',
  commit: 'f14513a',
  skills: [`${SKILLS}/SKILL.md`, `${SKILLS}/playbooks/*.md`, `${SKILLS}/principals/*.md`, '.agents/skills/verify-tiny/SKILL.md'],
  tasks: TASKS,
};

// ---- deterministic generation ---------------------------------------------------------------------

function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** Typical cost per task under the session's skills, and how often each criterion is met. */
const PROFILE: Record<string, { tokens: number; spread: number; minutes: number; met: Record<string, number> }> = {
  'depth-chart': { tokens: 260_000, spread: 0.6, minutes: 3.5, met: { tab: 0.95, axis: 0.8, tooltip: 0.6, live: 0.7, empty: 0.85, tests: 0.55, build: 0.95 } },
  'funding-sign': { tokens: 140_000, spread: 0.4, minutes: 2, met: { repro: 0.45, shorts: 0.85, longs: 0.9, regress: 0.9, scope: 0.7 } },
  'candle-gap': { tokens: 190_000, spread: 0.5, minutes: 2.8, met: { repro: 0.35, fill: 0.65, regress: 0.9, scope: 0.75 } },
  'split-api': { tokens: 210_000, spread: 0.45, minutes: 3, met: { moved: 0.95, same: 0.8, loc: 0.6, dead: 0.5, lint: 0.85 } },
};

/** What a suggestion does: token multiplier per task and criterion probability changes. */
interface Effect {
  tokens?: Partial<Record<string, number>>;
  met?: Partial<Record<string, Partial<Record<string, number>>>>;
}

/**
 * `pair` is shared by a session's run and the matching run of each of its suggestions (same task, same
 * repeat): they use the same random draws, as paired runs would, so only the suggestion's effect differs.
 */
function makeRun(seed: string, pair: string, task: Task, createdMinAgo: number, effect: Effect = {}, status: Run['status'] = 'done'): Run {
  const r = rng(pair);
  const p = PROFILE[task.id];
  const factor = effect.tokens?.[task.id] ?? 1;
  // Mostly within ±12% of the typical cost, with an occasional expensive run (a verification loop).
  const skew = r() < 0.1 ? 1 + 0.4 + r() * p.spread : 1 + (r() - 0.5) * 0.24;
  const tokens = Math.round((p.tokens * factor * skew) / 100) * 100;
  const criteriaMet = task.criteria
    .filter((c) => r() < Math.min(0.99, Math.max(0.01, p.met[c.id] + (effect.met?.[task.id]?.[c.id] ?? 0))))
    .map((c) => c.id);
  const running = status === 'running';
  return {
    id: `run-${Math.floor(rng(seed + '#id')() * 0xffffff).toString(16).padStart(6, '0')}`,
    taskId: task.id,
    createdAt: ago(createdMinAgo),
    status,
    tokens: running ? Math.round(tokens * 0.35) : tokens,
    costUsd: Math.round(tokens * (running ? 0.35 : 1) * 0.00000092 * 1000) / 1000,
    durationMs: Math.round(p.minutes * 60_000 * (tokens / p.tokens) * (running ? 0.35 : 1)),
    criteriaMet: running ? [] : criteriaMet,
  };
}

/** `perTask` runs of every task, started `startMinAgo` minutes ago, a couple of minutes apart. */
function runSet(seed: string, pairGroup: string, perTask: number, startMinAgo: number, effect: Effect = {}, runningFrom = Infinity): Run[] {
  const out: Run[] = [];
  let i = 0;
  for (let k = 0; k < perTask; k++)
    for (const t of TASKS) {
      const at = startMinAgo - i * 2;
      out.push(makeRun(`${seed}/${t.id}/${k}`, `${pairGroup}/${t.id}/${k}`, t, Math.max(at, 0), effect, i >= runningFrom ? 'running' : 'done'));
      i++;
    }
  return out;
}

interface SuggestionSpec {
  title: string;
  description: string;
  file: string;
  diff: string;
  effect: Effect;
}

const SPECS: Record<string, SuggestionSpec> = {
  scriptedVisual: {
    title: 'Script the visual check instead of reading screenshots',
    description:
      'In runs that checked their UI work, the agent took screenshots and read them back into the conversation, often 4 to 6 times. Every image stays in context for every later call, so these runs cost about twice as much. This change tells the agent to compare against the design with a script that prints a score and the regions that differ, and to look at an image only if the score is low.',
    file: `${SKILLS}/playbooks/feature.md`,
    diff: `@@ -7,4 +7,6 @@
 4. **Build.** Prefer deleting and reusing over adding (\`principals/laziness-protocol.md\`, \`principals/subtract-before-you-add.md\`). Add tests that call the code the way users do.
-5. **Verify on the real surface** with the project's \`verify-*\` skill. Add or update its feature file if you added a user-facing path.
+5. **Verify on the real surface** with the project's \`verify-*\` skill. Add or update its feature file if you added a user-facing path.
+   For visual work, compare against the design with a script that prints a similarity score and the regions that differ.
+   Read a screenshot into the conversation only when the score is low, and at most once per fix.
 6. Run \`playbooks/ship.md\`.`,
    effect: { tokens: { 'depth-chart': 0.72 }, met: { 'depth-chart': { live: 0.1, tooltip: 0.05 } } },
  },
  targetedRead: {
    title: 'Read only the files the change touches',
    description:
      'Most runs spend a third of their tokens on step 1, reading whole files to "understand the area". Those file contents are re-sent with every later call. This change asks the agent to list the files first and read only the parts it will change or call, so the early context stays small.',
    file: `${SKILLS}/playbooks/feature.md`,
    diff: `@@ -2,3 +2,4 @@
-1. **Understand the area.** Read the code and docs that the change touches. Note the conventions you must follow.
+1. **Understand the area.** List the files first, then read only the parts the change touches or calls.
+   Prefer \`grep -n\` and line ranges over whole files. Note the conventions you must follow.
 2. **Shape the data first.** Decide the core types and where state lives before writing logic (\`principals/type-system-discipline.md\`). Where the design is unclear, sketch two options and pick one with a stated reason.`,
    effect: { tokens: { 'depth-chart': 0.82, 'funding-sign': 0.9, 'candle-gap': 0.88, 'split-api': 0.9 } },
  },
  reproFirst: {
    title: 'Make the failing test a required step for fixes',
    description:
      'Fix runs met the "failing test reproduces the bug" criterion less than half the time: the agent often fixed the code first and wrote no test, or a test that passed before the fix too. This change makes the failing test mandatory and asks the agent to show it failing before touching the code.',
    file: `${SKILLS}/playbooks/bug-fix.md`,
    diff: `@@ -5,3 +5,4 @@
 2. **Find the cause.** List candidate causes, then rule them out with runtime evidence until one survives. Add logging if the state is unclear. Read \`principals/fix-root-causes.md\`.
-3. **Write the failing check first** when a cheap test exists (see \`principals/test-behavior-not-implementation.md\`). Commit it before the fix so history shows fail, then pass.
+3. **Write the failing check first** (see \`principals/test-behavior-not-implementation.md\`). Run it and show the failure before changing any code.
+   If no cheap test is possible, say why in the reply.
 4. **Make the smallest change the evidence justifies.** Revert anything the evidence did not support.`,
    effect: { tokens: { 'funding-sign': 1.12, 'candle-gap': 1.1 }, met: { 'funding-sign': { repro: 0.45, scope: 0.1 }, 'candle-gap': { repro: 0.45, fill: 0.15 } } },
  },
  lineLimit: {
    title: "Name the repo's line limit in the refactor playbook",
    description:
      'Refactor runs left a file over the 1,000-line limit 40% of the time, because nothing in the skills mentions it; the rule only lives in the README. This change adds the line-limit script to the baseline step so the agent runs it before and after.',
    file: `${SKILLS}/playbooks/refactor.md`,
    diff: `@@ -4,2 +4,3 @@
-1. **Record the baseline.** Run the tests and the \`verify-*\` skill first and save the results.
+1. **Record the baseline.** Run the tests, \`scripts/check_loc.py\` and the \`verify-*\` skill first and save the results.
+   Every file must stay under the repo's line limit after the change.
 2. **Remove first.** Delete dead code, unused exports, and redundant checks before restructuring (\`principals/subtract-before-you-add.md\`).`,
    effect: { tokens: { 'split-api': 1.03 }, met: { 'split-api': { loc: 0.35 } } },
  },
  noTodoCopy: {
    title: 'Skip copying the playbook into the todo list on short tasks',
    description:
      'Copying the playbook steps into the todo list costs one or two extra calls at the start and an update call per step. On these tasks the agent rarely skipped a step either way. This change keeps the todo list only for tasks the agent expects to take more than about ten steps.',
    file: `${SKILLS}/SKILL.md`,
    diff: `@@ -13,3 +13,3 @@
 2. Pick the playbook that matches the request. If none fits, say so and use the closest one.
-3. Copy that playbook's steps into the todo list before doing any work. If you skip a step, keep it in the list marked \`skip: <reason>\`.
+3. For work longer than about ten steps, copy that playbook's steps into the todo list before doing any work. If you skip a step, keep it in the list marked \`skip: <reason>\`.
 4. Do the work. Read a principal when its trigger fires (see below). Do not read them all up front.`,
    effect: { tokens: { 'depth-chart': 0.93, 'funding-sign': 0.88, 'candle-gap': 0.9, 'split-api': 0.92 }, met: { 'depth-chart': { tests: -0.15 }, 'split-api': { dead: -0.1 } } },
  },
  checkOnce: {
    title: 'Check once at the end instead of after every unit',
    description:
      'Step 3 asks for a check after every small unit, which in these runs meant a build and test run after each file. That doubled the number of calls on the feature task without catching more problems. This change keeps the per-unit check only for logic that has its own tests.',
    file: `${SKILLS}/playbooks/feature.md`,
    diff: `@@ -4,2 +4,3 @@
-3. **Break it into small units**, each ending in something you can check. Do them in order and check each before the next.
+3. **Break it into small units**, each ending in something you can check. Run a unit's tests as soon as it has them;
+   otherwise build once after the last unit.`,
    effect: { tokens: { 'depth-chart': 0.85 }, met: { 'depth-chart': { tooltip: -0.2, tests: -0.1 } } },
  },
};

function suggestion(sessionSeed: string, key: string, status: SuggestionStatus, createdMinAgo: number, opts: { perTask?: number; runningFrom?: number } = {}): Suggestion {
  const spec = SPECS[key];
  const tested = status !== 'proposed';
  return {
    id: `${sessionSeed}-${key}`,
    title: spec.title,
    description: spec.description,
    file: spec.file,
    diff: spec.diff,
    status,
    createdAt: ago(createdMinAgo),
    runs: tested ? runSet(`${sessionSeed}/${key}`, sessionSeed, opts.perTask ?? 3, createdMinAgo - 5, spec.effect, opts.runningFrom) : [],
  };
}

export const SESSIONS: Session[] = [
  {
    id: 'sess-0003',
    createdAt: ago(42),
    status: 'running',
    skillsVersion: 'saiyan @ f14513a + 1 accepted',
    runs: runSet('s3', 's3', 3, 40),
    suggestions: [
      suggestion('s3', 'targetedRead', 'testing', 14, { runningFrom: 8 }),
      suggestion('s3', 'noTodoCopy', 'proposed', 14),
      suggestion('s3', 'checkOnce', 'proposed', 14),
    ],
  },
  {
    id: 'sess-0002',
    createdAt: ago(60 * 26),
    status: 'done',
    skillsVersion: 'saiyan @ f14513a',
    runs: runSet('s2', 's2', 3, 60 * 26 - 2),
    suggestions: [
      suggestion('s2', 'scriptedVisual', 'accepted', 60 * 25),
      suggestion('s2', 'reproFirst', 'tested', 60 * 25),
      suggestion('s2', 'lineLimit', 'tested', 60 * 25),
    ],
  },
  {
    id: 'sess-0001',
    createdAt: ago(60 * 24 * 3),
    status: 'done',
    skillsVersion: 'saiyan @ f14513a',
    runs: runSet('s1', 's1', 2, 60 * 24 * 3 - 2),
    suggestions: [
      suggestion('s1', 'checkOnce', 'rejected', 60 * 24 * 3 - 30, { perTask: 2 }),
      suggestion('s1', 'noTodoCopy', 'rejected', 60 * 24 * 3 - 30, { perTask: 2 }),
    ],
  },
];
