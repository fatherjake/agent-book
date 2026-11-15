/**
 * HIDDEN Playwright checks for mastodon-filters (spec/feature.md §5, §6). One signed-in session
 * (seeded user "uma") runs the flow in order; each step is its own check. Every settings action is
 * verified independently through the REST API.
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

type ApiFilter = { id: string | number; phrase: string; context: string[] };

async function umaFilters(ctx: MastodonCheckContext): Promise<ApiFilter[]> {
  const res = await ctx.api.get('/api/v1/filters', ctx.seed.tokens.uma_full);
  expectStatus(res, 200, 'GET /api/v1/filters (uma)');
  return asArray<ApiFilter>(res, 'filters');
}

/** Status text visible in the home column? */
async function textVisible(page: Page, text: string): Promise<boolean> {
  return page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
}

async function filteredCount(page: Page): Promise<number> {
  return page.getByText('Filtered', { exact: true }).count();
}

/**
 * Wait until the home column shows the statuses in `shown` and hides the ones in `hidden` behind a
 * "Filtered" placeholder (the client loads filters shortly after start).
 */
async function expectHome(page: Page, shown: string[], hidden: string[], what: string) {
  await waitFor(
    async () => {
      for (const t of shown) if (!(await textVisible(page, t))) return false;
      for (const t of hidden) if (await textVisible(page, t)) return false;
      return (await filteredCount(page)) >= hidden.length;
    },
    `${what}: expected visible ${JSON.stringify(shown)} and ${hidden.length} "Filtered" placeholder(s) instead of ${JSON.stringify(hidden)}`,
    { timeoutMs: 30_000, intervalMs: 500, describe: () => 'condition not met' },
  );
}

async function openFilters(s: UiSession) {
  await s.page.goto('/filters', { waitUntil: 'domcontentloaded' });
  await waitFor(async () => s.page.getByRole('heading', { name: 'Filters' }).first().isVisible(), '/filters has no "Filters" page title', { timeoutMs: 30_000 });
}

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
          if (errs && e instanceof Error) e.message += ` [browser errors: ${errs}]`;
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

const T = (ctx: MastodonCheckContext) => ({
  fruit: ctx.seed.ui.fruit.text as string,
  bus: ctx.seed.ui.bus.text as string,
  neutral: ctx.seed.ui.neutral.text as string,
});

