/**
 * HIDDEN visual comparison for task tiny-depth: the order book card on the Depth tab, with the suite's
 * pinned main book, is screenshotted twice (resting, and hovering at 30% of the plot width) and
 * compared with the reference implementation's screenshots in ./visual/<suite>-<shot>.png.
 *
 * Score per shot (structural): both images are compared at reduced resolution, so a chart drawn a few
 * pixels taller or offset (which looks the same to a person) is not punished:
 *   100 × (0.5 × colour-layout similarity at 1/6 resolution + 0.5 × SSIM at scales 8 and 16)
 * colour-layout similarity = 1 - 4 × mean absolute RGB error (0 at a 25% mean error). The visual score
 * is the mean over the shots, times a penalty when the card's size differs. The old pixel-level score
 * (tolerant pixel similarity + multi-scale SSIM) is kept in the details for reference only: it scored
 * charts that look identical to the design as low as 53 because of a 3-4 px layout difference.
 * FRUGAL_TINY_WRITE_REFERENCE=1 writes the current screenshots as the new references (run it only
 * against the reference implementation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { EvaluatorInfraError } from '../../app-launcher.js';
import { downsample, fitTo, multiScaleSsim, pixelSimilarity, readPng, toGray, writePng, type RgbaImage } from '../../visual-tests.js';
import type { TinyCheckContext, VisualOutcome } from '../tiny-common/evaluate.js';
import { SUITES } from './fixtures.js';
import { openPage } from './ui-checks.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'visual');
export const SHOTS = ['rest', 'hover'] as const;
export const referencePath = (suite: string, shot: string) => path.join(DIR, `${suite}-${shot}.png`);

/** Structural similarity in 0..100 (see the header): colour layout at 1/6 resolution + coarse SSIM. */
export function structuralScore(ref: RgbaImage, cand: RgbaImage): number {
  const f = 6;
  const planes = (img: RgbaImage) =>
    [0, 1, 2].map((c) => {
      const n = img.width * img.height;
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = img.data[i * 4 + c];
      return downsample(a, img.width, img.height, f).data;
    });
  const a = planes(ref);
  const b = planes(cand);
  let diff = 0;
  const n = a[0].length;
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) diff += Math.abs(a[c][i] - b[c][i]);
  const colour = Math.max(0, 1 - (diff / (3 * n * 255)) * 4);
  const ss = Math.max(0, multiScaleSsim(toGray(ref), toGray(cand), ref.width, ref.height, [8, 16]));
  return 100 * (0.5 * colour + 0.5 * ss);
}

/** Score candidate screenshots against a suite's references (also used to re-grade saved screenshots). */
export function scoreShots(suite: string, candidates: Record<string, RgbaImage>): { score: number; details: Record<string, unknown> } {
  const details: Record<string, unknown> = {};
  const scores: number[] = [];
  for (const shot of SHOTS) {
    const ref = readPng(referencePath(suite, shot));
    const cand = candidates[shot];
    const fitted = fitTo(cand, ref.width, ref.height);
    const sizePenalty = (Math.min(cand.width, ref.width) * Math.min(cand.height, ref.height)) / (Math.max(cand.width, ref.width) * Math.max(cand.height, ref.height));
    const score = structuralScore(ref, fitted) * sizePenalty;
    const px = pixelSimilarity(ref, fitted);
    const pixelScore = 100 * (0.5 * px.similarity + 0.5 * Math.max(0, multiScaleSsim(toGray(ref), toGray(fitted), ref.width, ref.height)));
    details[shot] = { score: Math.round(score * 100) / 100, pixelLevel: Math.round(pixelScore * 100) / 100, size: [cand.width, cand.height], refSize: [ref.width, ref.height] };
    scores.push(score);
  }
  return { score: scores.reduce((x, y) => x + y, 0) / scores.length, details };
}

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

  const evidence: string[] = [];
  const candidates: Record<string, RgbaImage> = {};
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
    candidates[shot] = decode(buf);
    const ref = readPng(refFile);
    const diff = new Uint8Array(ref.width * ref.height * 4);
    pixelSimilarity(ref, fitTo(candidates[shot], ref.width, ref.height), diff);
    const diffFile = path.join(ctx.screenshotDir, `visual-${shot}-diff.png`);
    writePng(diffFile, { width: ref.width, height: ref.height, data: diff });
    evidence.push(diffFile);
  }
  const { score, details } = scoreShots(ctx.suite, candidates);
  return { score, details, evidence };
}
