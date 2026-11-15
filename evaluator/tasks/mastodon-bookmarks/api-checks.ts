/**
 * HIDDEN backend API checks for mastodon-bookmarks. Each check names the spec section it tests
 * (benchmark/tasks/mastodon-bookmarks/spec/feature.md). Checks use their own seeded statuses so
 * they don't depend on each other's outcome.
 */
import { assert, assertEq } from '../../checks.js';
import type { MastodonCheckContext, TaskCheck } from '../mastodon-common/evaluate.js';
import { asArray, asObject, expectStatus, parseLinkHeader, type ApiResponse, type MastodonApi } from '../mastodon-common/http.js';

type Status = { id: string; bookmarked?: boolean; reblog?: Status | null; [k: string]: unknown };

const sid = (ctx: MastodonCheckContext, key: string): string => {
  const v = ctx.seed.statuses?.[key];
  if (!v) throw new Error(`seed has no status '${key}'`);
  return String(v);
};
const tok = (ctx: MastodonCheckContext, key: string): string => {
  const v = ctx.seed.tokens?.[key];
  if (!v) throw new Error(`seed has no token '${key}'`);
  return String(v);
};

async function bookmark(api: MastodonApi, token: string, id: string) {
  return api.post<Status>(`/api/v1/statuses/${id}/bookmark`, token);
}
async function unbookmark(api: MastodonApi, token: string, id: string) {
  return api.post<Status>(`/api/v1/statuses/${id}/unbookmark`, token);
}

/** All bookmark ids of a user, following `next` links (max 20 pages). */
async function listAll(api: MastodonApi, token: string, firstPath = '/api/v1/bookmarks?limit=40'): Promise<string[]> {
  const ids: string[] = [];
  let next: string | undefined = firstPath;
  for (let i = 0; next && i < 20; i++) {
    const res: ApiResponse = await api.get(next, token);
    expectStatus(res, 200, `GET ${next}`);
    const page: Status[] = asArray<Status>(res, 'bookmarks list');
    ids.push(...page.map((s) => String(s.id)));
    next = page.length ? parseLinkHeader(res.headers.get('link')).next : undefined;
  }
  return ids;
}

function expectBookmarkedEntity(res: { body: unknown; text: string }, id: string, expected: boolean, what: string) {
  const s = asObject<Status>(res as never, what);
  assertEq(String(s.id), id, `${what}: returned status id`);
  assertEq(s.bookmarked, expected, `${what}: "bookmarked"`);
}

const check = (id: string, mandatory: boolean, run: TaskCheck['run']): TaskCheck => ({ spec: { id, category: 'backend', mandatory }, run });

// The probe (status deletion + archive export) runs once, lazily, after its API preconditions.
let probeCache: WeakMap<object, Promise<any>> = new WeakMap();
async function probe(ctx: MastodonCheckContext): Promise<any> {
  let p = probeCache.get(ctx.seed);
  if (!p) {
    p = (async () => {
      const t = tok(ctx, 'alice_full');
      for (const key of ['delete_me', 'export']) expectStatus(await bookmark(ctx.api, t, sid(ctx, key)), 200, `bookmark ${key}`);
      return ctx.rails('probe.rb', { delete_id: sid(ctx, 'delete_me'), email: ctx.seed.users.alice.email });
    })();
    probeCache.set(ctx.seed, p);
  }
  return p;
}
export const resetProbeCacheForTests = () => (probeCache = new WeakMap());

