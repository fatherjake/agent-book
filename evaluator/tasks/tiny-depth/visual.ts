/**
 * HIDDEN visual comparison for task tiny-depth: the order book card on the Depth tab, with the suite's
 * pinned main book, is screenshotted twice (resting, and hovering at 30% of the plot width) and
 * compared with the reference implementation's screenshots in ./visual/<suite>-<shot>.png.
 *
 * Score per shot = 100 × (0.5 × tolerant pixel similarity + 0.5 × multi-scale SSIM) (the todo
 * evaluator's metrics, evaluator/visual-tests.ts); the visual score is the mean over the shots.
 * FRUGAL_TINY_WRITE_REFERENCE=1 writes the current screenshots as the new references (run it only
 * against the reference implementation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { EvaluatorInfraError } from '../../app-launcher.js';
import { fitTo, multiScaleSsim, pixelSimilarity, readPng, toGray, writePng, type RgbaImage } from '../../visual-tests.js';
import type { TinyCheckContext, VisualOutcome } from '../tiny-common/evaluate.js';
import { SUITES } from './fixtures.js';
import { openPage } from './ui-checks.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'visual');
export const SHOTS = ['rest', 'hover'] as const;
export const referencePath = (suite: string, shot: string) => path.join(DIR, `${suite}-${shot}.png`);

const decode = (buf: Buffer): RgbaImage => {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
};

export async function depthVisual(ctx: TinyCheckContext): Promise<VisualOutcome> {
  const write = process.env.FRUGAL_TINY_WRITE_REFERENCE === '1';
  const p = await openPage(ctx, SUITES[ctx.suite].main);
  const shots: Partial<Record<(typeof SHOTS)[number], Buffer>> = {};
  try {
    const { page } = p;
    const tab = page.getByRole('button', { name: 'Depth', exact: true });
    if (!(await tab.isVisible().catch(() => false))) throw new Error('no Depth tab to screenshot');
    await tab.click();
    const plot = page.getByRole('img', { name: 'Depth chart', exact: true });
    await plot.waitFor({ state: 'visible', timeout: 10_000 });
    // The card that holds the tab bar (the order book card in the checkpoint's layout).
    const card = tab.locator('xpath=ancestor::section[1]');
    if ((await card.count()) === 0) throw new Error('the Depth tab is not inside a <section> card');
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    shots.rest = await card.screenshot({ animations: 'disabled', caret: 'hide' });
    const b = await plot.boundingBox();
    if (!b) throw new Error('the Depth chart has no layout box');
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.55);
    await page.waitForTimeout(400);
    shots.hover = await card.screenshot({ animations: 'disabled', caret: 'hide' });
  } finally {
    await p.close().catch(() => undefined);
  }

  const details: Record<string, unknown> = {};
  const evidence: string[] = [];
  const scores: number[] = [];
  for (const shot of SHOTS) {
    const buf = shots[shot]!;
    const candFile = path.join(ctx.screenshotDir, `visual-${shot}.png`);
    fs.writeFileSync(candFile, buf);
    evidence.push(candFile);
    const refFile = referencePath(ctx.suite, shot);
    if (write) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(refFile, buf);
    }
    if (!fs.existsSync(refFile)) throw new EvaluatorInfraError(`missing visual reference ${path.relative(process.cwd(), refFile)}`);
    const ref = readPng(refFile);
    const cand = decode(buf);
    const fitted = fitTo(cand, ref.width, ref.height);
    const diff = new Uint8Array(ref.width * ref.height * 4);
    const px = pixelSimilarity(ref, fitted, diff);
    const ss = multiScaleSsim(toGray(ref), toGray(fitted), ref.width, ref.height);
    const sizePenalty = Math.min(cand.width, ref.width) * Math.min(cand.height, ref.height) / (Math.max(cand.width, ref.width) * Math.max(cand.height, ref.height));
    const score = 100 * (0.5 * px.similarity + 0.5 * Math.max(0, ss)) * sizePenalty;
    const diffFile = path.join(ctx.screenshotDir, `visual-${shot}-diff.png`);
    writePng(diffFile, { width: ref.width, height: ref.height, data: diff });
    evidence.push(diffFile);
    details[shot] = { score: Math.round(score * 100) / 100, pixel: Math.round(px.similarity * 1000) / 1000, ssim: Math.round(ss * 1000) / 1000, size: [cand.width, cand.height], refSize: [ref.width, ref.height] };
    scores.push(score);
  }
  const score = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { score, details, evidence };
}
