/**
 * Visual evaluation: screenshots at fixed viewports compared with the frozen reference design.
 *
 * Score (0–100) per viewport = 100 × (wP·P + wS·S + wL·L + wT·T), see VISUAL_SCORING.md:
 *   P  pixel similarity      pixelmatch (threshold 0.1, anti-aliased pixels ignored) + 1px position
 *                            tolerance, normalised by the reference's "ink" pixels (pixels that are not
 *                            one of its two dominant colours = page background + card background)
 *   S  structural similarity multi-scale SSIM: mean over downsample factors 2, 4, 8 of the mean SSIM on
 *                            grayscale 8×8 windows (stride 4) that contain content
 *   L  layout                bounding boxes of key elements (role queries) vs the reference app
 *   T  typography            computed font-family / size / weight of key elements vs the reference
 * Overall = 0.6 × desktop + 0.4 × mobile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright';
import type { CheckResult } from '../runner/types.js';
import type { LaunchedApp } from './app-launcher.js';
import { isInfraError, trunc } from './checks.js';
import { loadDesignFixtures, seedTodos, type FixtureTodo } from './fixtures.js';
import { contextOptions, todoList, uiTodos, type ViewportName } from './ui-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
export const DESIGN_FILES: Record<ViewportName, string> = {
  desktop: path.join(REPO, 'benchmark', 'spec', 'design.png'),
  mobile: path.join(REPO, 'benchmark', 'spec', 'design-mobile.png'),
};
export const VISUAL_REFERENCE_PATH = path.join(here, 'visual-reference.json');

export const WEIGHTS = { pixel: 0.35, ssim: 0.25, layout: 0.25, typography: 0.15 } as const;
export const VIEWPORT_WEIGHTS: Record<ViewportName, number> = { desktop: 0.6, mobile: 0.4 };
/** pixelmatch per-pixel colour threshold (YIQ/OKLab distance); 0.1 = library default. */
export const PIXEL_THRESHOLD = 0.1;
/** Layout: a combined |dx|+|dy|+|dw|+|dh| error of this many px scores 0 for that element. */
export const LAYOUT_TOLERANCE_PX = 48;
/** A flagged pixel still counts as matching if a reference pixel within this radius matches it. */
export const PIXEL_TOLERANCE_RADIUS = 1;
/** Downsampling factors for multi-scale SSIM. */
export const SSIM_SCALES = [2, 4, 8] as const;

// ---------------------------------------------------------------------------
// Image math (pure; unit-tested)
// ---------------------------------------------------------------------------

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

export function readPng(file: string): RgbaImage {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

export function writePng(file: string, img: RgbaImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Crop/pad (with white) `img` to width×height so both images can be compared. */
export function fitTo(img: RgbaImage, width: number, height: number): RgbaImage {
  if (img.width === width && img.height === height) return img;
  const out = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < Math.min(height, img.height); y++) {
    for (let x = 0; x < Math.min(width, img.width); x++) {
      const s = (y * img.width + x) * 4;
      const d = (y * width + x) * 4;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
      out[d + 3] = img.data[s + 3];
    }
  }
  return { width, height, data: out };
}

/** Luma (BT.601) grayscale, alpha-composited on white. */
export function toGray(img: RgbaImage): Float64Array {
  const n = img.width * img.height;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    const r = img.data[i * 4] * a + 255 * (1 - a);
    const gg = img.data[i * 4 + 1] * a + 255 * (1 - a);
    const b = img.data[i * 4 + 2] * a + 255 * (1 - a);
    g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
  }
  return g;
}

/** Most frequent RGB colour (the page background). */
export function dominantColor(img: RgbaImage): number {
  const counts = new Map<number, number>();
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 200_000));
  for (let i = 0; i < n; i += step) {
    const k = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [k, v] of counts) if (v > bestN) [best, bestN] = [k, v];
  return best;
}

/** The k most frequent RGB colours. */
export function topColors(img: RgbaImage, k: number): number[] {
  const counts = new Map<number, number>();
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const c = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map((e) => e[0]);
}

/** "Ink" pixels: not one of the image's two dominant colours (page + card background). */
export function inkPixelCount(img: RgbaImage): number {
  const bg = topColors(img, 2);
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const c = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
    if (!bg.includes(c)) n++;
  }
  return n;
}

function yiqPlanes(img: RgbaImage): [Float32Array, Float32Array, Float32Array] {
  const n = img.width * img.height;
  const Y = new Float32Array(n);
  const I = new Float32Array(n);
  const Q = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const a = img.data[p * 4 + 3] / 255;
    const r = 255 + (img.data[p * 4] - 255) * a;
    const g = 255 + (img.data[p * 4 + 1] - 255) * a;
    const b = 255 + (img.data[p * 4 + 2] - 255) * a;
    Y[p] = r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
    I[p] = r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
    Q[p] = r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
  }
  return [Y, I, Q];
}

