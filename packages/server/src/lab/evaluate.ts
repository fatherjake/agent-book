/**
 * Evaluation: replay the brief with and without a suggestion and compare.
 *
 * A replay is a fresh workspace made from the session (workspace.ts: a git worktree at the commit it
 * started from, a copy of its folder, or an empty folder). For a candidate run the suggestion's edits are
 * applied and committed first, so the diff judged afterwards is only the agent's own work. Then the brief runs headless (`claude -p`, the session's main
 * model, auto permission mode, `git push` blocked, a budget cap). Cost, tokens, time, turns and tool calls
 * come from the run itself; a judge (Sonnet, no tools) then marks each of the brief's checks met or not
 * from the diff and the final message. The worktree is removed afterwards; the diff is kept.
 *
 * Baseline runs (no suggestion) are shared by every suggestion: asking for N runs of a suggestion queues
 * whatever is missing to have N baseline and N candidate runs on the current brief. Replays go through
 * one queue, two at a time.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markBusy, markIdle } from '../activity.js';
import { applyEdits, commitAll, diffSince } from './git.js';
import { runHeadless, type HeadlessRun } from './headless.js';
import { loadLab, updateLab, type LabState, type Run } from './state.js';
import { isEmpty, makeWorkspace, type Workspace } from './workspace.js';

export const JUDGE_MODEL = process.env.AGENT_BOOK_JUDGE_MODEL ?? 'claude-sonnet-5-5';
const CONCURRENCY = Number(process.env.AGENT_BOOK_LAB_CONCURRENCY ?? 2);
const REPLAY_TIMEOUT_MS = 60 * 60_000;

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks', 'summary'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['check', 'met', 'why'],
        properties: { check: { type: 'string' }, met: { type: 'boolean' }, why: { type: 'string', description: 'One sentence.' } },
      },
    },
    summary: { type: 'string', description: 'One or two sentences on how well the task was done.' },
  },
} as const;

interface Job {
  sessionId: string;
  /** null for a baseline run. */
  suggestionId: string | null;
  runId: string;
}

const queue: Job[] = [];
/** Running replays and judges by run id, so they can be stopped. */
const live = new Map<string, HeadlessRun>();
let active = 0;
const stopped = new Set<string>();

const runsOf = (s: LabState, suggestionId: string | null): Run[] => (suggestionId ? (s.suggestions.find((x) => x.id === suggestionId)?.runs ?? []) : s.baseline);

function patchRun(sessionId: string, suggestionId: string | null, runId: string, change: Partial<Run>) {
  updateLab(sessionId, (s) => {
    const r = runsOf(s, suggestionId).find((x) => x.id === runId);
    if (r) Object.assign(r, change);
  });
}

/** Queue runs so the suggestion has `n` candidate and `n` baseline runs on the current brief. */
export function requestRuns(sessionId: string, suggestionId: string, n: number): void {
  const s = loadLab(sessionId);
  if (!s.analysis || s.analysis.status !== 'done' || !s.brief) throw new Error('Analyse the session first.');
  const sug = s.suggestions.find((x) => x.id === suggestionId);
  if (!sug) throw new Error('No such suggestion.');
  const v = s.brief.version;
  const counted = (runs: Run[]) => runs.filter((r) => r.briefVersion === v && r.status !== 'failed').length;
  const add = (suggestion: string | null, arm: Run['arm'], count: number) => {
    for (let i = 0; i < count; i++) {
      const run: Run = { id: randomUUID().slice(0, 8), arm, briefVersion: v, status: 'running', startedAt: new Date().toISOString(), sessionId: randomUUID(), ending: 'queued' };
      updateLab(sessionId, (st) => void runsOf(st, suggestion).push(run));
      queue.push({ sessionId, suggestionId: suggestion, runId: run.id });
      markBusy(`run:${run.id}`);
    }
  };
  add(null, 'baseline', Math.max(0, n - counted(s.baseline)));
  add(suggestionId, 'candidate', Math.max(0, n - counted(sug.runs)));
  pump();
}

/** Stop a suggestion's queued and running runs (and the baseline runs, when nothing else needs them). */
export function stopRuns(sessionId: string, suggestionId: string | null): void {
  const s = loadLab(sessionId);
  const ids = new Set(runsOf(s, suggestionId).filter((r) => r.status === 'running' || r.status === 'judging').map((r) => r.id));
  if (suggestionId && !s.suggestions.some((x) => x.id !== suggestionId && x.runs.some((r) => r.status === 'running'))) for (const r of s.baseline) if (r.status === 'running') ids.add(r.id);
  for (const id of ids) {
    stopped.add(id);
    live.get(id)?.proc.kill('SIGINT');
  }
  for (let i = queue.length - 1; i >= 0; i--)
    if (ids.has(queue[i].runId)) {
      const [job] = queue.splice(i, 1);
      markIdle(`run:${job.runId}`);
      patchRun(job.sessionId, job.suggestionId, job.runId, { status: 'failed', ending: 'stopped', error: 'Stopped before it started.', finishedAt: new Date().toISOString() });
    }
}

/** Runs marked running that no process here is working on (the server restarted): mark them failed. */
export function settleOrphans(sessionId: string): void {
  const s = loadLab(sessionId);
  const known = new Set([...queue.map((j) => j.runId), ...live.keys()]);
  const orphan = (r: Run) => (r.status === 'running' || r.status === 'judging') && !known.has(r.id);
  if (![...s.baseline, ...s.suggestions.flatMap((x) => x.runs)].some(orphan)) return;
  updateLab(sessionId, (st) => {
    for (const r of [...st.baseline, ...st.suggestions.flatMap((x) => x.runs)])
      if (orphan(r)) Object.assign(r, { status: 'failed', ending: 'interrupted', error: 'The server restarted while this run was going.', finishedAt: new Date().toISOString() });
  });
}

