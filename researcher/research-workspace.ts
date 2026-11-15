/**
 * Research workspace: the ONLY data the agentic research agent ever sees.
 *
 * Before each proposal a fresh host temp dir is built and copied into the research container at
 * /research. It contains:
 *
 *   README.md              task, modification surface, constraints, scoring, how to read the files
 *   digest.md              the history digest (researcher/history.ts)
 *   best-config/           files of the current best config (or the baseline)
 *   experiments/<id>/      recent experiments: config/ files, meta.json (hypothesis, changes, evidence), outcome.json
 *   runs/<runId>/          selected DEV coding runs: profile.md, profile.json, claude-stream.jsonl,
 *                          usage.jsonl, trace.jsonl, run.json, eval-summary.json
 *   spec/                  the public benchmark spec (benchmark/spec/), what the coding agent is asked to build
 *   scratch/               (created in the container) the agent's only writable place
 *
 * Information-flow rules (TASK §7, §11), enforced here and re-checked by scanWorkspace():
 *  - Nothing from evaluator/ (source, reference app, holdout fixtures, scenarios), no holdout runs or
 *    evaluations (holdout = one pass/fail bit per experiment in outcome.json / digest), no eval
 *    screenshots, no browser-agent transcripts, no eval report files, no DB, no .env.
 *  - Browser-check messages are dropped (only their ids and outcomes are shown); they may paraphrase
 *    hidden scenario goals.
 *  - A final scan rejects (removes) any file that contains a forbidden marker (holdout fixture titles,
 *    evaluator source markers); the builder fails closed if a forbidden PATH is ever produced.
 *  - Multi-task: only experiments and runs of the dev task (`taskId`) are included, spec/ is the dev
 *    task's public spec, and every hidden task (a holdout task other than the dev task) adds its id,
 *    title and paths as forbidden markers. Brownfield dev tasks additionally get a read-only copy of the
 *    checkpoint source at /research/codebase, made inside the research container from the task image
 *    (see research-agent-claude-code.ts); it never passes through this host directory.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Db, ExperimentRow, RunRow } from '../storage/db.js';
import { logger } from '../runner/logger.js';
import { readConfigFiles as defaultReadConfigFiles } from './optimizer.js';
import { splitResearchText } from './history.js';
import { claudeCodeSurfaceDoc, type WhitelistOptions } from './whitelist.js';

const log = logger('research-workspace');

/** Files copied from a run directory (everything else, notably eval/ and app/, is never copied). */
export const RUN_FILES = ['claude-stream.jsonl', 'usage.jsonl', 'trace.jsonl', 'run.json'] as const;

export interface WorkspaceLimits {
  /** Recent experiments to include under experiments/ (default 10). */
  maxExperiments: number;
  /** Max run directories under runs/ (default 12). */
  maxRuns: number;
  /** Total byte budget for runs/ (default 40 MB). Runs that would exceed it are skipped. */
  maxRunBytes: number;
  /** A single copied file larger than this is truncated (head kept, marker appended). Default 8 MB. */
  maxFileBytes: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxExperiments: 10,
  maxRuns: 12,
  maxRunBytes: 40 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
};

/** Profile hooks (researcher/session-profile.ts, owned by profiler). Injected or loaded lazily. */
export interface ProfileFns {
  buildSessionProfile(runDir: string): unknown;
  renderProfileMarkdown(p: unknown, opts?: { maxChars?: number }): string;
}

