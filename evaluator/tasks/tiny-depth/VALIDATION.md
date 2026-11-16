# tiny-depth: evaluator validation (2026-11-15)

Image `frugal-task-tiny:5e63c921…` (tiny `f14513a`, checkpoint commit `f2045a0`). Command:
`npx tsx evaluator/tasks/tiny-common/cli.ts tiny-depth (--reference | --bare | --patch <file>) [--suite holdout]`.

| Patch | Suite | Mandatory | Optional | Visual | Passed | Wall |
|---|---|---|---|---|---|---|
| reference (`reference.diff`) | dev | 17/17 | 1/1 | 100.00 | yes | 65 s |
| reference (`reference.diff`) | holdout | 17/17 | 1/1 | 100.00 | yes | 64 s |
| bare checkpoint (empty patch) | dev | 6/17 | 0/1 | 0 | no | 163 s |

The bare checkpoint passes startup (patch, build, app) and regression (vitest, 116 pytest tests) and fails every
feature check (`ui.depth.*` except `ui.no_page_errors`, and `visual.depth`), as required.

## Visual threshold calibration

The visual references are the reference implementation's own screenshots (`visual/<suite>-{rest,hover}.png`,
written with `FRUGAL_TINY_WRITE_REFERENCE=1`). Two variants of the reference were scored on the dev suite:

| Variant | Functional | Visual |
|---|---|---|
| A: follows the spec, different details (tooltip at the bottom, 2 px lines, 20% headroom, no crosshair) | 16/16 pass | 63.73 |
| B: off-design (blue/orange lines, no fill, no centre line, dark tooltip) | 16/16 pass | 37.55 |

Initial gate 50. The first real baseline runs (2026-11-15, 3 runs, all passing) scored 93.9, 92.4 and 88.2,
far closer to the reference than variant A, so the gate was raised to **75**
(`FRUGAL_TINY_DEPTH_VISUAL_THRESHOLD`): above variant A and B, with ~13 points of margin below the baseline.

## Notes

* The functional checks pin the book (fixtures in `fixtures.ts`), hover at positions at least 4 px away from
  every level and the centre, and compare the tooltip with expectations computed from the spec's rules, so
  presentation choices (variant A) don't fail them.
* `ui.depth.live_sim` uses the real sim with 20 bots (no pinned data).
* The page may only reach the app's own origin; everything else is aborted.

## Structural visual metric (2026-11-16)

The pixel-level score proved too literal: two lab runs whose charts look identical to the design scored
53 and 59 because the chart was drawn 3-4 px taller/offset, while the session's own runs sat at 78-86,
just above the gate. The visual score is now structural (colour layout at 1/6 resolution + SSIM at scales
8 and 16, see visual.ts); the pixel-level score is kept in the report details for reference.

| Screenshots | Pixel-level | Structural |
|---|---|---|
| reference | 100 | 100 |
| 12 lab runs (sess-0001 and its suggestions) | 53 – 90 | 86 – 98 |
| the two runs that look identical to the design | 53, 59 | 86, 87 |
| variant A (follows the spec, different details) | 64 | 85 |
| variant B (off-design colours, no fills) | 38 | 65 |

Gate unchanged at **75**: between off-design (65) and every faithful implementation (85+). Existing runs
were re-graded from their saved screenshots (`npm run lab -- regrade`).
