import { describe, expect, it } from 'vitest';
import {
  combineViewportScores,
  downsample,
  fitTo,
  layoutScore,
  LAYOUT_TOLERANCE_PX,
  multiScaleSsim,
  pixelSimilarity,
  ssim,
  toGray,
  typographyScore,
  WEIGHTS,
  type RgbaImage,
  type ViewportScore,
} from '../../evaluator/visual-tests.js';

/** Synthetic "page": light background, white card, dark text-like bars. */
function makePage(w: number, h: number, opts: { shiftY?: number; accent?: [number, number, number]; textColor?: number } = {}): RgbaImage {
  const d = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, 243, 244, 246);
  const sy = opts.shiftY ?? 0;
  for (let y = 20; y < h - 20; y++) for (let x = 20; x < w - 20; x++) set(x, y + sy, 255, 255, 255);
  const tc = opts.textColor ?? 17;
  for (let row = 0; row < 5; row++) {
    for (let y = 40 + row * 30; y < 48 + row * 30; y++) {
      for (let x = 40; x < 40 + 60 + row * 15; x++) if ((x >> 2) % 3 !== 0) set(x, y + sy, tc, tc + 7, tc + 22);
    }
  }
  const [ar, ag, ab] = opts.accent ?? [37, 99, 235];
  for (let y = 30; y < 50; y++) for (let x = w - 70; x < w - 30; x++) set(x, y + sy, ar, ag, ab);
  return { width: w, height: h, data: d };
}

describe('SSIM', () => {
  const a = makePage(200, 200);
  const ga = toGray(a);

  it('is 1 for identical images', () => {
    expect(ssim(ga, ga, 200, 200)).toBeCloseTo(1, 10);
    expect(multiScaleSsim(ga, ga, 200, 200)).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    const gb = toGray(makePage(200, 200, { shiftY: 3 }));
    expect(ssim(ga, gb, 200, 200)).toBeCloseTo(ssim(gb, ga, 200, 200), 10);
  });

  it('decreases with larger shifts and is low for an inverted image', () => {
    const s1 = multiScaleSsim(ga, toGray(makePage(200, 200, { shiftY: 1 })), 200, 200);
    const s8 = multiScaleSsim(ga, toGray(makePage(200, 200, { shiftY: 8 })), 200, 200);
    expect(s1).toBeLessThan(1);
    expect(s8).toBeLessThan(s1);
    const inv = new Float64Array(ga.length);
    for (let i = 0; i < ga.length; i++) inv[i] = 255 - ga[i];
    expect(ssim(ga, inv, 200, 200)).toBeLessThan(0.2);
  });

  it('matches the closed form for a constant offset on a flat window', () => {
    // Two flat 8x8 images with means 100 and 110, not skipped (means differ): SSIM = luminance term.
    const x = new Float64Array(64).fill(100);
    const y = new Float64Array(64).fill(110);
    const C1 = (0.01 * 255) ** 2;
    const expected = (2 * 100 * 110 + C1) / (100 * 100 + 110 * 110 + C1);
    expect(ssim(x, y, 8, 8)).toBeCloseTo(expected, 10);
  });

  it('downsample averages blocks', () => {
    const g = new Float64Array([0, 2, 4, 6, 0, 2, 4, 6]);
    const d = downsample(g, 4, 2, 2);
    expect(d.width).toBe(2);
    expect(d.height).toBe(1);
    expect(Array.from(d.data)).toEqual([1, 5]);
  });
});

describe('pixel similarity', () => {
  it('is 1 for identical images and tolerates a 1px shift', () => {
    const a = makePage(200, 200);
    expect(pixelSimilarity(a, a).similarity).toBe(1);
    const shifted = pixelSimilarity(a, makePage(200, 200, { shiftY: 1 }));
    expect(shifted.mismatched).toBeGreaterThan(0);
    expect(shifted.mismatchedTolerant).toBe(0);
    expect(shifted.similarity).toBe(1);
  });

  it('penalises colour changes and larger shifts', () => {
    const a = makePage(200, 200);
    const green = pixelSimilarity(a, makePage(200, 200, { accent: [22, 163, 74] }));
    expect(green.similarity).toBeLessThan(0.9);
    const s4 = pixelSimilarity(a, makePage(200, 200, { shiftY: 4 }));
    expect(s4.similarity).toBeLessThan(0.95);
  });

  it('fitTo pads with white and crops', () => {
    const a = makePage(10, 10);
    const b = fitTo(a, 12, 8);
    expect(b.width).toBe(12);
    expect(b.height).toBe(8);
    expect(Array.from(b.data.slice((0 * 12 + 11) * 4, (0 * 12 + 11) * 4 + 4))).toEqual([255, 255, 255, 255]);
  });
});

describe('layout and typography scores', () => {
  const ref = { a: { x: 10, y: 10, width: 100, height: 20 }, b: { x: 10, y: 40, width: 50, height: 20 } };

  it('layout is 1 for identical boxes, decreases linearly with error, 0 for missing', () => {
    expect(layoutScore(ref, ref).score).toBe(1);
    const shifted = { a: { ...ref.a, y: 14 }, b: ref.b };
    expect(layoutScore(ref, shifted).score).toBeCloseTo((1 - 4 / LAYOUT_TOLERANCE_PX + 1) / 2, 10);
    expect(layoutScore(ref, { a: ref.a, b: null }).score).toBeCloseTo(0.5, 10);
    expect(layoutScore(ref, { a: { ...ref.a, x: 1000 }, b: ref.b }).details.a).toBe(0);
  });

  it('typography compares the primary family, size (±0.5px) and weight', () => {
    const r = { h: { fontFamily: 'Inter, sans-serif', fontSize: '32px', fontWeight: '700' } };
    expect(typographyScore(r, { h: { fontFamily: '"Inter", system-ui', fontSize: '32.4px', fontWeight: '700' } }).score).toBe(1);
    const bad = typographyScore(r, { h: { fontFamily: 'Arial', fontSize: '28px', fontWeight: '400' } });
    expect(bad.score).toBe(0);
    expect(bad.mismatches).toHaveLength(3);
    expect(typographyScore(r, { h: null }).score).toBe(0);
  });
});

describe('score combination', () => {
  it('weights sum to 1', () => {
    expect(WEIGHTS.pixel + WEIGHTS.ssim + WEIGHTS.layout + WEIGHTS.typography).toBeCloseTo(1, 10);
  });

  it('combines viewports 60/40', () => {
    const v = (viewport: 'desktop' | 'mobile', score: number) => ({ viewport, score }) as ViewportScore;
    expect(combineViewportScores([v('desktop', 100), v('mobile', 50)])).toBe(80);
    expect(combineViewportScores([v('desktop', 90)])).toBe(90);
    expect(combineViewportScores([])).toBe(0);
  });
});