export interface BuildWorkspaceOptions {
  db: Db;
  /** Results root; run dirs are <resultsDir>/runs/<runId>. */
  resultsDir: string;
  configsRoot: string;
  /** Public spec dir (default benchmark/spec). */
  specDir?: string;
  bestConfigId: string;
  bestConfigFiles: Record<string, string>;
  history: string;
  whitelist: WhitelistOptions;
  experimentIndex: number;
  singleVariableExperiments: number;
  verificationRuns?: number;
  /** Budgets of the research agent (shown in README). */
  agentLimits?: { maxRuntimeSec?: number; maxTotalTokens?: number };
  limits?: Partial<WorkspaceLimits>;
  /** Output dir (must not exist or be empty). Default: a fresh mkdtemp dir. */
  outDir?: string;
  /** Profile functions; default: researcher/session-profile.ts. null = no profiles. */
  profile?: ProfileFns | null;
  readConfigFiles?: (configId: string, configsRoot?: string) => Record<string, string>;
  /** Extra forbidden markers for the final scan (tests). */
  extraForbidden?: string[];
  /** Repo root used to locate evaluator/holdout/fixtures.json for the forbidden-marker scan. */
  repoRoot?: string;
  /** Dev task (default 'todo'): only its experiments/runs are included; its spec is spec/. */
  taskId?: string;
  /** Tasks the research agent must never learn about (e.g. a holdout task); their id/title/paths are forbidden markers. */
  hiddenTaskIds?: string[];
  /** Task lookup (tests); default runner/tasks.ts getTask. */
  getTask?: (id: string) => { id: string; title: string; kind: string; specPath: string };
}

export interface ResearchWorkspace {
  dir: string;
  experiments: string[];
  runs: string[];
  /** Notes about what was skipped or truncated (also listed in README.md). */
  notes: string[];
  bytes: number;
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// forbidden content
// ---------------------------------------------------------------------------

/** Path patterns that must never appear in a workspace (relative posix paths). */
export const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /(^|\/)eval(\/|$)/i,
  /(^|\/)evaluator(\/|$)/i,
  /holdout/i,
  /screenshots?(\/|$)/i,
  /browser-agent/i,
  /browser-trace/i,
  /(^|\/)report\.json$/i,
  /(^|\/)app\.log$/i,
  /\.db(-wal|-shm)?$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)reference-app(\/|$)/i,
  /(^|\/)app\//, // generated app snapshots are never copied (the transcript is enough)
];

/** Fixed markers of evaluator source / hidden material. */
export const EVALUATOR_SOURCE_MARKERS = [
  'HIDDEN holdout fixture',
  'Hidden deterministic Playwright UI scenarios',
  'evaluator/reference-app',
  'evaluator/holdout',
  'evaluator/scenarios',
  "from '../checks.js'",
  'holdout-errands',
  'holdout-unicode',
  'holdout-long',
  'holdout-empty',
  'holdout-many',
];

