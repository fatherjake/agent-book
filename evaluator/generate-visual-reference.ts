/**
 * Generate evaluator/visual-reference.json: key-element bounding boxes and typography of the hidden
 * reference app rendered with the "design" fixtures (filter All), at both viewports, using the same
 * capture settings as design.png.
 *
 *   tsx evaluator/generate-visual-reference.ts [--force]
 *
 * Like design.png, this file is generated once and then frozen (refuses to overwrite without --force).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchApp } from './app-launcher.js';
import { loadDesignFixtures, REPO_ROOT, seedTodos } from './fixtures.js';
import { captureDesignState, DESIGN_FILES, readPng, scoreViewport, VISUAL_REFERENCE_PATH, type VisualReference } from './visual-tests.js';

async function resolveImage(): Promise<string> {
  const mod = await import('../benchmark/docker/image.js');
  return (await mod.ensureImage()).image;
}

async function main(): Promise<void> {
  if (fs.existsSync(VISUAL_REFERENCE_PATH) && !process.argv.includes('--force')) {
    console.error(`${path.relative(REPO_ROOT, VISUAL_REFERENCE_PATH)} exists (frozen). Pass --force to regenerate.`);
    process.exit(1);
  }
  const image = await resolveImage();
  const fixtures = loadDesignFixtures();
  const app = await launchApp({ appDir: path.join(REPO_ROOT, 'evaluator', 'reference-app'), runId: 'visual-reference', image });
  const browser = await chromium.launch();
  try {
    await seedTodos(app.url, fixtures);
    const ref: VisualReference = {
      generatedAt: new Date().toISOString(),
      source: 'evaluator/reference-app with benchmark/spec/fixtures.json "design" set, filter All',
      viewports: {} as VisualReference['viewports'],
    };
    for (const v of ['desktop', 'mobile'] as const) {
      const cap = await captureDesignState(browser, app.url, v, fixtures);
      ref.viewports[v] = cap.layout;
      const missing = Object.entries(cap.layout.boxes).filter(([, b]) => !b).map(([k]) => k);
      if (missing.length) throw new Error(`reference app is missing elements at ${v}: ${missing.join(', ')}`);
      const s = scoreViewport(v, cap.png, cap.layout, cap.layout, readPng(DESIGN_FILES[v]));
      console.log(`${v}: reference-vs-design.png pixel=${s.pixel} ssim=${s.ssim} (raw mismatch ${s.raw.mismatched}px)`);
    }
    fs.writeFileSync(VISUAL_REFERENCE_PATH, JSON.stringify(ref, null, 2) + '\n');
    console.log(`wrote ${path.relative(REPO_ROOT, VISUAL_REFERENCE_PATH)}`);
  } finally {
    await browser.close();
    await app.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