export const uiChecks: TaskCheck[] = [
  // Precondition (passes on the checkpoint): sign in, home column shows the seeded statuses.
  step(
    'ui.login',
    true,
    async (ctx, s) => {
      await openWeb(s, '/web/timelines/home');
      const t = T(ctx);
      for (const x of [t.fruit, t.bus, t.neutral]) await statusArticle(s.page, x, 60_000);
    },
    { first: true },
  ),

  // §6 Navigation: settings sidebar item "Filters" → /filters.
  step('ui.filters.navigation', true, async (_ctx, s) => {
    await s.page.goto('/settings/preferences', { waitUntil: 'domcontentloaded' });
    // Match on text content, not the accessible name: Font Awesome's ::before glyph is part of
    // the accessible name ("\uf0b0Filters"), so an exact role/name match misses the real link.
    const link = s.page.locator('a', { hasText: /^\s*Filters\s*$/ });
    await waitFor(async () => link.first().isVisible(), 'the settings sidebar has no "Filters" link', { timeoutMs: 30_000 });
    await link.first().click();
    await s.page.waitForURL(/\/filters\/?$/, { timeout: 30_000 });
    await waitFor(async () => s.page.getByRole('heading', { name: 'Filters' }).first().isVisible(), '/filters has no "Filters" page title', { timeoutMs: 30_000 });
  }),

  // §6 new form: "Add new filter", labels, submit → /filters lists it; stored for the user.
  step('ui.filters.create', true, async (ctx, s) => {
    const page = s.page;
    await openFilters(s);
    await page.getByRole('link', { name: 'Add new filter' }).first().click();
    await page.waitForURL(/\/filters\/new\/?$/, { timeout: 30_000 });
    await page.getByLabel('Keyword or phrase').fill('kiwi');
    await page.getByLabel('Home timeline').check();
    await page.getByRole('button', { name: 'Add new filter' }).click();
    await page.waitForURL(/\/filters\/?$/, { timeout: 30_000 });
    const row = page.getByRole('row').filter({ hasText: 'kiwi' });
    await waitFor(async () => row.first().isVisible(), 'the new filter is not listed on /filters', { timeoutMs: 15_000 });
    assert(((await row.first().textContent()) ?? '').includes('Home timeline'), 'the filter row does not show the context "Home timeline"');
    const fs = await umaFilters(ctx);
    const f = fs.find((x) => x.phrase === 'kiwi');
    assert(f, `GET /api/v1/filters has no "kiwi" filter (got ${JSON.stringify(fs)})`);
    assert(JSON.stringify(f.context) === JSON.stringify(['home']), `filter context is ${JSON.stringify(f.context)}, expected ["home"]`);
  }),

  // §5: matching statuses in the home column become "Filtered" (case-insensitive).
  step('ui.filters.hidden_in_home', true, async (ctx, s) => {
    const t = T(ctx);
    await openWeb(s, '/web/timelines/home');
    await expectHome(s.page, [t.bus, t.neutral], [t.fruit], 'home column with the filter "kiwi"');
  }),

  // §5: still hidden after a full reload (filters come from the server).
  step('ui.filters.persist', true, async (ctx, s) => {
    const t = T(ctx);
    await openWeb(s, '/web/timelines/home');
    await expectHome(s.page, [t.bus, t.neutral], [t.fruit], 'home column after a reload');
  }),

  // §6 edit form: "Edit filter" → change phrase → "Save changes"; the UI follows.
  step('ui.filters.edit', true, async (ctx, s) => {
    const page = s.page;
    const t = T(ctx);
    await openFilters(s);
    await page.getByRole('row').filter({ hasText: 'kiwi' }).first().getByRole('link', { name: 'Edit filter' }).click();
    await page.waitForURL(/\/filters\/\d+\/edit\/?$/, { timeout: 30_000 });
    const phrase = page.getByLabel('Keyword or phrase');
    assert((await phrase.inputValue()) === 'kiwi', 'the edit form is not pre-filled with the phrase');
    await phrase.fill('bus was LATE');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForURL(/\/filters\/?$/, { timeout: 30_000 });
    await waitFor(async () => page.getByRole('row').filter({ hasText: 'bus was LATE' }).first().isVisible(), 'the edited phrase is not listed on /filters', { timeoutMs: 15_000 });
    const fs = await umaFilters(ctx);
    assert(fs.length === 1 && fs[0].phrase === 'bus was LATE', `GET /api/v1/filters after editing: ${JSON.stringify(fs)}`);
    await openWeb(s, '/web/timelines/home');
    await expectHome(page, [t.fruit, t.neutral], [t.bus], 'home column after editing the filter to "bus was LATE"');
  }),

  // §6 index: "Delete" removes the filter; the statuses come back.
  step('ui.filters.delete', true, async (ctx, s) => {
    const page = s.page;
    const t = T(ctx);
    await openFilters(s);
    await page.getByRole('row').filter({ hasText: 'bus was LATE' }).first().getByRole('link', { name: 'Delete' }).click();
    await waitFor(async () => (await page.getByRole('row').filter({ hasText: 'bus was LATE' }).count()) === 0, 'the filter is still listed after "Delete"', { timeoutMs: 20_000 });
    await waitFor(async () => (await umaFilters(ctx)).length === 0, 'the filter still exists (GET /api/v1/filters) after "Delete"', { timeoutMs: 10_000, intervalMs: 500 });
    await openWeb(s, '/web/timelines/home');
    await expectHome(page, [t.fruit, t.bus, t.neutral], [], 'home column after deleting the filter');
    assert((await filteredCount(page)) === 0, 'a "Filtered" placeholder is still shown after deleting the only filter');
  }),

  // §5 contexts: a filter for other contexts doesn't hide statuses in the home column.
  step('ui.filters.context_respected', false, async (ctx, s) => {
    const t = T(ctx);
    const res = await ctx.api.post('/api/v1/filters', ctx.seed.tokens.uma_full, { phrase: 'library', context: ['public', 'notifications'] });
    expectStatus(res, 200, 'create a public/notifications filter (API)');
    await openWeb(s, '/web/timelines/home');
    await sleep(2500); // let the client fetch filters
    await expectHome(s.page, [t.fruit, t.bus, t.neutral], [], 'home column with a filter for other contexts only');
  }),

  // §6 + §2: validation errors are shown on the form.
  step(
    'ui.filters.validation',
    false,
    async (_ctx, s) => {
      const page = s.page;
      await page.goto('/filters/new', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Keyword or phrase').fill('no context chosen');
      await page.getByRole('button', { name: 'Add new filter' }).click();
      // The form shows only the first error per field; with presence validation also on `context`
      // that is Rails' "can't be blank" (as in the upstream reference), so accept either message.
      const msg = page.getByText(/None or invalid context supplied|can't be blank/);
      await waitFor(async () => msg.first().isVisible(), 'submitting without a context shows no context validation error', {
        timeoutMs: 20_000,
      });
    },
    { last: true },
  ),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
