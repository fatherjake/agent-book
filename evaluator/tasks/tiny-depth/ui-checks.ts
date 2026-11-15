/**
 * HIDDEN UI checks for task tiny-depth. Each check traces to a § of
 * benchmark/tasks/tiny-depth/spec/feature.md (in its comment).
 *
 * Pinned data: the page talks to the real sim through the forwarder, except that `GET /book/*` is
 * answered with the current fixture and the sim's own WebSocket `book` frames are dropped and
 * replaced with fixture frames (every other frame and request passes through untouched). So the
 * depth chart sees exactly the book the expectations are computed from.
 */
import type { Browser, BrowserContext, Locator, Page, WebSocketRoute } from 'playwright';
import { assert } from '../../checks.js';
import type { TaskCheck, TinyCheckContext } from '../tiny-common/evaluate.js';
import { emptyBook, expected, levelAt, SUITES, tooltipParts, usd, type Book, type Expected } from './fixtures.js';

const UI = 'functional' as const;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export interface DepthPage {
  context: BrowserContext;
  page: Page;
  /** Replace the pinned book (served by GET /book and pushed as a WebSocket frame). */
  setBook: (b: Book) => Promise<void>;
  errors: string[];
  close: () => Promise<void>;
}

/** Uncaught page errors seen by any page this evaluation opened (checked by ui.no_page_errors). */
function pageErrorsOf(ctx: TinyCheckContext): string[] {
  if (!Array.isArray(ctx.state.pageErrors)) ctx.state.pageErrors = [];
  return ctx.state.pageErrors as string[];
}

export async function openPage(ctx: TinyCheckContext, book: Book | null, viewport = SUITES[ctx.suite].viewport): Promise<DepthPage> {
  const context = await ctx.browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  // Only the app under test is reachable: anything else (wallet SDKs, fonts, telemetry) is aborted.
  const origin = new URL(ctx.url).origin;
  await context.route(
    (u) => u.origin !== origin,
    (route) => route.abort('blockedbyclient'),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(String(e.message ?? e));
    pageErrorsOf(ctx).push(String(e.message ?? e));
  });
  let current = book;
  const clients: WebSocketRoute[] = [];
  if (book) {
    await page.route('**/book/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }));
    await page.routeWebSocket('**/ws', (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => {
        try {
          if (typeof msg === 'string' && JSON.parse(msg)?.type === 'book') return;
        } catch {
          /* not JSON: pass through */
        }
        ws.send(msg);
      });
      clients.push(ws);
      if (current) ws.send(JSON.stringify({ type: 'book', ...current }));
    });
  }
  await page.goto(ctx.url + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: 'Order Book', exact: true }).waitFor({ timeout: 30_000 });
  const setBook = async (b: Book) => {
    current = b;
    for (const ws of clients) ws.send(JSON.stringify({ type: 'book', ...b }));
    await page.waitForTimeout(300);
  };
  if (book) {
    // The REST book arrives after the first candles/trades load; wait until it has been requested.
    await page.waitForResponse((r) => r.url().includes('/book/'), { timeout: 30_000 }).catch(() => undefined);
    await setBook(book);
  }
  return { context, page, setBook, errors, close: () => context.close() };
}

const depthTab = (page: Page) => page.getByRole('button', { name: 'Depth', exact: true });
const chart = (page: Page) => page.getByRole('img', { name: 'Depth chart', exact: true });

async function showDepth(page: Page): Promise<Locator> {
  await depthTab(page).click({ timeout: 10_000 });
  const c = chart(page);
  await c.waitFor({ state: 'visible', timeout: 10_000 });
  return c;
}

async function plotBox(c: Locator) {
  const b = await c.boundingBox();
  assert(b && b.width >= 150 && b.height >= 80, `the Depth chart plot is too small or not laid out (${b ? `${b.width}x${b.height}` : 'no box'}); expected at least 150x80 px`);
  return b;
}

