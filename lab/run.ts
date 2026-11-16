/**
 * One lab run: the task in a fresh sandbox with a skills version overlaid, the repo's activation recipe
 * around the task prompt, then the task's hidden evaluator, then grading against the acceptance criteria.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../runner/config.js';
import { resultsDir } from '../runner/env.js';
import { logger } from '../runner/logger.js';
import { runCodingAgent } from '../runner/run.js';
import { getTask as getBenchmarkTask } from '../runner/tasks.js';
import type { LabDb } from './db.js';
import { grade, type LabRepo, type LabTask, type Recipe } from './repos.js';

const log = logger('lab.run');

export const LAB_CONFIG = 'lab';

/** Did the run use the repo's skills? Looks only at the agent's own tool calls (not the prompt). */
export function skillsFired(runDir: string, markers: RegExp): boolean | null {
  const f = join(runDir, 'trace.jsonl');
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"type":"tool_call"')) continue;
    try {
      const e = JSON.parse(line);
      const s = `${e.tool} ${JSON.stringify(e.input ?? {})}`;
      if ((e.tool === 'Skill' || /\.agents\/skills|\.claude\/skills/.test(s)) && markers.test(s)) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

export function newLabRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `lab-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Seed shared by the paired runs of a task and repeat (session run and each suggestion's run). */
export function pairSeed(pairKey: string): number {
  let h = 2166136261;
  for (let i = 0; i < pairKey.length; i++) h = Math.imul(h ^ pairKey.charCodeAt(i), 16777619);
  return h >>> 0;
}

export async function executeRun(db: LabDb, o: { runId: string; repo: LabRepo; recipe: Recipe; task: LabTask; overlay: string; pairKey: string; signal?: AbortSignal }): Promise<void> {
  const { runId, repo, task } = o;
  db.updateRun(runId, { status: 'running' });
  const bench = getBenchmarkTask(task.benchmarkTask);
  const prompt = readFileSync(bench.promptPath!, 'utf8');
  const seed = pairSeed(o.pairKey);
  try {
    const coding = await runCodingAgent({
      config: loadConfig(LAB_CONFIG),
      runId,
      seed,
      task: bench,
      taskPrompt: o.recipe.wrap(prompt),
      workspaceOverlay: o.overlay,
      signal: o.signal,
    });
    const runDir = join(resultsDir(), 'runs', runId);
    const fired = skillsFired(runDir, repo.skillMarkers);
    const base = { tokens: coding.usage.totalTokens, costUsd: coding.usage.costUsd, durationMs: coding.durationMs, skillsFired: fired };
    if (coding.status === 'infra_error' || coding.status === 'interrupted') {
      db.updateRun(runId, { ...base, status: 'error', error: `${coding.status}: ${coding.failureReason ?? ''}`.trim(), finishedAt: new Date().toISOString() });
      return;
    }
    const { evaluateRun } = await import('../evaluator/index.js');
    const patchFile = join(runDir, 'workspace.patch');
    const evaluation = await evaluateRun({ runId, appDir: '', suite: 'dev', seed, taskId: task.benchmarkTask, patchFile });
    if (evaluation.evaluatorFailure) {
      db.updateRun(runId, { ...base, status: 'error', error: `evaluator failure: ${evaluation.failureSummary ?? ''}`.slice(0, 1000), finishedAt: new Date().toISOString() });
      return;
    }
    const patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
    const g = grade(task, evaluation, patch);
    db.updateRun(runId, {
      ...base,
      status: 'done',
      criteriaMet: g.met,
      criteriaDetail: g.detail,
      error: coding.status === 'completed' ? null : `coding run ended: ${coding.status}${coding.failureReason ? ` (${coding.failureReason})` : ''}`,
      finishedAt: new Date().toISOString(),
    });
    log.info('lab run done', { runId, task: task.id, met: `${g.met.length}/${task.criteria.length}`, tokens: base.tokens, skillsFired: fired });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    log.error('lab run failed', { runId, error: msg });
    db.updateRun(runId, { status: 'error', error: msg.slice(0, 1000), finishedAt: new Date().toISOString() });
  }
}
