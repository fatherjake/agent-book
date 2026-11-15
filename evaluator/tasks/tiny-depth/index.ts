/**
 * HIDDEN evaluator for task tiny-depth (docs/TASKS.md §4): a depth chart tab in tiny's order book card.
 *
 * Every check traces to a § of benchmark/tasks/tiny-depth/spec/feature.md. The reference
 * implementation (./reference.diff) never leaves this directory: it is not in the public tiny repo.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvaluationResult } from '../../../runner/types.js';
import { runTinyEvaluation, type EvaluateTaskOptions, type TinyTaskDefinition } from '../tiny-common/evaluate.js';
import { uiChecks } from './ui-checks.js';
import { depthVisual } from './visual.js';

export const VISUAL_THRESHOLD = Number(process.env.FRUGAL_TINY_DEPTH_VISUAL_THRESHOLD ?? 75);

export const TASK_DEFINITION: TinyTaskDefinition = {
  taskId: 'tiny-depth',
  dir: path.dirname(fileURLToPath(import.meta.url)),
  bots: 20,
  uiChecks,
  visual: depthVisual,
  visualCheck: { id: 'visual.depth', threshold: VISUAL_THRESHOLD, mandatory: true },
};

export async function evaluateTask(opts: EvaluateTaskOptions): Promise<EvaluationResult> {
  return runTinyEvaluation(TASK_DEFINITION, opts);
}