export interface PixelResult {
  /** pixelmatch mismatches (anti-aliasing excluded) */
  mismatched: number;
  /** mismatches that also have no matching reference pixel within PIXEL_TOLERANCE_RADIUS */
  mismatchedTolerant: number;
  inkPixels: number;
  /** mismatched / total pixels */
  mismatchRatio: number;
  /** 1 − mismatchedTolerant / inkPixels, clamped to [0,1] */
  similarity: number;
}

export function pixelSimilarity(ref: RgbaImage, cand: RgbaImage, diffOut?: Uint8Array): PixelResult {
  const c = fitTo(cand, ref.width, ref.height);
  const W = ref.width;
  const H = ref.height;
  const out = diffOut ?? new Uint8Array(W * H * 4);
  const mismatched = pixelmatch(ref.data, c.data, out, W, H, {
    threshold: PIXEL_THRESHOLD,
    includeAA: false,
    diffColor: [255, 0, 0],
    aaColor: [255, 255, 0],
    diffColorAlt: [255, 0, 0],
  });
  // pixelmatch's YIQ colour distance limit for the same threshold.
  const maxDelta = 35215 * PIXEL_THRESHOLD * PIXEL_THRESHOLD;
  const [rY, rI, rQ] = yiqPlanes(ref);
  const [cY, cI, cQ] = yiqPlanes(c);
  const R = PIXEL_TOLERANCE_RADIUS;
  let mismatchedTolerant = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!(out[p * 4] === 255 && out[p * 4 + 1] === 0 && out[p * 4 + 2] === 0)) continue;
      let ok = false;
      for (let dy = -R; dy <= R && !ok; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R && !ok; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W || (dx === 0 && dy === 0)) continue;
          const q = yy * W + xx;
          const d = 0.5053 * (rY[q] - cY[p]) ** 2 + 0.299 * (rI[q] - cI[p]) ** 2 + 0.1957 * (rQ[q] - cQ[p]) ** 2;
          if (d <= maxDelta) ok = true;
        }
      }
      if (!ok) mismatchedTolerant++;
    }
  }
  const inkPixels = Math.max(inkPixelCount(ref), 1);
  return {
    mismatched,
    mismatchedTolerant,
    inkPixels,
    mismatchRatio: mismatched / (W * H),
    similarity: Math.max(0, Math.min(1, 1 - mismatchedTolerant / inkPixels)),
  };
}

/** Box-filter downsample of a grayscale image by an integer factor. */
export function downsample(g: Float64Array, width: number, height: number, f: number): { data: Float64Array; width: number; height: number } {
  if (f === 1) return { data: g, width, height };
  const W = Math.floor(width / f);
  const H = Math.floor(height / f);
  const o = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += g[(y * f + j) * width + x * f + i];
      o[y * W + x] = s / (f * f);
    }
  }
  return { data: o, width: W, height: H };
}

/** Multi-scale SSIM: mean of ssim() over SSIM_SCALES downsample factors. */
export function multiScaleSsim(a: Float64Array, b: Float64Array, width: number, height: number, scales: readonly number[] = SSIM_SCALES): number {
  let sum = 0;
  for (const f of scales) {
    const da = downsample(a, width, height, f);
    const db = downsample(b, width, height, f);
    sum += ssim(da.data, db.data, da.width, da.height);
  }
  return sum / scales.length;
}

/**
 * Mean SSIM over square windows on grayscale images (Wang et al. 2004 constants, L = 255).
 * Windows where both images are flat (variance < 1) are skipped so that large uniform background
 * areas don't inflate the score; if every window is flat the plain mean over all windows is used.
 */
export function ssim(
  a: Float64Array,
  b: Float64Array,
  width: number,
  height: number,
  opts: { window?: number; stride?: number; skipFlat?: boolean } = {},
): number {
  const win = opts.window ?? 8;
  const stride = opts.stride ?? 4;
  const skipFlat = opts.skipFlat ?? true;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let count = 0;
  let sumAll = 0;
  let countAll = 0;
  const n = win * win;
  for (let y = 0; y + win <= height; y += stride) {
    for (let x = 0; x + win <= width; x += stride) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < win; j++) {
        const row = (y + j) * width + x;
        for (let i = 0; i < win; i++) {
          ma += a[row + i];
          mb += b[row + i];
        }
      }
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < win; j++) {
        const row = (y + j) * width + x;
        for (let i = 0; i < win; i++) {
          const da = a[row + i] - ma;
          const db = b[row + i] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sumAll += s;
      countAll++;
      const flat = va < 1 && vb < 1 && Math.abs(ma - mb) < 1;
      if (skipFlat && flat) continue;
      sum += s;
      count++;
    }
  }
  if (count === 0) return countAll ? sumAll / countAll : 1;
  return sum / count;
}


