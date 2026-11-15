/**
 * Playwright helpers for the Mastodon web UI checks.
 */
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { AssertionFailure, waitFor } from '../../checks.js';

export const UI_VIEWPORT = { width: 1440, height: 900 };

export interface UiSession {
  context: BrowserContext;
  page: Page;
  /** Console errors / page errors seen so far (for messages). */
  errors: string[];
}

/** New browser context + sign in through the regular form (/auth/sign_in). */
export async function signIn(browser: Browser, baseUrl: string, email: string, password: string): Promise<UiSession> {
  const context = await browser.newContext({ viewport: UI_VIEWPORT, locale: 'en-US', baseURL: baseUrl });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(90_000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => void d.accept().catch(() => undefined));
  await page.goto('/auth/sign_in', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="user[email]"]').fill(email);
  await page.locator('input[name="user[password]"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/auth/sign_in'), { timeout: 90_000 }),
    page.locator('form button[type="submit"], form input[type="submit"]').first().click(),
  ]);
  if (page.url().includes('/auth/sign_in')) throw new AssertionFailure('sign-in did not succeed (still on /auth/sign_in)');
  return { context, page, errors };
}

/** Open a web UI route (e.g. '/web/timelines/home') and wait for the React app to mount. */
export async function openWeb(s: UiSession, route: string): Promise<void> {
  await s.page.goto(route, { waitUntil: 'domcontentloaded' });
  await waitForApp(s.page);
}

export async function waitForApp(page: Page): Promise<void> {
  await waitFor(async () => (await page.locator('.ui, .columns-area').count()) > 0, 'web UI did not mount (.ui / .columns-area not found)', {
    timeoutMs: 60_000,
    intervalMs: 300,
  });
}

/** The status <article> (or status wrapper) containing `text`, waiting until it is visible. */
export async function statusArticle(page: Page, text: string, timeoutMs = 45_000): Promise<Locator> {
  const loc = page.locator('article').filter({ hasText: text }).first();
  await waitFor(async () => loc.isVisible(), `status "${text}" is not shown`, { timeoutMs, intervalMs: 300 });
  return loc;
}

export async function screenshot(page: Page, dir: string, name: string): Promise<string> {
  const file = path.join(dir, `${name.replace(/[^a-z0-9_.-]/gi, '_')}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}

export async function closeSession(s: UiSession | null | undefined): Promise<void> {
  await s?.context.close().catch(() => undefined);
}
