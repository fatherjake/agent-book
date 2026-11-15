/**
 * HIDDEN Playwright checks for mastodon-bookmarks (spec/feature.md §3). One signed-in session (seeded
 * user "uma") runs the flow in order; each step is its own check. A step whose precondition failed
 * fails with "not reached". Every UI action is verified independently through the REST API.
 */
import type { Page } from 'playwright';
import { assert, AssertionFailure, waitFor } from '../../checks.js';
import type { MastodonCheckContext, TaskCheck } from '../mastodon-common/evaluate.js';
import { asArray, expectStatus } from '../mastodon-common/http.js';
import { closeSession, openWeb, screenshot, signIn, statusArticle, type UiSession } from '../mastodon-common/ui.js';

interface Flow {
  session: UiSession | null;
  failed: string | null;
}
const flows = new WeakMap<object, Flow>();
const flowOf = (ctx: MastodonCheckContext): Flow => {
  let f = flows.get(ctx.seed);
  if (!f) flows.set(ctx.seed, (f = { session: null, failed: null }));
  return f;
};

const BOOKMARK = { name: 'Bookmark', exact: true } as const;

async function umaBookmarkIds(ctx: MastodonCheckContext): Promise<string[]> {
  const res = await ctx.api.get('/api/v1/bookmarks?limit=40', ctx.seed.tokens.uma_full);
  expectStatus(res, 200, 'GET /api/v1/bookmarks (uma)');
  return asArray<{ id: string }>(res, 'bookmarks').map((s) => String(s.id));
}

async function pressedState(page: Page, articleText: string): Promise<string | null> {
  const art = await statusArticle(page, articleText);
  const btn = art.getByRole('button', BOOKMARK);
  if ((await btn.count()) === 0) throw new AssertionFailure(`no button named "Bookmark" in the action bar of "${articleText}"`);
  return btn.first().getAttribute('aria-pressed');
}

async function expectPressed(page: Page, articleText: string, want: 'true' | 'false', what: string) {
  await waitFor(async () => (await pressedState(page, articleText)) === want, `${what}: Bookmark button should have aria-pressed="${want}"`, {
    timeoutMs: 15_000,
    describe: () => 'different aria-pressed',
  });
}

/** One step of the flow. `needsSession` steps fail fast when an earlier step broke the flow. */
function step(id: string, mandatory: boolean, body: (ctx: MastodonCheckContext, s: UiSession) => Promise<string | void>, opts: { first?: boolean; last?: boolean } = {}): TaskCheck {
  return {
    spec: { id, category: 'functional', mandatory },
    run: async (ctx) => {
      const flow = flowOf(ctx);
      try {
        if (opts.first) {
          await closeSession(flow.session);
          flow.failed = null;
          flow.session = await signIn(ctx.browser!, ctx.c.url, ctx.seed.users.uma.email, ctx.seed.password);
        }
        if (!flow.session) throw new AssertionFailure(`not reached: ${flow.failed ?? 'no signed-in session'}`);
        try {
          return await body(ctx, flow.session);
        } catch (e) {
          await screenshot(flow.session.page, ctx.screenshotDir, id);
          const errs = flow.session.errors.slice(-3).join(' | ');
          if (errs && e instanceof Error && !(e as Error).message.includes('pageerror')) (e as Error).message += ` [browser errors: ${errs}]`;
          throw e;
        }
      } catch (e) {
        if (opts.first) {
          flow.failed = `${id} failed`;
          await closeSession(flow.session);
          flow.session = null;
        }
        throw e;
      } finally {
        if (opts.last) {
          await closeSession(flow.session);
          flow.session = null;
        }
      }
    },
  };
}