// ---------------------------------------------------------------------------
// Layout + typography (measured in the browser via role queries)
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Typo {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
}
export interface LayoutMeasurement {
  boxes: Record<string, Box | null>;
  typography: Record<string, Typo | null>;
}

const roundBox = (b: Box | null): Box | null =>
  b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;

/** Measure key element boxes (role queries only) and typography for the design fixture state. */
export async function measureLayout(page: Page, fixtures: FixtureTodo[]): Promise<LayoutMeasurement> {
  const boxes: Record<string, Box | null> = {};
  const typography: Record<string, Typo | null> = {};
  const box = async (key: string, loc: import('playwright').Locator) => {
    boxes[key] = (await loc.count()) ? roundBox(await loc.first().boundingBox()) : null;
  };
  const typo = async (key: string, loc: import('playwright').Locator) => {
    typography[key] = (await loc.count())
      ? await loc.first().evaluate((el) => {
          const cs = getComputedStyle(el);
          return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight };
        })
      : null;
  };
  const heading = page.getByRole('heading', { level: 1, name: 'Todos', exact: true });
  const input = page.getByRole('textbox', { name: 'New todo', exact: true });
  const add = page.getByRole('button', { name: 'Add', exact: true });
  const list = todoList(page);
  const counter = page.getByText(/^\s*\d+\s+items?\s+left\s*$/);
  await box('heading', heading);
  await box('newTodoInput', input);
  await box('addButton', add);
  await box('list', list);
  await box('counter', counter);
  for (const f of ['All', 'Active', 'Completed']) await box(`filter.${f}`, page.getByRole('button', { name: f, exact: true }));
  for (let i = 0; i < fixtures.length; i++) {
    const t = fixtures[i].title;
    await box(`item${i}.toggle`, page.getByRole('checkbox', { name: `Toggle ${t}`, exact: true }));
    await box(`item${i}.edit`, page.getByRole('button', { name: `Edit ${t}`, exact: true }));
    await box(`item${i}.delete`, page.getByRole('button', { name: `Delete ${t}`, exact: true }));
    await box(`item${i}.row`, list.getByRole('listitem').filter({ hasText: t }));
  }
  await typo('heading', heading);
  await typo('newTodoInput', input);
  await typo('addButton', add);
  await typo('counter', counter);
  await typo('filter.All', page.getByRole('button', { name: 'All', exact: true }));
  await typo('edit', page.getByRole('button', { name: `Edit ${fixtures[0]?.title ?? ''}`, exact: true }));
  // Item title text: the innermost element whose own text is exactly the title.
  if (fixtures.length) {
    typography['itemTitle'] = await list
      .first()
      .evaluate((ul, t) => {
        const walker = document.createTreeWalker(ul, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if ((n.textContent ?? '').trim() === t && n.parentElement) {
            const cs = getComputedStyle(n.parentElement);
            return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight };
          }
        }
        return null;
      }, fixtures[0].title)
      .catch(() => null);
  }
  return { boxes, typography };
}

export function layoutScore(ref: Record<string, Box | null>, cand: Record<string, Box | null>): { score: number; details: Record<string, number> } {
  const details: Record<string, number> = {};
  const keys = Object.keys(ref).filter((k) => ref[k]);
  if (!keys.length) return { score: 0, details };
  let sum = 0;
  for (const k of keys) {
    const r = ref[k]!;
    const c = cand[k];
    let s = 0;
    if (c) {
      const err = Math.abs(r.x - c.x) + Math.abs(r.y - c.y) + Math.abs(r.width - c.width) + Math.abs(r.height - c.height);
      s = Math.max(0, 1 - err / LAYOUT_TOLERANCE_PX);
    }
    details[k] = Math.round(s * 1000) / 1000;
    sum += s;
  }
  return { score: sum / keys.length, details };
}

const primaryFamily = (f: string) => f.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();

