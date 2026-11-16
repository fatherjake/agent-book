/**
 * Re-score the visual "design" criterion of finished runs from the screenshots their evaluation saved
 * (results/runs/<id>/eval/dev/screenshots/visual-<shot>.png), with the evaluator's current visual
 * metric and threshold. Used when the metric changes; nothing is re-run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resultsDir } from '../runner/env.js';
import { readPng } from '../evaluator/visual-tests.js';
import { scoreShots, SHOTS } from '../evaluator/tasks/tiny-depth/visual.js';
import { VISUAL_THRESHOLD } from '../evaluator/tasks/tiny-depth/index.js';
import type { LabDb } from './db.js';

export async function regradeVisual(db: LabDb): Promise<string[]> {
  const out: string[] = [];
  const runs = db.raw.prepare(`SELECT id FROM runs WHERE status = 'done' AND criteria_detail LIKE '%visual.depth%'`).all() as { id: string }[];
  for (const { id } of runs) {
    const dir = join(resultsDir(), 'runs', id, 'eval', 'dev', 'screenshots');
    if (!SHOTS.every((s) => existsSync(join(dir, `visual-${s}.png`)))) {
      out.push(`${id}: no saved screenshots, skipped`);
      continue;
    }
    const cand = Object.fromEntries(SHOTS.map((s) => [s, readPng(join(dir, `visual-${s}.png`))]));
    const { score } = scoreShots('dev', cand);
    const r = db.raw.prepare('SELECT criteria_met, criteria_detail FROM runs WHERE id = ?').get(id) as { criteria_met: string; criteria_detail: string };
    const detail = JSON.parse(r.criteria_detail);
    const ok = score >= VISUAL_THRESHOLD;
    const before = !!detail.design?.met;
    detail.design = { met: ok, checks: [{ id: 'visual.depth', outcome: ok ? 'pass' : 'fail', message: `visual score ${score.toFixed(2)} ${ok ? '>=' : '<'} ${VISUAL_THRESHOLD} (structural metric, regraded)` }] };
    const met = (JSON.parse(r.criteria_met) as string[]).filter((c) => c !== 'design');
    if (ok) met.push('design');
    const order = Object.keys(detail);
    met.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    db.updateRun(id, { criteriaMet: met, criteriaDetail: detail });
    out.push(`${id}: visual ${score.toFixed(1)} → design ${ok ? 'met' : 'missed'}${before !== ok ? ` (was ${before ? 'met' : 'missed'})` : ''}`);
  }
  return out;
}
