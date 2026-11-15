/**
 * HIDDEN backend checks for mastodon-filters (spec/feature.md §1-§4). CRUD checks use the REST
 * API; server-side filtering posts statuses through the real delivery path (probe.rb, Sidekiq
 * inline) and reads the results back through the REST timelines/notifications.
 */
import { assert, assertEq } from '../../checks.js';
import type { MastodonCheckContext, TaskCheck } from '../mastodon-common/evaluate.js';
import { asArray, asObject, expectStatus, type ApiResponse, type MastodonApi } from '../mastodon-common/http.js';

type Filter = { id: string | number; phrase: string; context: string[]; expires_at: string | null; [k: string]: unknown };

const tok = (ctx: MastodonCheckContext, key: string): string => {
  const v = ctx.seed.tokens?.[key];
  if (!v) throw new Error(`seed has no token '${key}'`);
  return String(v);
};
const check = (id: string, mandatory: boolean, run: TaskCheck['run']): TaskCheck => ({ spec: { id, category: 'backend', mandatory }, run });

function asFilter(res: ApiResponse, what: string): Filter {
  const f = asObject<Filter>(res, what);
  assert(typeof f.id === 'number' || (typeof f.id === 'string' && /^\d+$/.test(f.id)), `${what}: "id" must be an integer or numeric string (got ${JSON.stringify(f.id)})`);
  assert(typeof f.phrase === 'string', `${what}: "phrase" must be a string`);
  assert(Array.isArray(f.context), `${what}: "context" must be an array`);
  assert(f.expires_at === null || typeof f.expires_at === 'string', `${what}: "expires_at" must be a string or null`);
  return f;
}

async function create(api: MastodonApi, token: string, form: Record<string, string | boolean | string[]>, what = 'POST /api/v1/filters') {
  const res = await api.post('/api/v1/filters', token, form);
  expectStatus(res, 200, what);
  return asFilter(res, what);
}