export function typographyScore(ref: Record<string, Typo | null>, cand: Record<string, Typo | null>): { score: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let total = 0;
  let ok = 0;
  for (const [k, r] of Object.entries(ref)) {
    if (!r) continue;
    const c = cand[k];
    total += 3;
    if (!c) {
      mismatches.push(`${k}: missing`);
      continue;
    }
    if (primaryFamily(c.fontFamily) === primaryFamily(r.fontFamily)) ok++;
    else mismatches.push(`${k}: font-family ${c.fontFamily} ≠ ${r.fontFamily}`);
    if (Math.abs(parseFloat(c.fontSize) - parseFloat(r.fontSize)) <= 0.5) ok++;
    else mismatches.push(`${k}: font-size ${c.fontSize} ≠ ${r.fontSize}`);
    if (String(c.fontWeight) === String(r.fontWeight)) ok++;
    else mismatches.push(`${k}: font-weight ${c.fontWeight} ≠ ${r.fontWeight}`);
  }
  return { score: total ? ok / total : 0, mismatches };
}

// ---------------------------------------------------------------------------
// Capture + score
// ---------------------------------------------------------------------------

export interface VisualReference {
  generatedAt: string;
  source: string;
  viewports: Record<ViewportName, LayoutMeasurement>;
}

export function loadVisualReference(): VisualReference {
  if (!fs.existsSync(VISUAL_REFERENCE_PATH)) {
    throw new Error(`${VISUAL_REFERENCE_PATH} missing: run tsx evaluator/generate-visual-reference.ts`);
  }
  return JSON.parse(fs.readFileSync(VISUAL_REFERENCE_PATH, 'utf8')) as VisualReference;
}

/** Capture exactly like scripts/generate-design.ts (ARCHITECTURE.md capture settings). */
export async function captureDesignState(
  browser: Browser,
  url: string,
  viewport: ViewportName,
  fixtures: FixtureTodo[],
  opts: { screenshotPath?: string; mutatePage?: (page: Page) => Promise<void> } = {},
): Promise<{ png: Buffer; layout: LayoutMeasurement; renderedItems: number }> {
  const context = await browser.newContext(contextOptions(viewport));
  context.setDefaultTimeout(10_000);
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    // Wait for the list to render (don't fail: a broken app is still scored, just badly).
    const deadline = Date.now() + 10_000;
    let renderedItems = 0;
    while (Date.now() < deadline) {
      renderedItems = (await uiTodos(page).catch(() => [])).length;
      if (renderedItems >= fixtures.length) break;
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);
    if (opts.mutatePage) await opts.mutatePage(page);
    const png = await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: false });
    if (opts.screenshotPath) {
      fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true });
      fs.writeFileSync(opts.screenshotPath, png);
    }
    const layout = await measureLayout(page, fixtures);
    return { png, layout, renderedItems };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export interface ViewportScore {
  viewport: ViewportName;
  score: number;
  pixel: number;
  ssim: number;
  layout: number;
  typography: number;
  raw: { mismatchRatio: number; mismatched: number; mismatchedTolerant: number; inkPixels: number; ssimScale1: number };
  typographyMismatches: string[];
  screenshot?: string;
  diff?: string;
}

/** Score one captured screenshot + layout against the frozen design + reference measurement. */
export function scoreViewport(
  viewport: ViewportName,
  candPng: Buffer,
  candLayout: LayoutMeasurement,
  reference: LayoutMeasurement,
  designPng: RgbaImage = readPng(DESIGN_FILES[viewport]),
  diffPath?: string,
): ViewportScore {
  const candDecoded = PNG.sync.read(candPng);
  const cand = fitTo({ width: candDecoded.width, height: candDecoded.height, data: candDecoded.data }, designPng.width, designPng.height);
  const diff = diffPath ? new Uint8Array(designPng.width * designPng.height * 4) : undefined;
  const px = pixelSimilarity(designPng, cand, diff);
  if (diffPath && diff) writePng(diffPath, { width: designPng.width, height: designPng.height, data: diff });
  const gRef = toGray(designPng);
  const gCand = toGray(cand);
  const rawSsim = ssim(gRef, gCand, designPng.width, designPng.height);
  const P = px.similarity;
  const S = Math.max(0, multiScaleSsim(gRef, gCand, designPng.width, designPng.height));
  const L = layoutScore(reference.boxes, candLayout.boxes).score;
  const typo = typographyScore(reference.typography, candLayout.typography);
  const T = typo.score;
  const score = 100 * (WEIGHTS.pixel * P + WEIGHTS.ssim * S + WEIGHTS.layout * L + WEIGHTS.typography * T);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    viewport,
    score: Math.round(score * 100) / 100,
    pixel: r3(P),
    ssim: r3(S),
    layout: r3(L),
    typography: r3(T),
    raw: {
      mismatchRatio: r3(px.mismatchRatio),
      mismatched: px.mismatched,
      mismatchedTolerant: px.mismatchedTolerant,
      inkPixels: px.inkPixels,
      ssimScale1: r3(rawSsim),
    },
    typographyMismatches: typo.mismatches,
    diff: diffPath,
  };
}

