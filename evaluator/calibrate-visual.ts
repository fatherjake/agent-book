/**
 * Visual-score calibration.
 *
 *   tsx evaluator/calibrate-visual.ts
 *
 * Scores the reference app (must be ≥ 99) and deliberately degraded variants of it (CSS injected
 * after load, so layout/typography measurements see the degraded page too), plus the bare starter.
 * Writes evaluator/visual-calibration.json; the numbers are quoted in VISUAL_SCORING.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { launchApp } from './app-launcher.js';
import { REPO_ROOT } from './fixtures.js';
import { runVisualTests } from './visual-tests.js';

export const DEGRADED_VARIANTS: Record<string, string> = {
  'dark-theme': `body{background:#111827!important;color:#f9fafb!important}.card{background:#1f2937!important;border-color:#374151!important}.app h1,.todo-title{color:#f9fafb!important}`,
  'accent-green': `.btn-primary{background:#16a34a!important;border-color:#16a34a!important}.toggle{accent-color:#16a34a!important}.filter[aria-pressed='true']{background:#f0fdf4!important;border-color:#bbf7d0!important;color:#15803d!important}`,
  'shift-down-32px': `.app{transform:translateY(32px)!important}`,
  'narrow-480px': `.app{max-width:480px!important}`,
  'font-arial': `*{font-family:Arial,sans-serif!important}`,
  'larger-text': `.todo-title{font-size:18px!important}.app h1{font-size:36px!important}`,
  'no-card-border-radius-4': `.card{border-radius:4px!important}`,
  'tighter-rows': `.todo-item{min-height:48px!important;padding:8px 16px!important}`,
  'shift-4px': `.app{transform:translateY(4px)!important}`,
  'shift-2px': `.app{transform:translateY(2px)!important}`,
  'shift-1px': `.app{transform:translateY(1px)!important}`,
  'add-button-wider-4px': `.btn-primary{padding:0 22px!important}`,
  'text-color-gray-700': `.todo-title,.app h1{color:#374151!important}`,
  'unstyled': '__REMOVE_STYLES__',
};

async function main(): Promise<void> {
  const image = (await (await import('../benchmark/docker/image.js')).ensureImage()).image;
  const outDir = path.join(REPO_ROOT, 'results', 'visual-calibration');
  const results: Record<string, { score: number; desktop: unknown; mobile: unknown }> = {};
  const browser = await chromium.launch();
  try {
    const ref = await launchApp({ appDir: path.join(REPO_ROOT, 'evaluator', 'reference-app'), runId: 'visual-calibration', image });
    try {
      for (const name of ['reference', ...Object.keys(DEGRADED_VARIANTS)]) {
        const css = DEGRADED_VARIANTS[name];
        const mutatePage = css
          ? async (page: Page) => {
              if (css === '__REMOVE_STYLES__') {
                await page.evaluate(() => document.querySelectorAll('style,link[rel=stylesheet]').forEach((n) => n.remove()));
              } else {
                await page.addStyleTag({ content: css });
              }
              await page.evaluate(() => document.fonts.ready);
            }
          : undefined;
        const r = await runVisualTests({ app: ref, browser, screenshotDir: path.join(outDir, name), mutatePage });
        results[name] = { score: r.visualScore, desktop: summarize(r.viewports[0]), mobile: summarize(r.viewports[1]) };
        console.log(`${name.padEnd(24)} ${r.visualScore.toFixed(2)}  ${JSON.stringify(results[name].desktop)}`);
      }
    } finally {
      await ref.stop();
    }
    const starter = await launchApp({ appDir: path.join(REPO_ROOT, 'benchmark', 'starter'), runId: 'visual-calibration-starter', image, readyTimeoutMs: 30_000, readyPath: '/' }).catch(
      (e) => e as Error,
    );
    if (starter instanceof Error) {
      console.log(`starter                  (does not start: ${starter.message}) → visual score 0 by definition`);
      results['starter'] = { score: 0, desktop: null, mobile: null };
    } else {
      try {
        const r = await runVisualTests({ app: starter, browser, screenshotDir: path.join(outDir, 'starter') });
        results['starter'] = { score: r.visualScore, desktop: summarize(r.viewports[0]), mobile: summarize(r.viewports[1]) };
        console.log(`starter                  ${r.visualScore.toFixed(2)}`);
      } finally {
        await starter.stop();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(REPO_ROOT, 'evaluator', 'visual-calibration.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n',
  );
}

function summarize(v: { score: number; pixel: number; ssim: number; layout: number; typography: number; raw: unknown } | undefined) {
  return v ? { score: v.score, pixel: v.pixel, ssim: v.ssim, layout: v.layout, typography: v.typography, raw: v.raw } : null;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
