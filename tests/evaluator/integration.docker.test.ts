/**
 * Evaluator integration tests (Docker + Playwright Chromium). Skipped when docker is unavailable.
 *
 *  1. The hidden reference app passes every deterministic + visual check (visual ≥ 99).
 *  2. The bare starter fails cleanly: an APP failure (startup), not an evaluator failure.
 *  3. A deliberately broken copy of the reference app (completed flag not persisted + recoloured
 *     accent) fails the matching functional checks and the visual threshold, with no evaluator errors.
 *
 * The browser agent is skipped here (no model credentials on CI / dev machines); its tool layer
 * is covered by browser-agent.test.ts with a scripted fake provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '../../evaluator/docker.js';
import { REPO_ROOT } from '../../evaluator/fixtures.js';
import { evaluateRun } from '../../evaluator/index.js';
import type { EvaluationResult } from '../../runner/types.js';

process.env.FRUGAL_QUIET = '1';
const available = await dockerAvailable();
const REFERENCE = path.join(REPO_ROOT, 'evaluator', 'reference-app');
const STARTER = path.join(REPO_ROOT, 'benchmark', 'starter');

function copyApp(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/(^|\/)(node_modules|dist|data)(\/|$)/.test(path.relative(src, p)) && !p.endsWith('.db'),
  });
}

const failing = (r: EvaluationResult) => r.checks.filter((c) => c.outcome !== 'pass').map((c) => `${c.id}: ${c.outcome} ${c.message ?? ''}`);

describe.skipIf(!available)('evaluator integration (docker)', { timeout: 900_000 }, () => {
  let image = '';
  let tmp = '';
  beforeAll(async () => {
    image = (await (await import('../../benchmark/docker/image.js')).ensureImage()).image;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-eval-int-'));
  }, 900_000);
  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const suite of ['dev', 'holdout'] as const) {
    it(`reference app passes the full deterministic + visual ${suite} suite with visual ≥ 99`, async () => {
      const r = await evaluateRun({
        runId: `itest-ref-${suite}`,
        appDir: REFERENCE,
        suite,
        seed: suite === 'dev' ? 1234 : 98765,
        skipBrowserAgent: true,
        outDir: path.join(tmp, `ref-${suite}`),
        image,
      });
      expect(failing(r)).toEqual([]);
      expect(r.appStarted).toBe(true);
      expect(r.evaluatorFailure).toBe(false);
      expect(r.visualScore).toBeGreaterThanOrEqual(99);
      expect(r.passed).toBe(true);
      expect(r.checks.length).toBeGreaterThan(50);
      expect(fs.existsSync(path.join(tmp, `ref-${suite}`, 'report.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, `ref-${suite}`, 'screenshots', 'visual-desktop.png'))).toBe(true);
    });
  }

  it('bare starter fails cleanly as an app failure (not an evaluator failure)', async () => {
    const r = await evaluateRun({ runId: 'itest-starter', appDir: STARTER, suite: 'dev', seed: 1, skipBrowserAgent: true, outDir: path.join(tmp, 'starter'), image });
    expect(r.passed).toBe(false);
    expect(r.evaluatorFailure).toBe(false);
    expect(r.appStarted).toBe(false);
    const startup = r.checks.find((c) => c.id === 'startup.app');
    expect(startup?.outcome).toBe('fail');
    expect(r.checks.some((c) => c.outcome === 'error')).toBe(false);
    expect(r.failureSummary).toMatch(/app did not start/);
  });

  it('a broken copy of the reference app fails the matching checks and the visual threshold', async () => {
    const dir = path.join(tmp, 'broken-app');
    copyApp(REFERENCE, dir);
    const dbFile = path.join(dir, 'backend', 'db.js');
    const db = fs.readFileSync(dbFile, 'utf8');
    expect(db).toContain('values.push(fields.completed ? 1 : 0);');
    fs.writeFileSync(dbFile, db.replace('values.push(fields.completed ? 1 : 0);', 'values.push(0);'));
    const cssFile = path.join(dir, 'frontend', 'src', 'styles.css');
    fs.writeFileSync(cssFile, fs.readFileSync(cssFile, 'utf8').replaceAll('#2563eb', '#16a34a').replaceAll('#f3f4f6', '#e5e7eb'));

    const r = await evaluateRun({ runId: 'itest-broken', appDir: dir, suite: 'dev', seed: 5, skipBrowserAgent: true, outDir: path.join(tmp, 'broken'), image });
    const byId = new Map(r.checks.map((c) => [c.id, c]));
    expect(r.appStarted).toBe(true);
    expect(r.evaluatorFailure).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.checks.some((c) => c.outcome === 'error')).toBe(false);
    expect(byId.get('api.patch.completed')?.outcome).toBe('fail');
    expect(byId.get('ui.complete')?.outcome).toBe('fail');
    expect(byId.get('ui.persistence.reload')?.outcome).toBe('fail');
    // Unrelated features (that don't depend on seeded completed todos) still pass.
    expect(byId.get('api.create.valid')?.outcome).toBe('pass');
    expect(byId.get('api.delete')?.outcome).toBe('pass');
    expect(byId.get('api.patch.title')?.outcome).toBe('pass');
    expect(byId.get('ui.create.button')?.outcome).toBe('pass');
    expect(r.visualScore).toBeLessThan(95);
  });
});
