/**
 * Playwright helpers built ONLY on the accessibility contract (docs/ARCHITECTURE.md):
 * roles + accessible names, never CSS classes of the generated app.
 */
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from 'playwright';
import type { LaunchedApp } from './app-launcher.js';
import { compareDbToApi } from './backend-tests.js';
import { assert, AssertionFailure, waitFor } from './checks.js';
import { apiList, type ApiTodo, type FixtureTodo } from './fixtures.js';

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** Exact capture settings from ARCHITECTURE.md "Visual contract" (shared with generate-design). */
export function contextOptions(viewport: ViewportName): BrowserContextOptions {
  return {
    viewport: { ...VIEWPORTS[viewport] },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  };
}

export async function openPage(
  browser: Browser,
  url: string,
  viewport: ViewportName = 'desktop',
  opts: { beforeGoto?: (page: Page) => Promise<void>; actionTimeoutMs?: number } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(contextOptions(viewport));
  context.setDefaultTimeout(opts.actionTimeoutMs ?? 5000);
  context.setDefaultNavigationTimeout(20_000);
  const page = await context.newPage();
  if (opts.beforeGoto) await opts.beforeGoto(page);
  return { context, page };
}

export const todoList = (page: Page): Locator => page.getByRole('list', { name: 'Todo list', exact: true });
export const newTodoInput = (page: Page): Locator => page.getByRole('textbox', { name: 'New todo', exact: true });
export const addButton = (page: Page): Locator => page.getByRole('button', { name: 'Add', exact: true });
export const toggle = (page: Page, title: string): Locator =>
  page.getByRole('checkbox', { name: `Toggle ${title}`, exact: true });
export const editButton = (page: Page, title: string): Locator =>
  page.getByRole('button', { name: `Edit ${title}`, exact: true });
export const deleteButton = (page: Page, title: string): Locator =>
  page.getByRole('button', { name: `Delete ${title}`, exact: true });
export const editInput = (page: Page): Locator => page.getByRole('textbox', { name: 'Edit title', exact: true });
export const filterButton = (page: Page, name: 'All' | 'Active' | 'Completed'): Locator =>
  page.getByRole('button', { name, exact: true });
export const alertBox = (page: Page): Locator => page.getByRole('alert');

export interface UiTodo {
  title: string;
  completed: boolean;
}

/**
 * Visible todos, in DOM order, read from the accessibility tree of the "Todo list" list:
 * each item's checkbox named "Toggle <title>" and its checked state.
 */
export async function uiTodos(page: Page): Promise<UiTodo[]> {
  const list = todoList(page);
  if ((await list.count()) === 0) return [];
  const snap = await list.first().ariaSnapshot({ timeout: 5000 });
  const out: UiTodo[] = [];
  for (const line of snap.split('\n')) {
    const m = /- checkbox "((?:[^"\\]|\\.)*)"(.*)$/.exec(line);
    if (!m) continue;
    let name: string;
    try {
      name = JSON.parse(`"${m[1]}"`);
    } catch {
      name = m[1];
    }
    if (!name.startsWith('Toggle ')) continue;
    out.push({ title: name.slice('Toggle '.length), completed: /\[checked(=true)?\]/.test(m[2]) });
  }
  return out;
}

export const fmtUi = (t: UiTodo[] | undefined) =>
  JSON.stringify((t ?? []).map((x) => `${x.completed ? '[x]' : '[ ]'} ${x.title}`));

/** Wait until the visible list equals `expected` (titles + completion, in order). */
export async function expectUi(page: Page, expected: UiTodo[], what: string, timeoutMs = 5000): Promise<void> {
  const want = fmtUi(expected);
  await waitFor(async () => fmtUi(await uiTodos(page)) === want, `${what}: UI list should be ${want}`, {
    timeoutMs,
    describe: () => 'see below',
  }).catch(async (e) => {
    throw new AssertionFailure(`${(e as Error).message.replace(/ \(last: see below\)$/, '')}; got ${fmtUi(await uiTodos(page).catch(() => []))}`);
  });
}