async function tooltipText(page: Page): Promise<string | null> {
  const tips = page.getByRole('tooltip');
  try {
    await tips.first().waitFor({ state: 'visible', timeout: 1500 });
  } catch {
    return null;
  }
  const n = await tips.count();
  const texts: string[] = [];
  for (let i = 0; i < n; i++) if (await tips.nth(i).isVisible()) texts.push(norm(await tips.nth(i).innerText()));
  return texts.join(' | ');
}

const esc = (s: string) => s.replace(/[$.,]/g, (m) => `\\${m}`);
/**
 * A tooltip part as a standalone token: `Bid`/`Ask` not followed by a lowercase letter (so
 * "BidPrice" from adjacent elements still counts), amounts not glued to further digits.
 */
function partRe(p: string): RegExp {
  if (p === 'Bid' || p === 'Ask') return new RegExp(`(?<![A-Za-z])${p}(?![a-z])`);
  return new RegExp(`(?<![\\d.,])${esc(p)}(?![\\d,])`);
}

/** Sample x positions (CSS px from the plot's left edge) that are >= 4 px away from every level and the centre. */
function samplePoints(e: Expected, width: number, side: 'bid' | 'ask', max = 9): number[] {
  const toX = (p: bigint) => ((Number(p) - Number(e.lo)) / Number(e.hi - e.lo)) * width;
  const forbidden = [...e.bids, ...e.asks].map((s) => toX(s.price)).concat([width / 2]);
  const ok: number[] = [];
  const [from, to] = side === 'bid' ? [3, width / 2 - 3] : [width / 2 + 3, width - 3];
  for (let x = Math.ceil(from); x <= to; x++) if (forbidden.every((f) => Math.abs(f - x) >= 4)) ok.push(x);
  if (ok.length <= max) return ok;
  // Spread the picks over distinct levels: bucket by the expected level, take the middle of each run.
  const runs: number[][] = [];
  let lastKey = '';
  for (const x of ok) {
    const s = levelAt(e, Number(e.lo) + (x / width) * Number(e.hi - e.lo));
    const key = s ? `${s.side}${s.price}` : '-';
    if (key !== lastKey) runs.push([]);
    runs[runs.length - 1].push(x);
    lastKey = key;
  }
  const mids = runs.map((r) => r[Math.floor(r.length / 2)]);
  if (mids.length <= max) return mids;
  const pick: number[] = [];
  for (let i = 0; i < max; i++) pick.push(mids[Math.round((i * (mids.length - 1)) / (max - 1))]);
  return [...new Set(pick)];
}

async function hoverAndCheck(page: Page, c: Locator, e: Expected, side: 'bid' | 'ask'): Promise<string> {
  const b = await plotBox(c);
  const xs = samplePoints(e, b.width, side);
  assert(xs.length >= 3, `the plot is too narrow to tell the ${side} levels apart (${b.width.toFixed(0)} px wide)`);
  const failures: string[] = [];
  for (const x of xs) {
    const price = Number(e.lo) + (x / b.width) * Number(e.hi - e.lo);
    const want = levelAt(e, price)!;
    await page.mouse.move(b.x + x, b.y + b.height * 0.55);
    const text = await tooltipText(page);
    const parts = tooltipParts(want);
    const missing = text == null ? parts : parts.filter((p) => !partRe(p).test(text));
    if (missing.length)
      failures.push(`at x=${x}px (price ${usd(BigInt(Math.round(price)))}): expected a tooltip with ${parts.join(' / ')}, got ${text == null ? 'no visible tooltip' : JSON.stringify(text.slice(0, 160))}`);
  }
  assert(failures.length === 0, `${failures.length} of ${xs.length} hover positions wrong:\n${failures.slice(0, 4).join('\n')}`);
  return `${xs.length} hover positions matched the expected ${side} levels`;
}