/** Markers derived from the hidden holdout fixtures (titles >= 10 chars, set names). */
export function holdoutMarkers(repoRoot = process.cwd()): string[] {
  const p = join(repoRoot, 'evaluator', 'holdout', 'fixtures.json');
  if (!existsSync(p)) return [];
  try {
    const h = JSON.parse(readFileSync(p, 'utf8')) as { sets?: Record<string, { todos?: { title?: string }[] }> };
    const out = new Set<string>();
    for (const [name, set] of Object.entries(h.sets ?? {})) {
      out.add(name);
      for (const t of set.todos ?? []) {
        const title = (t.title ?? '').trim();
        // Short or repetitive titles ("a", "xxxx…") would give false positives; distinctive ones only.
        if (title.length >= 10 && new Set(title.toLowerCase()).size >= 5) out.add(title);
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/** Forbidden markers of hidden tasks: id, title and their benchmark/evaluator paths. */
export function hiddenTaskMarkers(tasks: { id: string; title?: string }[]): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    out.push(t.id, `benchmark/tasks/${t.id}`, `evaluator/tasks/${t.id}`);
    if (t.title && t.title.trim().length >= 8) out.push(t.title.trim());
  }
  return out;
}

export function forbiddenMarkers(repoRoot = process.cwd(), extra: string[] = []): string[] {
  return [...new Set([...EVALUATOR_SOURCE_MARKERS, ...holdoutMarkers(repoRoot), ...extra])].filter((m) => m.length > 0);
}

export interface ScanResult {
  forbiddenPaths: string[];
  forbiddenContent: { path: string; marker: string }[];
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** Scan a workspace for forbidden paths and forbidden content (binary spec images are skipped for content). */
export function scanWorkspace(dir: string, markers: string[]): ScanResult {
  const res: ScanResult = { forbiddenPaths: [], forbiddenContent: [] };
  for (const rel of walk(dir)) {
    if (FORBIDDEN_PATH_PATTERNS.some((re) => re.test(rel))) res.forbiddenPaths.push(rel);
    if (/\.(png|jpe?g|gif|webp)$/i.test(rel)) {
      if (!rel.startsWith('spec/')) res.forbiddenPaths.push(rel); // only the public design images
      continue;
    }
    const text = readFileSync(join(dir, rel), 'utf8');
    for (const m of markers) {
      if (text.includes(m)) {
        res.forbiddenContent.push({ path: rel, marker: m });
        break;
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

async function loadProfileFns(): Promise<ProfileFns | null> {
  try {
    const m = await import('./session-profile.js');
    return { buildSessionProfile: (d) => m.buildSessionProfile(d), renderProfileMarkdown: (p, o) => m.renderProfileMarkdown(p as never, o) };
  } catch {
    return null;
  }
}

function writeText(root: string, rel: string, content: string): number {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return Buffer.byteLength(content);
}

function copyCapped(src: string, dst: string, maxBytes: number): { bytes: number; truncated: boolean } {
  mkdirSync(dirname(dst), { recursive: true });
  const size = statSync(src).size;
  if (size <= maxBytes) {
    copyFileSync(src, dst);
    return { bytes: size, truncated: false };
  }
  const buf = readFileSync(src).subarray(0, maxBytes);
  // Cut at the last newline so jsonl stays line-parseable.
  const nl = buf.lastIndexOf(0x0a);
  const head = nl > 0 ? buf.subarray(0, nl + 1) : buf;
  writeFileSync(dst, Buffer.concat([head, Buffer.from(`{"type":"frugal_truncated","omittedBytes":${size - head.length}}\n`)]));
  return { bytes: head.length, truncated: true };
}

const short = (s: string | null | undefined, max: number) => {
  if (!s) return s ?? null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** DEV-only evaluation summary of a run (holdout evaluations are never read). */
export function evalSummary(db: Db, run: RunRow): Record<string, unknown> | null {
  const evs = db.listEvaluations(run.runId).filter((e) => e.suite === 'dev');
  if (!evs.length) return null;
  const ev = evs[evs.length - 1];
  const checks: Record<string, { outcome: string; mandatory?: boolean; category: string; message?: string }> = {};
  for (const c of ev.checks) {
    const entry: { outcome: string; mandatory?: boolean; category: string; message?: string } = { outcome: c.outcome, category: c.category };
    if ((c as { mandatory?: boolean }).mandatory !== undefined) entry.mandatory = (c as { mandatory?: boolean }).mandatory;
    if (c.outcome !== 'pass' && c.category !== 'browser' && c.message) entry.message = short(c.message, 160) ?? undefined;
    checks[c.id] = entry;
  }
  return {
    runId: run.runId,
    suite: 'dev',
    passed: ev.passed,
    appStarted: ev.appStarted,
    evaluatorFailure: ev.evaluatorFailure,
    browserAgentSkipped: ev.browserAgentSkipped,
    visualScore: ev.visualScore,
    visualThreshold: ev.visualThreshold,
    failedChecks: ev.checks.filter((c) => c.outcome !== 'pass').map((c) => c.id),
    checks,
  };
}

function cheatingOf(db: Db, configId: string): { reason: string; inheritedFrom: string | null } | null {
  const c = db.cheatingStatus(configId);
  return c ? { reason: c.reason, inheritedFrom: c.inherited ? c.flaggedConfigId : null } : null;
}

function outcomeOf(e: ExperimentRow, db: Db): Record<string, unknown> {
  const s = e.summary;
  const quick = db.listRuns({ experimentId: e.id, phase: 'quick' }).filter((r) => r.suite === 'dev' && r.status !== 'running' && r.taskId === e.taskId);
  return {
    id: e.id,
    kind: e.kind,
    status: e.status,
    outcome: e.outcome,
    parentConfigId: e.parentConfigId,
    candidateConfigId: e.candidateConfigId,
    isMock: e.isMock,
    quick: quick.length ? { passed: quick[0].passed, totalTokens: quick[0].totalTokens, runId: quick[0].runId } : null,
    verification: s
      ? {
          runs: s.runs,
          passes: s.passes,
          medianTokens: s.medianTokens,
          medianVisualScore: s.medianVisualScore,
          meetsQualityRequirements: s.meetsQualityRequirements,
        }
      : null,
    // Holdout: ONE bit, never details.
    holdoutPassed: e.holdoutPassed,
    // Human verdict: this technique is cheating (not a real token saving). Never reuse it.
    cheating: e.candidateConfigId ? cheatingOf(db, e.candidateConfigId) : null,
    notes: short(e.notes, 400),
    error: short(e.error, 400),
  };
}

/** Pick runs: all dev runs of the best config, the latest dev run of each recent experiment, failed runs. */
export function selectRuns(db: Db, bestConfigId: string, experiments: ExperimentRow[], maxRuns: number, taskId = 'todo'): RunRow[] {
  const dev = db
    .listRuns({ taskId })
    .filter((r) => r.suite === 'dev' && r.phase !== 'holdout' && r.status !== 'running' && r.taskId === taskId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // newest first
  const picked = new Map<string, RunRow>();
  const add = (r: RunRow | undefined) => {
    if (r && !picked.has(r.runId) && picked.size < maxRuns) picked.set(r.runId, r);
  };
  for (const r of dev.filter((r) => r.configId === bestConfigId)) add(r);
  for (const e of [...experiments].reverse()) add(dev.find((r) => r.experimentId === e.id));
  for (const r of dev.filter((r) => r.passed === false)) add(r);
  return [...picked.values()];
}

/** README sections that differ for a brownfield dev task (todo keeps its original text). */
function brownfieldText(task: { id: string; title: string }) {
  return {
    intro: `You are the research agent of a token-efficiency benchmark. A coding agent (the real Claude Code CLI,
headless \`claude -p\`, inside an isolated container) implements a feature in an EXISTING codebase
(task \`${task.id}\`: ${task.title}), following the public task prompt and feature spec in \`spec/\`. A hidden
evaluator then checks the result. Your job: study what the coding sessions ACTUALLY did and propose ONE
configuration change that lowers the coding agent's token use while keeping the checks passing.`,
    scoring: `- A run passes only if ALL mandatory checks pass: the patch applies, the project builds, the existing
  tests still pass, the app boots, the UI checks written from the public spec pass, and the result is visually
  close enough to the hidden reference implementation (a screenshot comparison).`,
    codebase: `- \`/research/codebase/\` (read-only, in this container only): the checkpoint source the coding agent starts
  from (no .git, dependencies or build output). Use it to build codebase maps and guides for \`docs/\` (feature
  areas, where modules, components, hooks, styles and tests live, how to build and test). Guides must describe
  the EXISTING code and how to work in it; they must not contain the feature's implementation.
- \`/workspace\` in this container: a disposable copy of that checkout (dependencies installed, services not
  necessarily running) for smoke-testing helper scripts.`,
  };
}

function readmeText(o: BuildWorkspaceOptions, ws: { experiments: string[]; runs: { id: string; label: string }[]; notes: string[] }, task?: { id: string; title: string; kind: string } | null): string {
  const single = o.experimentIndex <= o.singleVariableExperiments;
  const lim = o.agentLimits ?? {};
  const cc = o.whitelist.backend === 'claude-code';
  const bf = task && task.kind === 'brownfield' ? brownfieldText(task) : null;
  return `# Research task

${
  bf
    ? bf.intro
    : `You are the research agent of a token-efficiency benchmark. A coding agent (the real Claude Code CLI,
headless \`claude -p\`, inside an isolated container) builds a full-stack todo app (React/Vite + Express +
better-sqlite3) from a starter repo, following the public spec in \`spec/\`. A hidden evaluator then checks
the result. Your job: study what the coding sessions ACTUALLY did and propose ONE configuration change that
lowers the coding agent's token use while keeping every mandatory check passing.`
}

This is candidate experiment #${o.experimentIndex}. The proposal is applied on top of \`best-config/\` (${o.bestConfigId}).
${single ? '**Single-variable rule:** change exactly ONE major variable (one prompt/workflow idea, one skill, one script, one hook, one config field). At most 2 files and at most 1 config.json field.' : 'You may combine several changes if the evidence supports them; keep the proposal coherent and explainable.'}

## How scoring works

- Each candidate gets 1 quick run; if it passes, ${o.verificationRuns ?? 5} verification runs.
${
  bf
    ? bf.scoring
    : `- A run passes only if ALL mandatory checks pass: build + start, API contract tests, browser scenarios,
  persistence, and visual similarity to the reference design >= 95 (out of 100).`
}
- Promotion: every verification run passes AND the MEDIAN coding tokens over the verification runs is
  lower than the current best's median. Coding tokens = input + output + cache read + cache write of
  EVERY model call the coding agent makes (main turns, subagents, background calls, compaction).
- Run-to-run noise is about 30% (the same config produced 124k and 162k). Do not overinterpret one run;
  prefer changes whose mechanism removes tokens on every call or removes whole calls.
- A config that saves tokens but fails a check is worthless.
- A human reviews results. Configs that save tokens by gaming the benchmark (shipping app code, copying
  a past solution, weakening what is built or checked, exploiting the evaluator) are FLAGGED AS CHEATING:
  they are rejected, dropped from best, and so is every config derived from them. Flagged experiments
  are marked in \`digest.md\` and \`outcome.json\` (\`cheating\`); never reuse their technique.

## Files

- \`digest.md\`: compact history of all experiments (outcomes, medians, failing DEV check ids).
- \`best-config/\`: the config you modify (config.json, system-prompt.md, CLAUDE.md, skills/, ...).
- \`experiments/<id>/\`: recent experiments: \`config/\` (their full config), \`meta.json\` (hypothesis, change,
  diff, evidence, expected savings), \`outcome.json\` (quick/verification results, holdout pass bit only).
  Do NOT repeat a failed idea unless you change it materially.
- \`runs/<runId>/\`: coding sessions (DEV suite):
  - \`profile.md\` START HERE: per-call token breakdown, fixed overhead, costliest tool outputs, waste signals.
  - \`profile.json\`: the same data, machine-readable.
  - \`claude-stream.jsonl\`: the raw Claude Code stream-json transcript (system init with tool list,
    assistant messages with tool_use, user messages with tool_result, final result with usage).
  - \`usage.jsonl\`: one line per model call as recorded by the token gateway (authoritative tokens;
    cacheReadTokens dominate: the whole prefix is re-read on every call).
  - \`trace.jsonl\`: normalized trace (model_call / tool_call entries with turn numbers, returnedChars).
  - \`run.json\`: totals, status, limits. \`eval-summary.json\`: pass/fail per DEV check id, short messages
    for non-browser checks, visual score.
${ws.runs.map((r) => `  - \`runs/${r.id}\`: ${r.label}`).join('\n') || '  - (no runs available yet)'}
${
  bf
    ? `- \`spec/\`: the public task prompt (prompt.md) and feature spec the coding agent receives.
${bf.codebase}`
    : `- \`spec/\`: the public spec the coding agent receives (requirements.md, api-contract.yaml, design-tokens.md,
  fixtures.json, design.png, design-mobile.png).`
}
- \`scratch/\`: your ONLY writable directory (notes, analysis scripts, test copies of helper scripts).

Useful one-liners (node and jq-free shell are available; write small node scripts in scratch/):
\`\`\`
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\\n")) if (l) { const r = JSON.parse(l); console.log(r.purpose, r.totalTokens, r.cacheReadTokens, r.outputTokens) }' runs/<id>/usage.jsonl
grep -c '"type":"tool_use"' runs/<id>/claude-stream.jsonl
\`\`\`

## What you may change (the modification surface)

- \`system-prompt.md\`: appended to Claude Code's built-in prompt (claudeCode.systemPromptMode "append") or the
  WHOLE system prompt ("replace").${cc ? '' : ' (api backend: the agent system prompt)'}
- \`CLAUDE.md\`: user memory, loaded into every conversation when config.json claudeCode.claudeMd is true.
- \`skills/<name>.md\`: Claude Code skills (only the description is in context until invoked; needs the Skill tool).
${cc ? claudeCodeSurfaceDoc() + '\n' : ''}- \`config.json\` (PARTIAL object of approved fields): claudeCode {systemPromptMode, tools, disallowedTools,
  settings (incl. settings.hooks, e.g. PostToolUse hooks that trim tool output), env, claudeMd}, effort,
  maxOutputTokensPerCall, thinkingBudget, designDelivery, inlineSpecFiles. claudeCode replaces the parent's
  block as a whole, so always send the complete block.

## Hard constraints

- NEVER embed application code (React components, Express routes, SQL schema, CSS for the app, package.json
  contents of the app, ...) in any file. An automatic guard rejects proposals containing app code; it is
  also against the benchmark rules. Scripts must be generic tooling (build, test, summarize output), and
  instructions must describe HOW to work, not WHAT code to write.
- Never touch the benchmark spec, the starter, thresholds, scoring, token accounting, limits, backend,
  provider or model.
- You cannot see the hidden evaluator or its holdout suite, and must not try to infer or game them.
- Do NOT run Claude Code (\`claude\`) yourself. You may smoke-test a helper script against the starter, which
  is at /workspace in this container (a disposable copy with node_modules installed). /research/scratch and
  /tmp are mounted noexec here, so run a draft through its interpreter, e.g.
  \`cd /workspace && bash /research/scratch/check\` (in the coding container bin scripts are on PATH and are
  called by NAME, e.g. \`check\`, never as \`node /opt/frugal/bin/check\`).
- Budget for this proposal: ${lim.maxRuntimeSec ? `${lim.maxRuntimeSec}s wall clock` : 'limited time'}, ${lim.maxTotalTokens ? `${lim.maxTotalTokens.toLocaleString('en-US')} research tokens` : 'limited tokens'}.
  Be efficient: read profile.md files first, grep the transcripts, don't cat whole jsonl files.

## Research strategy

1. Start from evidence: read \`runs/*/profile.md\` for the best config's runs, find the biggest token sinks
   (fixed overhead x number of calls, large tool outputs, re-reads, long thinking, repeated builds).
2. Form ONE hypothesis early and cite the evidence (run id, turn / call index, tool call) that motivates it.
3. Levers to consider:
   - Claude Code's fixed overhead: ~16-22k tokens of system prompt + tool definitions, re-read from cache on
     EVERY call. \`systemPromptMode: "replace"\` (then the prompt must say how to work), fewer tools
     (claudeCode.tools), disabling unused built-ins.
   - Fewer, larger turns (write whole files at once, batch commands): every extra call re-reads the prefix.
   - Helper scripts that compress feedback loops (build + smoke test printing only errors).
   - Hooks that trim noisy tool output (e.g. npm/vite logs).
   - effort and thinking budget.
   - Placement: skills vs CLAUDE.md vs system prompt (always-paid vs on-demand).
   - Subagents (usually more expensive; justify with evidence).
   - Avoiding re-reads of files and of the spec; inline vs on-disk spec delivery (inlineSpecFiles, designDelivery).
   Patterns seen when profiling the first baseline runs (hypotheses to VERIFY against the current
   profiles, not facts about the current best):
   - Fixed overhead ~19.8k tokens/call (~61-64% of the total); 21 of 23 loaded tools unused, 18 skills listed.
   - Cache reads 76-81% of tokens, output only 4-6%: the NUMBER OF TURNS drives cost (each extra turn >= 34k).
   - A final summary-only turn cost 23-28% of a run.
   - One failed \`cat\` glob cost a whole 28.5k-token turn (errors cost full turns).
   - The inline spec (~6.3k tokens) is re-read on every call (~19%); one run never viewed design.png and
     still scored visual 100.
4. Check \`experiments/\` so you do not repeat a failed idea.
5. Return the proposal via the structured output: hypothesis, changeSummary, evidence (specific runs,
   turns, tool calls and numbers), expectedSavings (estimate with reasoning, e.g. "-15k tokens/call x 8
   calls = ~120k, minus ..."), files.
${ws.notes.length ? `\n## Workspace notes\n\n${ws.notes.map((n) => `- ${n}`).join('\n')}\n` : ''}`;
}

/** Build the research workspace (see module doc). Fails closed on forbidden paths. */
export async function buildResearchWorkspace(o: BuildWorkspaceOptions): Promise<ResearchWorkspace> {
  const limits: WorkspaceLimits = { ...DEFAULT_WORKSPACE_LIMITS, ...(o.limits ?? {}) };
  const readConfigFiles = o.readConfigFiles ?? defaultReadConfigFiles;
  const dir = o.outDir ?? mkdtempSync(join(tmpdir(), 'frugal-research-ws-'));
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) throw new Error(`research workspace dir is not empty: ${dir}`);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const notes: string[] = [];
  let bytes = 0;
  const taskId = o.taskId ?? 'todo';
  const lookup = o.getTask ?? (taskId === 'todo' && !o.hiddenTaskIds?.length ? null : (await import('../runner/tasks.js')).getTask);
  const task = taskId === 'todo' && !o.getTask ? null : lookup!(taskId);
  const hidden = (o.hiddenTaskIds ?? []).filter((id) => id !== taskId).map((id) => {
    try {
      return lookup!(id);
    } catch {
      return { id, title: '' };
    }
  });

  try {
    bytes += writeText(dir, 'digest.md', `# Experiment history digest\n\n${o.history.trim()}\n`);

    for (const [rel, content] of Object.entries(o.bestConfigFiles)) bytes += writeText(dir, join('best-config', rel), content);

    // experiments/
    const all = o.db.listExperiments({ taskId }).filter((e) => e.status !== 'pending' && e.taskId === taskId);
    const recent = all.slice(-limits.maxExperiments);
    const expIds: string[] = [];
    for (const e of recent) {
      const base = join('experiments', e.id);
      if (e.candidateConfigId) {
        try {
          for (const [rel, content] of Object.entries(readConfigFiles(e.candidateConfigId, o.configsRoot))) bytes += writeText(dir, join(base, 'config', rel), content);
        } catch {
          notes.push(`experiments/${e.id}: config ${e.candidateConfigId} not readable`);
        }
      }
      const split = splitResearchText(e.hypothesis);
      let metaFile: Record<string, unknown> = {};
      if (e.candidateConfigId) {
        const mp = join(o.configsRoot, e.candidateConfigId, 'meta.json');
        if (existsSync(mp)) {
          try {
            metaFile = JSON.parse(readFileSync(mp, 'utf8'));
          } catch {
            /* ignore */
          }
        }
      }
      const meta = {
        experimentId: e.id,
        kind: e.kind,
        configId: e.candidateConfigId,
        parentConfigId: e.parentConfigId,
        hypothesis: (metaFile.hypothesis as string | undefined) ?? split.hypothesis,
        changeSummary: e.changeSummary,
        evidence: (metaFile.evidence as string | undefined) ?? split.evidence ?? null,
        expectedSavings: (metaFile.expectedSavings as string | undefined) ?? split.expectedSavings ?? null,
        changes: e.changes || (metaFile.changes as string | undefined) || '',
        createdAt: e.createdAt,
      };
      bytes += writeText(dir, join(base, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
      bytes += writeText(dir, join(base, 'outcome.json'), JSON.stringify(outcomeOf(e, o.db), null, 2) + '\n');
      expIds.push(e.id);
    }

    // runs/
    const profile = o.profile === undefined ? await loadProfileFns() : o.profile;
    if (!profile) notes.push('session profiles cannot be built here: runs without a profile.md need usage.jsonl / claude-stream.jsonl analysed directly');
    const runIds: string[] = [];
    const runLabels: { id: string; label: string }[] = [];
    let runBytes = 0;
    for (const run of selectRuns(o.db, o.bestConfigId, recent, limits.maxRuns, taskId)) {
      if (run.suite !== 'dev' || run.phase === 'holdout' || run.taskId !== taskId) continue; // defense in depth
      const src = join(o.resultsDir, 'runs', run.runId);
      if (!existsSync(src)) {
        notes.push(`run ${run.runId}: run directory missing`);
        continue;
      }
      const need = RUN_FILES.reduce((n, f) => n + (existsSync(join(src, f)) ? Math.min(statSync(join(src, f)).size, limits.maxFileBytes) : 0), 0);
      if (runBytes + need > limits.maxRunBytes) {
        notes.push(`run ${run.runId}: skipped (workspace run budget of ${Math.round(limits.maxRunBytes / 1e6)} MB reached)`);
        continue;
      }
      const base = join('runs', run.runId);
      for (const f of RUN_FILES) {
        const p = join(src, f);
        if (!existsSync(p)) continue;
        const c = copyCapped(p, join(dir, base, f), limits.maxFileBytes);
        runBytes += c.bytes;
        if (c.truncated) notes.push(`runs/${run.runId}/${f}: truncated to ${Math.round(limits.maxFileBytes / 1e6)} MB`);
      }
      const ev = evalSummary(o.db, run);
      if (ev) runBytes += writeText(dir, join(base, 'eval-summary.json'), JSON.stringify(ev, null, 2) + '\n');
      // Prefer the profile the runner already wrote (runner/run.ts → writeSessionProfile); build only if missing.
      if (existsSync(join(src, 'profile.json')) && existsSync(join(src, 'profile.md'))) {
        for (const f of ['profile.json', 'profile.md']) runBytes += copyCapped(join(src, f), join(dir, base, f), limits.maxFileBytes).bytes;
      } else if (profile) {
        try {
          const prof = profile.buildSessionProfile(src);
          runBytes += writeText(dir, join(base, 'profile.json'), JSON.stringify(prof, null, 2) + '\n');
          runBytes += writeText(dir, join(base, 'profile.md'), profile.renderProfileMarkdown(prof, { maxChars: 20_000 }));
        } catch (e) {
          notes.push(`runs/${run.runId}: profile failed (${short(String(e), 160)})`);
        }
      }
      runIds.push(run.runId);
      const tags = [
        run.configId === o.bestConfigId ? 'best config' : `config ${run.configId}`,
        run.experimentId ?? '',
        run.phase,
        run.passed ? 'PASSED' : run.passed === false ? 'FAILED' : run.status,
        `${run.totalTokens.toLocaleString('en-US')} tokens`,
        `${run.modelCalls} calls`,
      ].filter(Boolean);
      runLabels.push({ id: run.runId, label: tags.join(', ') });
    }
    bytes += runBytes;

    // spec/
    const specDir = o.specDir ?? (task && taskId !== 'todo' ? task.specPath : resolve('benchmark', 'spec'));
    if (existsSync(specDir)) {
      for (const name of readdirSync(specDir).sort()) {
        const p = join(specDir, name);
        if (!statSync(p).isFile()) continue;
        copyFileSync(p, join(mkdirSyncP(join(dir, 'spec')), name));
        bytes += statSync(p).size;
      }
    } else notes.push('spec/ not available');
    // Brownfield: the task prompt is public too (prompt.md next to the spec files).
    const promptPath = task && taskId !== 'todo' ? join((task as { dir?: string }).dir ?? '', 'prompt.md') : null;
    if (promptPath && existsSync(promptPath) && !existsSync(join(dir, 'spec', 'prompt.md'))) {
      copyFileSync(promptPath, join(mkdirSyncP(join(dir, 'spec')), 'prompt.md'));
      bytes += statSync(promptPath).size;
    }

    // Final scan: forbidden paths fail closed; forbidden content removes the offending file.
    const markers = forbiddenMarkers(o.repoRoot, [...(o.extraForbidden ?? []), ...hiddenTaskMarkers(hidden), ...(taskId !== 'todo' ? ['evaluator/tasks/'] : [])]);
    const scan = scanWorkspace(dir, markers);
    if (scan.forbiddenPaths.length) throw new Error(`research workspace contains forbidden paths: ${scan.forbiddenPaths.join(', ')}`);
    for (const f of scan.forbiddenContent) {
      log.warn('removing workspace file with forbidden content', { path: f.path });
      rmSync(join(dir, f.path), { force: true });
      notes.push(`${f.path}: removed (contained hidden-evaluator material)`);
    }

    bytes += writeText(dir, 'README.md', readmeText(o, { experiments: expIds, runs: runLabels, notes }, task && taskId !== 'todo' ? task : null));
    // README itself is generated from trusted text, but re-scan it too.
    const again = scanWorkspace(dir, markers);
    if (again.forbiddenPaths.length || again.forbiddenContent.length)
      throw new Error(`research workspace failed the forbidden-content scan: ${[...again.forbiddenPaths, ...again.forbiddenContent.map((c) => c.path)].join(', ')}`);
    return { dir, experiments: expIds, runs: runIds, notes, bytes, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function mkdirSyncP(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}