export function combineViewportScores(scores: ViewportScore[]): number {
  let total = 0;
  let w = 0;
  for (const s of scores) {
    total += VIEWPORT_WEIGHTS[s.viewport] * s.score;
    w += VIEWPORT_WEIGHTS[s.viewport];
  }
  return w ? Math.round((total / w) * 100) / 100 : 0;
}

export interface VisualRunResult {
  visualScore: number;
  viewports: ViewportScore[];
  checks: CheckResult[];
}

/**
 * Seed the "design" fixtures into a fresh DB, capture both viewports and score them.
 * Infra problems (browser crash, missing reference files) → 'error' checks; app problems only
 * lower the score. Never throws.
 */
export async function runVisualTests(opts: {
  app: LaunchedApp;
  browser: Browser;
  screenshotDir: string;
  mutatePage?: (page: Page) => Promise<void>;
}): Promise<VisualRunResult> {
  const checks: CheckResult[] = [];
  const viewports: ViewportScore[] = [];
  let reference: VisualReference;
  let fixtures: FixtureTodo[];
  try {
    reference = loadVisualReference();
    fixtures = loadDesignFixtures();
    for (const v of ['desktop', 'mobile'] as const) {
      if (!fs.existsSync(DESIGN_FILES[v])) throw new Error(`missing ${DESIGN_FILES[v]}`);
    }
  } catch (e) {
    checks.push({
      id: 'visual.capture',
      category: 'visual',
      mandatory: true,
      outcome: 'error',
      message: `evaluator error: ${(e as Error).message}`,
      attempts: 1,
    });
    return { visualScore: 0, viewports, checks };
  }

  let seedNote = '';
  try {
    await opts.app.resetDb();
    await seedTodos(opts.app.url, fixtures);
  } catch (e) {
    if (isInfraError(e)) {
      checks.push({ id: 'visual.capture', category: 'visual', mandatory: true, outcome: 'error', message: `evaluator error: ${(e as Error).message}`, attempts: 1 });
      return { visualScore: 0, viewports, checks };
    }
    // The app's API can't seed the design data: still capture (the score will be low).
    seedNote = `seeding the design fixtures failed: ${(e as Error).message}`;
  }

  fs.mkdirSync(opts.screenshotDir, { recursive: true });
  try {
    for (const v of ['desktop', 'mobile'] as const) {
      const shot = path.join(opts.screenshotDir, `visual-${v}.png`);
      const diffPath = path.join(opts.screenshotDir, `visual-${v}-diff.png`);
      const cap = await captureDesignState(opts.browser, opts.app.url, v, fixtures, { screenshotPath: shot, mutatePage: opts.mutatePage });
      const s = scoreViewport(v, cap.png, cap.layout, reference.viewports[v], readPng(DESIGN_FILES[v]), diffPath);
      s.screenshot = shot;
      viewports.push(s);
      checks.push({
        id: `visual.${v}`,
        category: 'visual',
        mandatory: false,
        outcome: 'pass',
        message: trunc(
          `score ${s.score} (pixel ${s.pixel}, ssim ${s.ssim}, layout ${s.layout}, typography ${s.typography}; ` +
            `raw mismatch ${(s.raw.mismatchRatio * 100).toFixed(2)}%, raw single-scale ssim ${s.raw.ssimScale1})` +
            (s.typographyMismatches.length ? ` typography: ${s.typographyMismatches.slice(0, 4).join('; ')}` : '') +
            (seedNote ? ` [${seedNote}]` : ''),
          1200,
        ),
        evidence: [shot, diffPath, DESIGN_FILES[v]],
        attempts: 1,
      });
    }
  } catch (e) {
    const infra = isInfraError(e);
    checks.push({
      id: 'visual.capture',
      category: 'visual',
      mandatory: true,
      outcome: infra ? 'error' : 'fail',
      message: `${infra ? 'evaluator error: ' : ''}${(e as Error).message}`,
      attempts: 1,
    });
    return { visualScore: 0, viewports, checks };
  }
  const visualScore = combineViewportScores(viewports);
  checks.unshift({
    id: 'visual.capture',
    category: 'visual',
    mandatory: true,
    outcome: 'pass',
    message: `visual score ${visualScore}${seedNote ? ` [${seedNote}]` : ''}`,
    attempts: 1,
  });
  return { visualScore, viewports, checks };
}