export const isBusy = (runId: string) => live.has(runId) || queue.some((j) => j.runId === runId);

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active++;
    void runJob(job).finally(() => {
      active--;
      markIdle(`run:${job.runId}`);
      live.delete(job.runId);
      stopped.delete(job.runId);
      pump();
    });
  }
}

async function runJob(job: Job): Promise<void> {
  const s = loadLab(job.sessionId);
  const run = runsOf(s, job.suggestionId).find((r) => r.id === job.runId);
  const a = s.analysis;
  const brief = s.brief;
  if (!run || !a || !brief) return;
  const sug = job.suggestionId ? s.suggestions.find((x) => x.id === job.suggestionId) : null;
  patchRun(job.sessionId, job.suggestionId, job.runId, { ending: 'running', startedAt: new Date().toISOString() });

  let ws: Workspace | null = null;
  try {
    ws = makeWorkspace(a.source, `run-${run.id}`);
    const tree = ws.dir;
    if (sug) applyEdits(tree, sug.edits);
    const start = commitAll(tree, sug ? `Agent Book suggestion: ${sug.title}` : 'Agent Book baseline');

    const where =
      a.source.kind === 'git'
        ? 'This is a fresh checkout, so install dependencies if you need them.'
        : a.source.kind === 'folder'
          ? 'This is a copy of the project folder without its dependencies or build output, so install what you need.'
          : isEmpty(tree)
            ? 'You start in an empty folder.'
            : 'You start in a folder that holds only the setup files you see.';
    const prompt = `${brief.task}\n\nWork on your own: nobody will answer questions, so make reasonable decisions and finish the task. ${where} Do not push, deploy or publish anything.`;
    const replay = runHeadless(
      tree,
      [
        '--model', a.model,
        '--session-id', run.sessionId,
        '--name', `Agent Book replay ${run.arm}${sug ? ` - ${sug.title}` : ''}`,
        '--permission-mode', 'auto',
        '--disallowedTools', 'Bash(git push:*)',
        '--max-budget-usd', String(brief.budgetUsd),
      ],
      prompt,
      { timeoutMs: REPLAY_TIMEOUT_MS },
    );
    live.set(run.id, replay);
    const r = await replay.done;
    if (stopped.has(run.id)) throw new Error('Stopped.');
    const { stat, diff } = diffSince(tree, start);
    patchRun(job.sessionId, job.suggestionId, job.runId, {
      status: 'judging',
      costUsd: r.costUsd,
      tokens: r.tokens,
      durationMs: r.durationMs,
      turns: r.turns,
      toolCalls: r.toolCalls,
      ending: r.ending,
      result: r.result.slice(0, 8000),
      diffStat: stat,
      diff,
      ...(r.error ? { error: r.error } : {}),
    });

    // The judge: no tools, everything it needs is in the prompt. One retry: it occasionally ends
    // without a result. If it still fails, the run keeps its measurements and is marked unjudged.
    const judgePrompt = [
      'You judge whether a coding agent completed a task. Mark each check met only if the evidence below shows it; when the diff or message does not show it, it is not met.',
      `\n<task>\n${brief.task}\n</task>`,
      `\n<checks>\n${brief.checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n</checks>`,
      `\n<run_ending>${r.ending}</run_ending>`,
      `\n<agent_final_message>\n${r.result.slice(0, 20_000)}\n</agent_final_message>`,
      `\n<diff_stat>\n${stat}\n</diff_stat>`,
      `\n<diff>\n${diff.slice(0, 150_000)}\n</diff>`,
      '\nAnswer with one entry per check, in order.',
    ].join('\n');
    let judged: Run['judge'] | null = null;
    let judgeError = '';
    for (let attempt = 1; attempt <= 2 && !judged && !stopped.has(run.id); attempt++) {
      const judgeSession = randomUUID();
      const empty = mkdtempSync(join(tmpdir(), 'agent-book-judge-'));
      try {
        const judge = runHeadless(
          empty,
          ['--model', JUDGE_MODEL, '--session-id', judgeSession, '--tools', '', '--permission-mode', 'dontAsk', '--json-schema', JSON.stringify(JUDGE_SCHEMA)],
          judgePrompt,
          { timeoutMs: 10 * 60_000 },
        );
        live.set(run.id, judge);
        const j = await judge.done;
        const out: any = j.structured;
        if (out?.checks)
          judged = {
            checks: out.checks.map((c: any) => ({ check: String(c.check ?? ''), met: !!c.met, why: String(c.why ?? '') })),
            summary: String(out.summary ?? ''),
            costUsd: j.costUsd,
            sessionId: judgeSession,
          };
        else judgeError = j.error ?? `the judge ended with ${j.ending}`;
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    }
    if (stopped.has(run.id)) throw new Error('Stopped.');
    patchRun(job.sessionId, job.suggestionId, job.runId, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      ...(judged ? { judge: judged } : { error: `Not judged: ${judgeError}` }),
    });
  } catch (e) {
    patchRun(job.sessionId, job.suggestionId, job.runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      ...(stopped.has(run.id) ? { ending: 'stopped' } : {}),
      error: String((e as Error).message ?? e),
    });
  } finally {
    ws?.remove();
  }
}