export const uiChecks: TaskCheck[] = [
  // Sign in and see the seeded status in the home timeline (precondition; passes on the checkpoint).
  step(
    'ui.login',
    true,
    async (ctx, s) => {
      await openWeb(s, '/web/timelines/home');
      await statusArticle(s.page, ctx.seed.ui.toggle.text, 60_000);
    },
    { first: true },
  ),

  // §3.1: Bookmark button in status lists, aria-pressed, click bookmarks through the API.
  step('ui.bookmark.toggle', true, async (ctx, s) => {
    const text = ctx.seed.ui.toggle.text;
    await expectPressed(s.page, text, 'false', 'before clicking');
    const art = await statusArticle(s.page, text);
    await art.getByRole('button', BOOKMARK).first().click();
    await expectPressed(s.page, text, 'true', 'after clicking');
    await waitFor(async () => (await umaBookmarkIds(ctx)).includes(ctx.seed.ui.toggle.id), 'clicking Bookmark did not create a bookmark (GET /api/v1/bookmarks)', { timeoutMs: 15_000, intervalMs: 500 });
  }),

  // §3.1: the state survives a reload.
  step('ui.bookmark.persist', true, async (ctx, s) => {
    await openWeb(s, '/web/timelines/home'); // full page load = reload
    await expectPressed(s.page, ctx.seed.ui.toggle.text, 'true', 'after reloading the page');
  }),

  // §3.3 + §3.2: a "Bookmarks" link leads to /web/bookmarks, which lists the bookmark.
  step('ui.bookmarks.navigation', true, async (ctx, s) => {
    const page = s.page;
    let link = page.getByRole('link', { name: 'Bookmarks', exact: true });
    if (!(await link.first().isVisible().catch(() => false))) {
      await openWeb(s, '/web/getting-started');
      link = page.getByRole('link', { name: 'Bookmarks', exact: true });
    }
    await waitFor(async () => link.first().isVisible(), 'no visible link named "Bookmarks" (navigation panel or Getting started)', { timeoutMs: 20_000 });
    const href = (await link.first().getAttribute('href')) ?? '';
    assert(/\/bookmarks\/?$/.test(href), `the "Bookmarks" link points to ${href}, expected /web/bookmarks`);
    await link.first().click();
    await page.waitForURL(/\/web\/bookmarks\/?$/, { timeout: 20_000 });
    await waitFor(async () => page.getByRole('heading', { name: 'Bookmarks' }).first().isVisible(), 'the Bookmarks column has no heading "Bookmarks"', { timeoutMs: 30_000 });
    await statusArticle(page, ctx.seed.ui.toggle.text, 30_000);
  }),

  // §3.2: direct load of /web/bookmarks, most recently bookmarked first.
  step('ui.bookmarks.column', true, async (ctx, s) => {
    const { api, seed } = ctx;
    expectStatus(await api.post(`/api/v1/statuses/${seed.ui.column.id}/bookmark`, seed.tokens.uma_full), 200, 'bookmark (API)');
    await openWeb(s, '/web/bookmarks');
    const newer = await statusArticle(s.page, seed.ui.column.text, 45_000);
    const older = await statusArticle(s.page, seed.ui.toggle.text, 45_000);
    const [a, b] = [await newer.boundingBox(), await older.boundingBox()];
    assert(a && b && a.y < b.y, 'the most recently bookmarked status must be listed first in the Bookmarks column');
  }),

  // §3.1 + §3.2: un-bookmark from the column; gone after reload.
  step('ui.bookmark.untoggle', true, async (ctx, s) => {
    const { seed } = ctx;
    const text = seed.ui.toggle.text;
    await expectPressed(s.page, text, 'true', 'in the Bookmarks column');
    const art = await statusArticle(s.page, text);
    await art.getByRole('button', BOOKMARK).first().click();
    await waitFor(async () => !(await umaBookmarkIds(ctx)).includes(seed.ui.toggle.id), 'clicking Bookmark again did not remove the bookmark (GET /api/v1/bookmarks)', { timeoutMs: 15_000, intervalMs: 500 });
    await openWeb(s, '/web/bookmarks');
    await statusArticle(s.page, seed.ui.column.text, 45_000);
    const gone = await s.page.locator('article').filter({ hasText: text }).count();
    assert(gone === 0, 'the un-bookmarked status is still listed in the Bookmarks column after a reload');
  }),

  // §3.1: the detailed status view has the Bookmark button too.
  step(
    'ui.bookmark.detail',
    true,
    async (ctx, s) => {
      const { seed } = ctx;
      await openWeb(s, `/web/statuses/${seed.ui.detail.id}`);
      await waitFor(async () => s.page.getByText(seed.ui.detail.text).first().isVisible(), 'detailed status not shown', { timeoutMs: 45_000 });
      const btn = s.page.getByRole('button', BOOKMARK).first();
      await waitFor(async () => btn.isVisible(), 'no button named "Bookmark" in the detailed status view', { timeoutMs: 20_000 });
      await btn.click();
      await waitFor(async () => (await umaBookmarkIds(ctx)).includes(seed.ui.detail.id), 'clicking Bookmark in the detailed view did not create a bookmark', { timeoutMs: 15_000, intervalMs: 500 });
    },
    { last: true },
  ),
];
