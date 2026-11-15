# Visual scoring

Implementation: `evaluator/visual-tests.ts`. Calibration: `evaluator/calibrate-visual.ts` (writes
`evaluator/visual-calibration.json`). Pass threshold: `VISUAL_THRESHOLD = 95` in `evaluator/score.ts`.
Callers can make the threshold stricter, but a lower value is clamped up to 95.

## Capture

The capture settings are the same as `scripts/generate-design.ts` (ARCHITECTURE.md "Visual contract"):

* Playwright Chromium from the root `package.json`, with `deviceScaleFactor: 1`, `reducedMotion: 'reduce'`,
  `locale: 'en-US'`, `timezoneId: 'UTC'` and `colorScheme: 'light'`.
* Fresh DB. The `design` fixture set from `benchmark/spec/fixtures.json` is seeded through the API,
  and the filter is All.
* `goto(url, {waitUntil: 'networkidle'})`, then wait for the list to render (up to 10 s), then
  `document.fonts.ready`, then `screenshot({animations: 'disabled', caret: 'hide', fullPage: false})`.
* Viewports: desktop 1280×800 against `design.png`, and mobile 390×844 against `design-mobile.png`.

Each run writes `screenshots/visual-<viewport>.png` and `screenshots/visual-<viewport>-diff.png`. The
diff images come from pixelmatch: red marks a real difference and yellow marks anti-aliasing.

## Formula

For each viewport:

```
score_v = 100 × (0.35·P + 0.25·S + 0.25·L + 0.15·T)
visual  = 0.6·score_desktop + 0.4·score_mobile          (rounded to 2 decimals)
```

| Term | What it measures | How |
|---|---|---|
| **P**: pixel | exact colours/pixels | `pixelmatch(threshold 0.1, includeAA false)` flags differing pixels. A flagged pixel still counts as a match if some reference pixel within **1 px** has the same colour, using the YIQ distance ≤ 35215·0.1² (the 1 px position tolerance). Then `P = 1 − mismatched / inkPixels`, clamped to [0, 1]. `inkPixels` is the number of reference pixels that aren't one of its two dominant colours (page and card background). Normalising by ink rather than by the whole frame stops the large empty background from hiding real differences. |
| **S**: structure | perceptual / structural similarity | SSIM (Wang et al. 2004, L = 255, C1 = (0.01L)², C2 = (0.03L)²) on BT.601 grayscale, using 8×8 windows with stride 4. Windows that are flat in both images are skipped. **Multi-scale**: S is the mean SSIM over box-downsampling factors 2, 4 and 8. That makes it tolerant of sub-pixel jitter while still punishing real layout changes. |
| **L**: layout | position and size of key elements | Bounding boxes are found with role/name queries only: h1 `Todos`, textbox `New todo`, button `Add`, list `Todo list`, the counter text, the filter buttons, and each design item's checkbox, Edit and Delete buttons and row. They're compared with `evaluator/visual-reference.json`, which comes from the reference app. Per element `s = max(0, 1 − (|dx|+|dy|+|dw|+|dh|) / 48px)`, and a missing element scores 0. L is the mean. |
| **T**: typography | font family, size and weight | Computed `font-family` (primary family), `font-size` (±0.5 px) and `font-weight` of the heading, the input, Add, the counter, filter All, an Edit button and the item title text. These are compared with the reference, and T is the fraction that match. |

`evaluator/visual-reference.json` is generated once from the hidden reference app by
`tsx evaluator/generate-visual-reference.ts` and then frozen like `design.png`. Regenerating it needs `--force`.

## Calibration (2026-11-14, `tsx evaluator/calibrate-visual.ts`)

The degraded variants are the reference app with CSS injected after load. Layout and typography
are measured on the degraded page as well. The starter row is the bare `benchmark/starter`; its API
returns 501, so seeding fails and it is captured as is.

| Variant | Overall | Desktop (P, S, L, T) | Mobile |
|---|---|---|---|
| **reference** | **100.00** | 100 (1, 1, 1, 1) | 100 |
| no-card-border-radius-4 | 99.99 | 99.99 (1, 1, 1, 1) | 99.99 |
| add-button-wider-4px | 99.28 | 99.34 (0.992, 0.994, 0.991, 1) | 99.19 |
| shift-1px (translateY) | 97.64 | 97.74 (1, 0.931, 0.979, 1) | 97.5 |
| text-color-gray-700 | 97.27 | 97.27 (0.932, 0.985, 1, 1) | 97.26 |
| accent-green (primary colour changed) | 93.99 | 94.18 (0.834, 0.999, 1, 1) | 93.7 |
| shift-2px | 91.06 | 91.16 (0.89, 0.843, 0.958, 1) | 90.92 |
| font-arial | 88.10 | 88.52 (0.932, 0.903, 0.933, 0.667) | 87.47 |
| larger-text | 85.35 | 94.54 (0.938, 0.926, 1, 0.905) | 71.56 |
| shift-4px | 83.91 | 84.22 (0.815, 0.711, 0.917, 1) | 83.44 |
| tighter-rows | 72.16 | 70.74 (0.801, 0.57, 0.539, 1) | 74.29 |
| narrow-480px | 69.20 | 48.67 (0.562, 0.56, 0, 1) | 100 |
| starter (empty) | 47.61 | 49.9 (0.799, 0.878, 0, 0) | 44.17 |
| shift-down-32px | 47.13 | 48.76 (0.458, 0.376, 0.333, 1) | 44.68 |
| dark-theme (different colour scheme) | 42.87 | 43.63 (0, 0.145, 1, 1) | 41.73 |
| unstyled | 40.63 | 43.23 (0.526, 0.821, 0, 0.286) | 36.73 |

How to read it: the reference scores 100, because the design PNGs are pixel-identical to its
rendering. Imperceptible or 1 px deviations stay above 95. A changed accent colour, any global
shift of 2 px or more, a different font, or different type sizes fall below 95. Different colour
schemes, the empty starter and an unstyled page score below 50. So the 95 threshold effectively
requires following `design-tokens.md` exactly, within about 1 px.

The integration test `tests/evaluator/integration.docker.test.ts` runs the reference app through
the real pipeline and requires a score of at least 99. A broken copy (accent and background
recoloured) must score below 95.
