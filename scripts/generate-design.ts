/**
 * Generate the frozen reference design images from the hidden reference implementation.
 *
 *   npm run design:generate              refuses if benchmark/spec/FROZEN.json exists
 *   npm run design:generate -- --force   regenerate PNGs and rewrite FROZEN.json
 *   npm run design:generate -- --freeze-only --force   only re-hash the spec files
 *
 * Steps: ensure the benchmark image, run evaluator/reference-app in a fresh container (fresh DB),
 * seed the "design" fixture set through the API, capture design.png (1280x800) and
 * design-mobile.png (390x844) with host Playwright chromium, then write FROZEN.json containing
 * sha256 hashes of every spec file.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ensureImage } from '../benchmark/docker/image.js';
import { startAppContainer } from '../benchmark/docker/app-container.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specDir = path.join(root, 'benchmark', 'spec');
const frozenPath = path.join(specDir, 'FROZEN.json');
const referenceApp = path.join(root, 'evaluator', 'reference-app');

/** Capture settings shared with the evaluator's visual comparison (see docs/ARCHITECTURE.md). */
const CAPTURES = [
  { file: 'design.png', viewport: { width: 1280, height: 800 } },
  { file: 'design-mobile.png', viewport: { width: 390, height: 844 } },
] as const;

interface FixtureTodo {
  title: string;
  completed: boolean;
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function writeFrozen(): void {
  const files: Record<string, string> = {};
  for (const name of fs.readdirSync(specDir).sort()) {
    if (name === 'FROZEN.json' || name.startsWith('.')) continue;
    const p = path.join(specDir, name);
    if (fs.statSync(p).isFile()) files[name] = sha256File(p);
  }
  const frozen = {
    frozenAt: new Date().toISOString(),
    note: 'Reference spec and design are frozen. Do not edit these files during optimization experiments.',
    files,
  };
  fs.writeFileSync(frozenPath, JSON.stringify(frozen, null, 2) + '\n');
  console.log(`wrote ${path.relative(root, frozenPath)} (${Object.keys(files).length} files)`);
}

async function seed(baseUrl: string, todos: FixtureTodo[]): Promise<void> {
  for (const t of todos) {
    const res = await fetch(`${baseUrl}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t.title }),
    });
    if (res.status !== 201) throw new Error(`seed POST failed: ${res.status} ${await res.text()}`);
    const created = (await res.json()) as { id: number };
    if (t.completed) {
      const p = await fetch(`${baseUrl}/api/todos/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      if (p.status !== 200) throw new Error(`seed PATCH failed: ${p.status} ${await p.text()}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const freezeOnly = args.includes('--freeze-only');

  if (fs.existsSync(frozenPath) && !force) {
    console.error(
      'benchmark/spec is frozen (FROZEN.json exists). Refusing to overwrite the reference design.\n' +
        'Pass --force to regenerate deliberately (this invalidates comparisons with earlier experiments).',
    );
    process.exit(1);
  }
  if (freezeOnly) {
    writeFrozen();
    return;
  }

  const fixtures = JSON.parse(fs.readFileSync(path.join(specDir, 'fixtures.json'), 'utf8'));
  const designTodos: FixtureTodo[] = fixtures.sets.design.todos;

  const { image } = await ensureImage({ onLog: (c) => process.stderr.write(c) });
  console.log(`image ${image}`);
  const app = await startAppContainer({ image, appDir: referenceApp, name: `frugal-design-${Date.now()}` });
  const browser = await chromium.launch();
  try {
    console.log(`reference app at ${app.baseUrl}`);
    await seed(app.baseUrl, designTodos);

    for (const cap of CAPTURES) {
      const context = await browser.newContext({
        viewport: cap.viewport,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
      });
      const page = await context.newPage();
      await page.goto(app.baseUrl, { waitUntil: 'networkidle' });
      await page.locator('ul[aria-label="Todo list"] > li').nth(designTodos.length - 1).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const out = path.join(specDir, cap.file);
      await page.screenshot({ path: out, animations: 'disabled', caret: 'hide', fullPage: false });
      console.log(`wrote ${path.relative(root, out)} (${cap.viewport.width}x${cap.viewport.height})`);
      await context.close();
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  writeFrozen();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