export const apiChecks: TaskCheck[] = [
  // §2.1: apps can register with the new scopes. Non-mandatory: Doorkeeper 5.2 doesn't enforce
  // configured scopes on registration, so the checkpoint passes this too (regression guard only).
  check('api.scopes.app_registration', false, async ({ api }) => {
    const res = await api.post('/api/v1/apps', null, {
      client_name: 'frugal bookmarks client',
      redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: 'read:bookmarks write:bookmarks',
    });
    expectStatus(res, 200, 'POST /api/v1/apps with scopes "read:bookmarks write:bookmarks"');
    const app = asObject<{ client_id?: string }>(res, 'app');
    assert(app.client_id, 'app registration returned no client_id');
  }),

  // §2.1: a token with the new scopes can be obtained through the OAuth token endpoint and used.
  check('api.scopes.oauth_token', true, async (ctx) => {
    const { api, seed } = ctx;
    const reg = await api.post('/api/v1/apps', null, {
      client_name: 'frugal bookmarks token client',
      redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: 'read:bookmarks write:bookmarks',
    });
    expectStatus(reg, 200, 'POST /api/v1/apps');
    const app = asObject<{ client_id: string; client_secret: string }>(reg, 'app');
    const res = await api.post('/oauth/token', null, {
      grant_type: 'password',
      client_id: app.client_id,
      client_secret: app.client_secret,
      username: seed.users.alice.email,
      password: seed.password,
      scope: 'read:bookmarks write:bookmarks',
    });
    expectStatus(res, 200, 'POST /oauth/token (password grant, scope "read:bookmarks write:bookmarks")');
    const token = asObject<{ access_token?: string }>(res, 'token').access_token;
    assert(token, 'no access_token in the token response');
    expectStatus(await api.get('/api/v1/bookmarks', token), 200, 'GET /api/v1/bookmarks with the new read:bookmarks token');
    expectStatus(await bookmark(api, token, sid(ctx, 'scope')), 200, 'POST bookmark with the new write:bookmarks token');
  }),

  // §2 common errors: no token → 401.
  check('api.auth.unauthenticated', true, async (ctx) => {
    expectStatus(await ctx.api.get('/api/v1/bookmarks'), 401, 'GET /api/v1/bookmarks without a token');
    expectStatus(await bookmark(ctx.api, '', sid(ctx, 'scope')), 401, 'POST bookmark without a token');
    expectStatus(await unbookmark(ctx.api, '', sid(ctx, 'scope')), 401, 'POST unbookmark without a token');
  }),

  // §2.1 + §2 common errors: scope enforcement, and read/write cover the granular scopes.
  check('api.auth.scopes', true, async (ctx) => {
    const { api } = ctx;
    const target = sid(ctx, 'scope');
    expectStatus(await api.get('/api/v1/bookmarks', tok(ctx, 'alice_read_favourites')), 403, 'GET /api/v1/bookmarks with only read:favourites');
    expectStatus(await api.get('/api/v1/bookmarks', tok(ctx, 'alice_write_bookmarks')), 403, 'GET /api/v1/bookmarks with only write:bookmarks');
    expectStatus(await bookmark(api, tok(ctx, 'alice_write_favourites'), target), 403, 'POST bookmark with only write:favourites');
    expectStatus(await bookmark(api, tok(ctx, 'alice_read'), target), 403, 'POST bookmark with only read');
    expectStatus(await bookmark(api, tok(ctx, 'alice_read_bookmarks'), target), 403, 'POST bookmark with only read:bookmarks');
    expectStatus(await api.get('/api/v1/bookmarks', tok(ctx, 'alice_read_bookmarks')), 200, 'GET /api/v1/bookmarks with read:bookmarks');
    expectStatus(await api.get('/api/v1/bookmarks', tok(ctx, 'alice_read')), 200, 'GET /api/v1/bookmarks with read');
    expectStatus(await bookmark(api, tok(ctx, 'alice_write_bookmarks'), target), 200, 'POST bookmark with write:bookmarks');
    expectStatus(await unbookmark(api, tok(ctx, 'alice_write'), target), 200, 'POST unbookmark with write');
    expectStatus(await bookmark(api, tok(ctx, 'alice_write'), target), 200, 'POST bookmark with write');
  }),

  // §2.2 + §2.4: create returns the status with bookmarked=true; single status shows it; listed.
  check('api.bookmark.create', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'alice_full');
    const id = sid(ctx, 'bob_public');
    const res = await bookmark(api, t, id);
    expectStatus(res, 200, 'POST /api/v1/statuses/:id/bookmark');
    expectBookmarkedEntity(res, id, true, 'bookmark response');
    const show = await api.get(`/api/v1/statuses/${id}`, t);
    expectStatus(show, 200, 'GET /api/v1/statuses/:id');
    expectBookmarkedEntity(show, id, true, 'GET /api/v1/statuses/:id after bookmarking');
    const list = await listAll(api, t);
    assert(list.includes(id), `GET /api/v1/bookmarks does not include the bookmarked status ${id}`);
  }),

  // §2.2: idempotent, never a duplicate.
  check('api.bookmark.idempotent', true, async (ctx) => {
    const t = tok(ctx, 'alice_full');
    const id = sid(ctx, 'idem');
    for (const n of [1, 2]) {
      const res = await bookmark(ctx.api, t, id);
      expectStatus(res, 200, `bookmark call #${n}`);
      expectBookmarkedEntity(res, id, true, `bookmark call #${n}`);
    }
    const list = await listAll(ctx.api, t);
    assertEq(list.filter((x) => x === id).length, 1, 'occurrences of the status in GET /api/v1/bookmarks after bookmarking it twice');
  }),

  // §2.2: every status the user may see can be bookmarked.
  check('api.bookmark.visibility_allowed', true, async (ctx) => {
    const t = tok(ctx, 'alice_full');
    for (const key of ['bob_unlisted', 'bob_private', 'bob_direct_alice', 'carol_public', 'alice_private']) {
      const id = sid(ctx, key);
      const res = await bookmark(ctx.api, t, id);
      expectStatus(res, 200, `bookmark ${key} (visible to alice)`);
      expectBookmarkedEntity(res, id, true, `bookmark ${key}`);
    }
    const list = await listAll(ctx.api, t);
    for (const key of ['bob_unlisted', 'bob_private', 'bob_direct_alice', 'carol_public', 'alice_private'])
      assert(list.includes(sid(ctx, key)), `${key} missing from GET /api/v1/bookmarks`);
  }),

  // §2.2: statuses the user may not see are refused (403/404) and nothing is created.
  check('api.bookmark.visibility_denied', true, async (ctx) => {
    const t = tok(ctx, 'alice_full');
    for (const key of ['carol_private', 'carol_direct_dave']) {
      const res = await bookmark(ctx.api, t, sid(ctx, key));
      expectStatus(res, [403, 404], `bookmark ${key} (NOT visible to alice)`);
    }
    const list = await listAll(ctx.api, t);
    for (const key of ['carol_private', 'carol_direct_dave'])
      assert(!list.includes(sid(ctx, key)), `${key} (not visible to alice) appears in her bookmarks`);
  }),

  // §2 common errors: unknown status → 404.
  check('api.bookmark.not_found', true, async (ctx) => {
    expectStatus(await bookmark(ctx.api, tok(ctx, 'alice_full'), '99999999999999'), 404, 'bookmark of a non-existent status');
  }),

  // §1 Boosts + §2.2: bookmarking a boost bookmarks and returns the original.
  check('api.bookmark.boost', false, async (ctx) => {
    const t = tok(ctx, 'alice_full');
    const boost = sid(ctx, 'bob_boost_carol');
    const original = String(ctx.seed.originals.bob_boost_carol);
    const res = await bookmark(ctx.api, t, boost);
    expectStatus(res, 200, 'bookmark of a boost');
    expectBookmarkedEntity(res, original, true, 'bookmark of a boost (must return the original status)');
    const list = await listAll(ctx.api, t);
    assert(list.includes(original), 'the original of the boost is not in GET /api/v1/bookmarks');
    assert(!list.includes(boost), 'the boost itself (not its original) is in GET /api/v1/bookmarks');
  }),

  // §2.3: unbookmark returns bookmarked=false and removes it from the list.
  check('api.bookmark.destroy', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'alice_full');
    const id = sid(ctx, 'unbm');
    expectStatus(await bookmark(api, t, id), 200, 'bookmark');
    assert((await listAll(api, t)).includes(id), 'status not listed after bookmarking');
    const res = await unbookmark(api, t, id);
    expectStatus(res, 200, 'POST /api/v1/statuses/:id/unbookmark');
    expectBookmarkedEntity(res, id, false, 'unbookmark response');
    assert(!(await listAll(api, t)).includes(id), 'status still listed in GET /api/v1/bookmarks after unbookmarking');
    const show = await api.get(`/api/v1/statuses/${id}`, t);
    expectStatus(show, 200, 'GET /api/v1/statuses/:id');
    expectBookmarkedEntity(show, id, false, 'GET /api/v1/statuses/:id after unbookmarking');
  }),

  // §2.3: unbookmarking a status that isn't bookmarked → 404.
  check('api.bookmark.destroy_not_bookmarked', false, async (ctx) => {
    expectStatus(await unbookmark(ctx.api, tok(ctx, 'alice_full'), sid(ctx, 'never')), 404, 'unbookmark of a status alice never bookmarked');
  }),

  // §2.5: newest bookmark first; every entity bookmarked=true.
  check('api.list.order', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'pat_full');
    const pages: string[] = ctx.seed.pages.map(String);
    const order = [3, 0, 6, 1, 5, 2, 4].map((i) => pages[i]);
    for (const id of order) expectStatus(await bookmark(api, t, id), 200, `bookmark ${id}`);
    const res = await api.get('/api/v1/bookmarks', t);
    expectStatus(res, 200, 'GET /api/v1/bookmarks');
    const list = asArray<Status>(res, 'bookmarks');
    assertEq(list.map((s) => String(s.id)), [...order].reverse(), 'GET /api/v1/bookmarks order (most recently bookmarked first)');
    assert(list.every((s) => s.bookmarked === true), 'every status in GET /api/v1/bookmarks must have "bookmarked": true');
  }),

  // §2.5 Pagination: Link next/prev with limit, max_id/since_id cursors; next visits everything once.
  check('api.list.pagination', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'pat_full');
    const pages: string[] = ctx.seed.pages.map(String);
    // Make sure pat has exactly the 7 pagination bookmarks (api.list.order normally did this).
    for (const id of pages) expectStatus(await bookmark(api, t, id), 200, `bookmark ${id}`);
    const all = await listAll(api, t);
    assertEq([...all].sort(), [...pages].sort(), 'pat\'s bookmarks (setup)');

    const seen: string[] = [];
    let url: string | undefined = '/api/v1/bookmarks?limit=3';
    const sizes: number[] = [];
    for (let i = 0; url && i < 6; i++) {
      const res: ApiResponse = await api.get(url, t);
      expectStatus(res, 200, `GET ${url}`);
      const page: Status[] = asArray<Status>(res, 'page');
      sizes.push(page.length);
      seen.push(...page.map((s) => String(s.id)));
      const links = parseLinkHeader(res.headers.get('link'));
      if (page.length === 3) {
        assert(links.next, `page ${i + 1} is full (3 of limit=3) but has no rel="next" Link (Link: ${res.headers.get('link')})`);
        const nu = new URL(links.next, api.baseUrl);
        assert(nu.pathname === '/api/v1/bookmarks', `next link path is ${nu.pathname}`);
        assertEq(nu.searchParams.get('limit'), '3', 'next link limit');
        assert(nu.searchParams.get('max_id'), 'next link has no max_id');
      } else {
        assert(!links.next, `page ${i + 1} is not full (${page.length} of 3) but has a rel="next" Link`);
      }
      if (page.length > 0) {
        assert(links.prev, `non-empty page ${i + 1} has no rel="prev" Link`);
        const pu = new URL(links.prev, api.baseUrl);
        assert(pu.searchParams.get('since_id'), 'prev link has no since_id');
      }
      url = links.next;
    }
    assertEq(sizes, [3, 3, 1], 'page sizes when following rel="next" with limit=3 over 7 bookmarks');
    assertEq(seen, all, 'statuses visited by following rel="next" (each exactly once, in list order)');
  }),

  // §2.5: empty result → no Link header.
  check('api.list.empty_no_link', false, async (ctx) => {
    const res = await ctx.api.get('/api/v1/bookmarks', tok(ctx, 'carol_full'));
    expectStatus(res, 200, 'GET /api/v1/bookmarks (no bookmarks)');
    assertEq(asArray(res, 'bookmarks'), [], 'bookmarks of a user who has none');
    assert(!res.headers.get('link'), `empty bookmarks list must not send a Link header (got ${res.headers.get('link')})`);
  }),

  // §2.5 + §2.6: only the requester's bookmarks; bookmarked computed per user.
  check('api.privacy.isolation', true, async (ctx) => {
    const { api } = ctx;
    const id = sid(ctx, 'privacy');
    const dave = tok(ctx, 'dave_full');
    const alice = tok(ctx, 'alice_full');
    const res = await bookmark(api, dave, id);
    expectStatus(res, 200, 'dave bookmarks a status');
    assertEq(await listAll(api, dave), [id], 'dave\'s bookmarks');
    assert(!(await listAll(api, alice)).includes(id), 'dave\'s bookmark shows up in alice\'s GET /api/v1/bookmarks');
    const asAlice = await api.get(`/api/v1/statuses/${id}`, alice);
    expectStatus(asAlice, 200, 'GET status as alice');
    expectBookmarkedEntity(asAlice, id, false, 'status bookmarked by dave, seen by alice');
    const asDave = await api.get(`/api/v1/statuses/${id}`, dave);
    expectStatus(asDave, 200, 'GET status as dave');
    expectBookmarkedEntity(asDave, id, true, 'status bookmarked by dave, seen by dave');
  }),

  // §2.4: bookmarked is correct in timelines (bulk rendering).
  check('api.status.bookmarked_field', true, async (ctx) => {
    const { api, seed } = ctx;
    const t = tok(ctx, 'alice_full');
    const id = sid(ctx, 'flag');
    expectStatus(await bookmark(api, t, id), 200, 'bookmark');
    let home = await api.get('/api/v1/timelines/home?limit=40', t);
    for (let i = 0; home.status === 206 && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000)); // feed regeneration in progress
      home = await api.get('/api/v1/timelines/home?limit=40', t);
    }
    expectStatus(home, 200, 'GET /api/v1/timelines/home');
    const hs = asArray<Status>(home, 'home timeline');
    const mine = hs.find((s) => String(s.id) === id);
    assert(mine, 'the seeded status is not in alice\'s home timeline');
    assertEq(mine.bookmarked, true, 'home timeline: "bookmarked" of a bookmarked status');
    const others = hs.filter((s) => String(s.id) !== id && !['bob_public', 'idem', 'unbm'].some((k) => sid(ctx, k) === String(s.id)));
    assert(others.length > 0, 'home timeline has no other statuses to compare');
    for (const s of others) assert(typeof s.bookmarked === 'boolean', `home timeline status ${s.id} has no boolean "bookmarked"`);
    const ui: Record<string, { id: string }> = seed.ui;
    for (const v of Object.values(ui)) {
      const s = hs.find((x) => String(x.id) === v.id);
      if (s) assertEq(s.bookmarked, false, `home timeline: "bookmarked" of the not-bookmarked status ${v.id}`);
    }
    const acct = await api.get(`/api/v1/accounts/${seed.users.bob.id}/statuses?limit=40`, t);
    expectStatus(acct, 200, 'GET /api/v1/accounts/:id/statuses');
    const inAcct = asArray<Status>(acct, 'account statuses').find((s) => String(s.id) === id);
    assert(inAcct, 'status not found in the account statuses timeline');
    assertEq(inAcct.bookmarked, true, 'account statuses: "bookmarked" of a bookmarked status');
  }),

  // §2.4: the attribute is present only for requests with a user token.
  check('api.status.bookmarked_anonymous', false, async (ctx) => {
    const res = await ctx.api.get(`/api/v1/statuses/${sid(ctx, 'bob_public')}`);
    expectStatus(res, 200, 'GET /api/v1/statuses/:id without a token');
    const s = asObject<Status>(res, 'status');
    assert(!('bookmarked' in s), '"bookmarked" must not be present in anonymous responses');
  }),

  // §1 (ON DELETE CASCADE / dependent destroy): deleting a status removes its bookmarks.
  check('api.bookmark.status_deleted', false, async (ctx) => {
    const out = await probe(ctx);
    assertEq(out.deleted, 'deleted', 'status deletion through RemoveStatusService');
    const list = await listAll(ctx.api, tok(ctx, 'alice_full'));
    assert(!list.includes(sid(ctx, 'delete_me')), 'a deleted status is still listed in GET /api/v1/bookmarks');
  }),

  // §2.7: archive export contains bookmarks.json.
  check('api.export.archive', false, async (ctx) => {
    const out = await probe(ctx);
    assert(!out.export_error, `building the archive failed: ${out.export_error}`);
    assert(out.bookmarks_json, `archive has no bookmarks.json (files: ${JSON.stringify(out.archive_files)})`);
    const coll = out.bookmarks_json as { type?: string; orderedItems?: string[]; totalItems?: number };
    assertEq(coll.type, 'OrderedCollection', 'bookmarks.json type');
    const uri = String(ctx.seed.status_uris.export);
    assert(Array.isArray(coll.orderedItems) && coll.orderedItems.includes(uri), `bookmarks.json orderedItems lacks ${uri}`);
    assertEq(coll.totalItems, coll.orderedItems!.length, 'bookmarks.json totalItems');
    assertEq(out.actor_bookmarks, 'bookmarks.json', 'actor.json "bookmarks"');
  }),
];