async function listIds(api: MastodonApi, token: string): Promise<string[]> {
  const res = await api.get('/api/v1/filters', token);
  expectStatus(res, 200, 'GET /api/v1/filters');
  return asArray<Filter>(res, 'filters').map((f) => String(f.id));
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

// ----------------------------------------------------------------------------- server-side scenario
/**
 * Runs once per evaluation: alice creates filters through the API, then bob posts statuses through
 * the delivery path. Returns which statuses reached alice's home timeline / notifications.
 */
interface ServerScenario {
  ids: Record<string, string>;
  errors: Record<string, string>;
  home: string[];
  mentionNotified: string[];
  filterIds: Record<string, string>;
}
let scenarioCache = new WeakMap<object, Promise<ServerScenario>>();

const FUTURE = () => new Date(Date.now() + 7 * 86400_000).toISOString();
const PAST = () => new Date(Date.now() - 86400_000).toISOString();

/** Home timeline ids; waits out a feed regeneration (206 Partial Content) if one is running. */
async function homeIds(api: MastodonApi, token: string): Promise<string[]> {
  let res = await api.get('/api/v1/timelines/home?limit=40', token);
  for (let i = 0; res.status === 206 && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await api.get('/api/v1/timelines/home?limit=40', token);
  }
  expectStatus(res, 200, 'GET /api/v1/timelines/home');
  return asArray<{ id: string }>(res, 'home').map((s) => String(s.id));
}

async function serverScenario(ctx: MastodonCheckContext): Promise<ServerScenario> {
  let p = scenarioCache.get(ctx.seed);
  if (!p) {
    p = (async () => {
      const { api } = ctx;
      const t = tok(ctx, 'alice_full');
      const filterIds: Record<string, string> = {};
      const mk = async (key: string, form: Record<string, string | boolean | string[]>) => (filterIds[key] = String((await create(api, t, form, `create filter ${key}`)).id));
      await mk('zebra', { phrase: 'zebra crossing', context: ['home'], irreversible: true });
      await mk('spoilers', { phrase: 'Spoilers Ahead', context: ['notifications'], irreversible: true });
      await mk('pineapple', { phrase: 'pineapple', context: ['home', 'notifications'], irreversible: false });
      await mk('cpp', { phrase: 'c++', context: ['home'], irreversible: true });
      await mk('walrus', { phrase: 'walrus', context: ['home'], irreversible: true, expires_at: PAST() });
      const posts = [
        { key: 'zebra_upper', author: 'bob', text: 'Careful at the ZEBRA Crossing near the school' },
        { key: 'zebra_cw', author: 'bob', text: 'a perfectly innocent body text', spoiler_text: 'zebra crossing incident' },
        { key: 'zebra_split', author: 'bob', text: 'a zebra was seen near the crossing' },
        { key: 'zebra_own', author: 'alice', text: 'I painted a zebra crossing today' },
        { key: 'neutral', author: 'bob', text: 'Lovely weather for a walk' },
        { key: 'pineapple', author: 'bob', text: 'Pineapple on pizza, discuss' },
        { key: 'cpp_match', author: 'bob', text: 'Template tricks in C++ are fun' },
        { key: 'cpp_nomatch', author: 'bob', text: 'Template tricks in c are fun' },
        { key: 'walrus', author: 'bob', text: 'A walrus at the zoo' },
        { key: 'mention_filtered', author: 'bob', text: '@alice spoilers ahead for the season finale' },
        { key: 'mention_ok', author: 'bob', text: '@alice are you coming to the picnic' },
      ];
      const out = await ctx.rails('probe.rb', { posts });
      const home = await homeIds(api, t);
      const notes = await api.get('/api/v1/notifications?limit=40', t);
      expectStatus(notes, 200, 'GET /api/v1/notifications');
      const mentionNotified = asArray<{ type: string; status?: { id: string } }>(notes, 'notifications')
        .filter((n) => n.type === 'mention' && n.status)
        .map((n) => String(n.status!.id));
      return { ids: out.ids ?? {}, errors: out.errors ?? {}, home, mentionNotified, filterIds };
    })();
    scenarioCache.set(ctx.seed, p);
  }
  return p;
}
export const resetScenarioCacheForTests = () => (scenarioCache = new WeakMap());

function posted(s: ServerScenario, key: string): string {
  const id = s.ids[key];
  assert(id, `posting status '${key}' failed: ${s.errors[key] ?? 'no id returned'}`);
  return id;
}

// ----------------------------------------------------------------------------- checks
export const apiChecks: TaskCheck[] = [
  // §3 errors: no token → 401.
  check('api.filters.unauthenticated', true, async ({ api }) => {
    expectStatus(await api.get('/api/v1/filters'), 401, 'GET /api/v1/filters without a token');
    expectStatus(await api.post('/api/v1/filters', null, { phrase: 'x', context: ['home'] }), 401, 'POST /api/v1/filters without a token');
  }),

  // §3 table + errors: read for GET, write for POST/PUT/DELETE.
  check('api.filters.scopes', true, async (ctx) => {
    const { api } = ctx;
    const read = tok(ctx, 'alice_read');
    const write = tok(ctx, 'alice_write');
    expectStatus(await api.post('/api/v1/filters', read, { phrase: 'scoped', context: ['home'] }), 403, 'POST /api/v1/filters with a read-only token');
    const f = await create(api, write, { phrase: 'scoped', context: ['home'] }, 'POST /api/v1/filters with a write token');
    expectStatus(await api.get('/api/v1/filters', write), 403, 'GET /api/v1/filters with a write-only token');
    expectStatus(await api.get(`/api/v1/filters/${f.id}`, write), 403, 'GET /api/v1/filters/:id with a write-only token');
    expectStatus(await api.get('/api/v1/filters', read), 200, 'GET /api/v1/filters with a read token');
    expectStatus(await api.get(`/api/v1/filters/${f.id}`, read), 200, 'GET /api/v1/filters/:id with a read token');
    expectStatus(await api.put(`/api/v1/filters/${f.id}`, read, { phrase: 'nope' }), 403, 'PUT /api/v1/filters/:id with a read-only token');
    expectStatus(await api.delete(`/api/v1/filters/${f.id}`, read), 403, 'DELETE /api/v1/filters/:id with a read-only token');
    expectStatus(await api.delete(`/api/v1/filters/${f.id}`, write), 200, 'DELETE /api/v1/filters/:id with a write token');
  }),

  // §3: create with the minimal params; entity fields.
  check('api.filters.create', true, async (ctx) => {
    const f = await create(ctx.api, tok(ctx, 'alice_full'), { phrase: 'magic words', context: ['home'] });
    assertEq(f.phrase, 'magic words', 'phrase');
    assertEq(f.context, ['home'], 'context');
    assertEq(f.expires_at, null, 'expires_at (no expiry given)');
    assert((await listIds(ctx.api, tok(ctx, 'alice_full'))).includes(String(f.id)), 'created filter missing from GET /api/v1/filters');
  }),

  // §3: all contexts, irreversible, expires_at.
  check('api.filters.create_full', true, async (ctx) => {
    const exp = FUTURE();
    const f = await create(ctx.api, tok(ctx, 'alice_full'), {
      phrase: 'season finale',
      context: ['home', 'notifications', 'public', 'thread'],
      irreversible: true,
      expires_at: exp,
    });
    assertEq([...f.context].sort(), ['home', 'notifications', 'public', 'thread'], 'context');
    assert(f.expires_at, 'expires_at should be set');
    const delta = Math.abs(Date.parse(f.expires_at!) - Date.parse(exp));
    assert(delta < 60_000, `expires_at ${f.expires_at} differs from the requested ${exp}`);
  }),

  // §3: list = all of the user's filters (incl. expired), only theirs.
  check('api.filters.list', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'dave_full');
    const a = await create(api, t, { phrase: 'dave one', context: ['home'] });
    const b = await create(api, t, { phrase: 'dave expired', context: ['public'], expires_at: PAST() });
    const ids = await listIds(api, t);
    assert(sameSet(ids, [String(a.id), String(b.id)]), `GET /api/v1/filters for dave: expected exactly his 2 filters (incl. the expired one), got ${JSON.stringify(ids)}`);
    const res = await api.get('/api/v1/filters', t);
    const listed = asArray<Filter>(res, 'filters').find((x) => String(x.id) === String(a.id));
    assertEq(listed?.phrase, 'dave one', 'listed phrase');
  }),

  // §3: show.
  check('api.filters.show', true, async (ctx) => {
    const t = tok(ctx, 'alice_full');
    const f = await create(ctx.api, t, { phrase: 'show me', context: ['public'] });
    const res = await ctx.api.get(`/api/v1/filters/${f.id}`, t);
    expectStatus(res, 200, 'GET /api/v1/filters/:id');
    const g = asFilter(res, 'GET /api/v1/filters/:id');
    assertEq(String(g.id), String(f.id), 'id');
    assertEq(g.phrase, 'show me', 'phrase');
    assertEq(g.context, ['public'], 'context');
  }),

  // §3: partial update.
  check('api.filters.update', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'alice_full');
    const f = await create(api, t, { phrase: 'old phrase', context: ['home', 'thread'] });
    let res = await api.put(`/api/v1/filters/${f.id}`, t, { phrase: 'new phrase' });
    expectStatus(res, 200, 'PUT /api/v1/filters/:id (phrase only)');
    let g = asFilter(res, 'PUT response');
    assertEq(g.phrase, 'new phrase', 'updated phrase');
    assertEq([...g.context].sort(), ['home', 'thread'], 'context must be unchanged by a phrase-only update');
    res = await api.put(`/api/v1/filters/${f.id}`, t, { context: ['notifications'] });
    expectStatus(res, 200, 'PUT /api/v1/filters/:id (context only)');
    g = asFilter(res, 'PUT response');
    assertEq(g.context, ['notifications'], 'updated context');
    assertEq(g.phrase, 'new phrase', 'phrase must be unchanged by a context-only update');
    const show = asFilter(await api.get(`/api/v1/filters/${f.id}`, t), 'GET after update');
    assertEq([show.phrase, show.context], ['new phrase', ['notifications']], 'stored filter after updates');
  }),

  // §3: delete → {} and gone.
  check('api.filters.delete', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'alice_full');
    const f = await create(api, t, { phrase: 'delete me', context: ['home'] });
    const res = await api.delete(`/api/v1/filters/${f.id}`, t);
    expectStatus(res, 200, 'DELETE /api/v1/filters/:id');
    assertEq(res.body, {}, 'DELETE response body');
    expectStatus(await api.get(`/api/v1/filters/${f.id}`, t), 404, 'GET of a deleted filter');
    assert(!(await listIds(api, t)).includes(String(f.id)), 'deleted filter still listed');
  }),

  // §2 validations → 422, nothing created.
  check('api.filters.validation', true, async (ctx) => {
    const { api } = ctx;
    const t = tok(ctx, 'alice_full');
    const before = await listIds(api, t);
    const bad: Array<[string, Record<string, string | boolean | string[]>]> = [
      ['missing phrase', { context: ['home'] }],
      ['missing context', { phrase: 'no context' }],
      ['unknown context', { phrase: 'bogus', context: ['bogus'] }],
      ['irreversible without home/notifications', { phrase: 'irr', context: ['public', 'thread'], irreversible: true }],
    ];
    for (const [what, form] of bad) expectStatus(await api.post('/api/v1/filters', t, form), 422, `POST /api/v1/filters with ${what}`);
    assert(sameSet(await listIds(api, t), before), 'a rejected POST created a filter');
    const f = await create(api, t, { phrase: 'valid one', context: ['home'] });
    expectStatus(await api.put(`/api/v1/filters/${f.id}`, t, { context: ['bogus'] }), 422, 'PUT with an unknown context');
    const show = asFilter(await api.get(`/api/v1/filters/${f.id}`, t), 'GET after rejected PUT');
    assertEq(show.context, ['home'], 'context after a rejected PUT');
  }),

  // §3: another user's filter behaves like a missing one.
  check('api.filters.isolation', true, async (ctx) => {
    const { api } = ctx;
    const dave = tok(ctx, 'dave_full');
    const alice = tok(ctx, 'alice_full');
    const f = await create(api, dave, { phrase: 'dave private filter', context: ['home'] });
    expectStatus(await api.get(`/api/v1/filters/${f.id}`, alice), 404, "GET of another user's filter");
    expectStatus(await api.put(`/api/v1/filters/${f.id}`, alice, { phrase: 'hijacked' }), 404, "PUT of another user's filter");
    expectStatus(await api.delete(`/api/v1/filters/${f.id}`, alice), 404, "DELETE of another user's filter");
    assert(!(await listIds(api, alice)).includes(String(f.id)), "another user's filter appears in GET /api/v1/filters");
    const still = asFilter(await api.get(`/api/v1/filters/${f.id}`, dave), 'owner GET');
    assertEq(still.phrase, 'dave private filter', "the other user's filter must be unchanged");
    expectStatus(await api.get('/api/v1/filters/99999999999', alice), 404, 'GET of a non-existent filter');
  }),

  // §4 Home + §1: irreversible home filter drops matching statuses (case-insensitive).
  check('api.filters.irreversible_home', true, async (ctx) => {
    const s = await serverScenario(ctx);
    const dropped = posted(s, 'zebra_upper');
    const kept = posted(s, 'neutral');
    assert(s.home.includes(kept), 'a non-matching status from a followed account did not reach the home timeline (delivery broken)');
    assert(!s.home.includes(dropped), 'a status matching an irreversible home filter (different case) reached the home timeline');
  }),

  // §1: content warning is matched too.
  check('api.filters.irreversible_spoiler', false, async (ctx) => {
    const s = await serverScenario(ctx);
    assert(!s.home.includes(posted(s, 'zebra_cw')), 'a status whose content warning matches an irreversible home filter reached the home timeline');
  }),

  // §1: a phrase is matched as a whole; regex characters are literal.
  check('api.filters.phrase_literal', true, async (ctx) => {
    const s = await serverScenario(ctx);
    assert(s.home.includes(posted(s, 'zebra_split')), '"zebra ... crossing" (words not adjacent) was dropped by the phrase filter "zebra crossing"');
    assert(!s.home.includes(posted(s, 'cpp_match')), 'a status containing "C++" was not dropped by the irreversible filter "c++"');
    assert(s.home.includes(posted(s, 'cpp_nomatch')), 'a status without "c++" was dropped by the filter "c++" (regex semantics?)');
  }),

  // §4: own statuses are never filtered from the own home feed.
  check('api.filters.own_status', false, async (ctx) => {
    const s = await serverScenario(ctx);
    assert(s.home.includes(posted(s, 'zebra_own')), "alice's own status matching her irreversible filter was dropped from her home timeline");
  }),

  // §4: non-irreversible filters don't affect the server; §1 + context: only home/notifications filters drop.
  check('api.filters.hide_only_not_dropped', true, async (ctx) => {
    const s = await serverScenario(ctx);
    assert(s.home.includes(posted(s, 'pineapple')), 'a status matching a NON-irreversible filter was dropped by the server');
  }),

  // §1: expired filters never apply.
  check('api.filters.expired', false, async (ctx) => {
    const s = await serverScenario(ctx);
    assert(s.home.includes(posted(s, 'walrus')), 'a status matching an EXPIRED irreversible filter was dropped');
  }),

  // §4 Notifications: irreversible notifications filter suppresses mention notifications.
  check('api.filters.irreversible_notifications', true, async (ctx) => {
    const s = await serverScenario(ctx);
    const ok = posted(s, 'mention_ok');
    const filtered = posted(s, 'mention_filtered');
    assert(s.mentionNotified.includes(ok), 'a non-matching mention created no notification (delivery broken)');
    assert(!s.mentionNotified.includes(filtered), 'a mention matching an irreversible notifications filter still created a notification');
  }),

  // §4: changes take effect immediately (cache invalidated on change).
  check('api.filters.change_takes_effect', false, async (ctx) => {
    const s = await serverScenario(ctx);
    const t = tok(ctx, 'alice_full');
    expectStatus(await ctx.api.delete(`/api/v1/filters/${s.filterIds.zebra}`, t), 200, 'DELETE the zebra filter');
    const out = await ctx.rails('probe.rb', { posts: [{ key: 'zebra_after', author: 'bob', text: 'Another zebra crossing photo' }] });
    const id = out.ids?.zebra_after;
    assert(id, `posting failed: ${JSON.stringify(out.errors)}`);
    assert((await homeIds(ctx.api, t)).includes(String(id)), 'after deleting the filter, a matching status was still dropped (stale filter cache?)');
  }),
];