/** Wait for the initial load to finish: no role=status loading indicator and the list rendered. */
export async function waitForLoaded(page: Page, expectedCount: number, timeoutMs = 10_000): Promise<void> {
  if (expectedCount > 0) {
    await waitFor(async () => (await uiTodos(page)).length === expectedCount, `app should render ${expectedCount} todos after loading`, {
      timeoutMs,
      describe: () => '',
    }).catch(async () => {
      throw new AssertionFailure(
        `app should render ${expectedCount} todos after loading; rendered ${fmtUi(await uiTodos(page).catch(() => []))}`,
      );
    });
  } else {
    await waitFor(
      async () => (await newTodoInput(page).count()) > 0 && (await page.getByRole('status').filter({ hasText: /load/i }).count()) === 0,
      'app should finish loading (New todo input present, no loading status)',
      { timeoutMs },
    );
  }
}

/** True if the title text of a visible item is rendered with line-through. */
export async function hasLineThrough(page: Page, title: string): Promise<boolean> {
  const item = page.getByRole('listitem').filter({ has: toggle(page, title) });
  return item.first().evaluate((li, t) => {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!(node.textContent ?? '').includes(t)) continue;
      for (let el = node.parentElement; el && el !== li.parentElement; el = el.parentElement) {
        if (getComputedStyle(el).textDecorationLine.includes('line-through')) return true;
      }
    }
    return false;
  }, title);
}

/** The "N item(s) left" counter text, or null. */
export async function counterText(page: Page): Promise<string | null> {
  const loc = page.getByText(/^\s*\d+\s+items?\s+left\s*$/);
  if ((await loc.count()) === 0) return null;
  return ((await loc.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

export const expectedCounter = (n: number) => `${n} ${n === 1 ? 'item' : 'items'} left`;

export async function expectCounter(page: Page, activeCount: number, what: string): Promise<void> {
  const want = expectedCounter(activeCount);
  await waitFor(async () => (await counterText(page)) === want, `${what}: counter should read "${want}"`, {
    describe: () => '',
  }).catch(async () => {
    throw new AssertionFailure(`${what}: counter should read "${want}", got ${JSON.stringify(await counterText(page))}`);
  });
}

export async function pressedFilter(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const f of ['All', 'Active', 'Completed'] as const) {
    const b = filterButton(page, f);
    if ((await b.count()) && (await b.first().getAttribute('aria-pressed')) === 'true') out.push(f);
  }
  return out;
}

/** Visible role=alert with non-empty text. */
export async function visibleAlertText(page: Page): Promise<string | null> {
  const alerts = alertBox(page);
  const n = await alerts.count();
  for (let i = 0; i < n; i++) {
    const a = alerts.nth(i);
    if (await a.isVisible()) {
      const text = ((await a.textContent()) ?? '').trim();
      if (text) return text;
    }
  }
  return null;
}

export async function expectAlert(page: Page, what: string, timeoutMs = 5000): Promise<string> {
  return (await waitFor(() => visibleAlertText(page), `${what}: a visible role="alert" with a message should appear`, { timeoutMs }))!;
}

/**
 * Independent backend verification: the API (from the host) AND the DB both hold exactly
 * `expected` (titles + completion, in API order) and agree with each other.
 */
export async function expectBackend(
  app: LaunchedApp,
  expected: FixtureTodo[],
  what: string,
  timeoutMs = 5000,
): Promise<ApiTodo[]> {
  const want = JSON.stringify(expected.map((t) => [t.title, t.completed]));
  let last: ApiTodo[] = [];
  await waitFor(
    async () => {
      last = await apiList(app.url);
      return JSON.stringify(last.map((t) => [t.title, t.completed])) === want;
    },
    `${what}: API state should be ${want}`,
    { timeoutMs, describe: () => `got ${JSON.stringify(last.map((t) => [t.title, t.completed]))}` },
  );
  const rows = await app.readDb();
  const diff = compareDbToApi(rows, last);
  assert(!diff, `${what}: DB disagrees with API: ${diff}`);
  return last;
}