async function withPage<T>(ctx: TinyCheckContext, book: Book | null, fn: (p: DepthPage) => Promise<T>): Promise<T> {
  const p = await openPage(ctx, book);
  try {
    return await fn(p);
  } finally {
    await p.close().catch(() => undefined);
  }
}

const fx = (ctx: TinyCheckContext) => SUITES[ctx.suite];

export const uiChecks: TaskCheck[] = [
  {
    // §1: a "Depth" tab directly after "Order Book"; the order book stays the default view.
    spec: { id: 'ui.depth.tab', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page }) => {
        const tab = depthTab(page);
        await tab.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        assert(await tab.isVisible(), 'no visible button named "Depth" in the order book card');
        const order = await page.evaluate(() => {
          const ob = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Order Book');
          const bar = ob?.parentElement;
          return bar ? [...bar.querySelectorAll(':scope > button')].map((b) => b.textContent?.trim() ?? '') : [];
        });
        const i = order.indexOf('Order Book');
        assert(i >= 0 && order[i + 1] === 'Depth', `expected the tab bar to read "Order Book", "Depth", ... in that order; got ${JSON.stringify(order)}`);
        assert(!(await chart(page).isVisible().catch(() => false)), 'the Depth chart is visible before the Depth tab was selected (Order Book must stay the default)');
        return `tabs: ${order.join(', ')}`;
      }),
  },
  {
    // §2: selecting the tab shows the plot (role img, name "Depth chart").
    spec: { id: 'ui.depth.render', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page }) => {
        const c = await showDepth(page);
        const b = await plotBox(c);
        return `plot ${b.width.toFixed(0)}x${b.height.toFixed(0)} px`;
      }),
  },
  {
    // §2: the summary row shows Mid and Spread like the order book's spread row.
    spec: { id: 'ui.depth.summary', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page }) => {
        await showDepth(page);
        const e = expected(fx(ctx).main)!;
        const panel = norm(await page.locator('body').innerText());
        const want = [usd(e.mid!), usd(e.spread!)];
        assert(/\bMid\b/.test(panel), 'no "Mid" label on the page');
        for (const w of want) assert(panel.includes(w), `expected ${w} (mid ${usd(e.mid!)}, spread ${usd(e.spread!)}) in the depth view`);
        return `Mid ${usd(e.mid!)}, Spread ${usd(e.spread!)}`;
      }),
  },
  {
    // §3, §4: hovering the bid side shows the bid level in effect at that price.
    spec: { id: 'ui.depth.hover_bids', category: UI, mandatory: true },
    run: (ctx) => withPage(ctx, fx(ctx).main, async ({ page }) => hoverAndCheck(page, await showDepth(page), expected(fx(ctx).main)!, 'bid')),
  },
  {
    // §3, §4: hovering the ask side shows the ask level in effect at that price.
    spec: { id: 'ui.depth.hover_asks', category: UI, mandatory: true },
    run: (ctx) => withPage(ctx, fx(ctx).main, async ({ page }) => hoverAndCheck(page, await showDepth(page), expected(fx(ctx).main)!, 'ask')),
  },
  {
    // §4: the tooltip disappears when the pointer leaves the plot.
    spec: { id: 'ui.depth.hover_leave', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page }) => {
        const c = await showDepth(page);
        const b = await plotBox(c);
        await page.mouse.move(b.x + b.width * 0.25, b.y + b.height / 2);
        assert((await tooltipText(page)) != null, 'no visible tooltip while hovering the plot');
        await page.mouse.move(b.x + b.width / 2, Math.max(1, b.y - 60));
        await page.waitForTimeout(400);
        const left = await tooltipText(page);
        assert(left == null, `a tooltip is still visible after the pointer left the plot: ${JSON.stringify(left?.slice(0, 120))}`);
      }),
  },
  {
    // §5: live updates: a new book frame redraws the chart and rescales the axis.
    spec: { id: 'ui.depth.live_update', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page, setBook }) => {
        const c = await showDepth(page);
        await setBook(fx(ctx).update);
        await page.waitForTimeout(500);
        const e = expected(fx(ctx).update)!;
        const a = await hoverAndCheck(page, c, e, 'bid');
        const b = await hoverAndCheck(page, c, e, 'ask');
        const panel = norm(await page.locator('body').innerText());
        assert(panel.includes(usd(e.mid!)), `after the update the view does not show the new mid ${usd(e.mid!)}`);
        return `after update: ${a}; ${b}`;
      }),
  },
  {
    // §6: an empty book shows "No liquidity" and no tooltip.
    spec: { id: 'ui.depth.empty', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page, setBook }) => {
        await showDepth(page);
        await setBook(emptyBook());
        const msg = page.getByText('No liquidity', { exact: true });
        await msg.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
        assert(await msg.first().isVisible(), 'an empty book does not show "No liquidity"');
        const box = await page.getByRole('button', { name: 'Depth', exact: true }).evaluate((el) => {
          const card = el.closest('section') ?? el.parentElement!.parentElement!;
          const r = card.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        for (const fx2 of [0.25, 0.5, 0.75]) {
          await page.mouse.move(box.x + box.w * fx2, box.y + box.h * 0.5);
          const t = await tooltipText(page);
          assert(t == null, `a tooltip is shown for an empty book: ${JSON.stringify(t?.slice(0, 120))}`);
        }
      }),
  },
  {
    // §6 (one side): the axis centres on the best price of the side that is present; hovering it works.
    spec: { id: 'ui.depth.one_sided', category: UI, mandatory: false },
    run: (ctx) =>
      withPage(ctx, fx(ctx).oneSided, async ({ page }) => {
        const c = await showDepth(page);
        const e = expected(fx(ctx).oneSided)!;
        return hoverAndCheck(page, c, e, e.bids.length ? 'bid' : 'ask');
      }),
  },
  {
    // §1: the Order Book tab still works after visiting Depth.
    spec: { id: 'ui.depth.book_tab_intact', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, fx(ctx).main, async ({ page }) => {
        await showDepth(page);
        await page.getByRole('button', { name: 'Order Book', exact: true }).click();
        const best = usd(BigInt(fx(ctx).main.best_ask!));
        await page.getByText(best, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
        assert(await page.getByText(best, { exact: true }).first().isVisible(), `the Order Book tab no longer shows the book (best ask ${best} not visible)`);
        assert(!(await chart(page).isVisible().catch(() => false)), 'the Depth chart is still visible on the Order Book tab');
      }),
  },
  {
    // §5: with the real sim (no pinned data) the chart renders and responds to hovering.
    spec: { id: 'ui.depth.live_sim', category: UI, mandatory: true },
    run: (ctx) =>
      withPage(ctx, null, async ({ page }) => {
        await depthTab(page).click({ timeout: 10_000 });
        const c = chart(page);
        await c.waitFor({ state: 'visible', timeout: 45_000 });
        const b = await plotBox(c);
        let text: string | null = null;
        for (const fx2 of [0.2, 0.3, 0.7, 0.8]) {
          await page.mouse.move(b.x + b.width * fx2, b.y + b.height / 2);
          text = await tooltipText(page);
          if (text) break;
        }
        assert(text && /(?<![A-Za-z])(Bid|Ask)(?![a-z])/.test(text) && /\$[\d,]+\.\d\d/.test(text), `hovering the live chart shows no Bid/Ask tooltip with a price (got ${JSON.stringify(text)})`);
        return `live tooltip: ${text!.slice(0, 100)}`;
      }),
  },
  {
    // General: no uncaught exceptions in any page opened by the checks above.
    spec: { id: 'ui.no_page_errors', category: UI, mandatory: true },
    run: async (ctx) => {
      const uniq = [...new Set(pageErrorsOf(ctx))];
      assert(uniq.length === 0, `uncaught page error(s): ${uniq.slice(0, 3).join(' | ')}`);
    },
  },
];

export type { Browser };
