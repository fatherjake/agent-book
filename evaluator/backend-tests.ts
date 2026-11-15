/**
 * Deterministic backend tests: every endpoint, validation case, error code, the ordering rule,
 * persistence across an app restart, and DB-state checks (schema + rows equal what the API returns).
 *
 * Runs against a freshly launched app whose DB is empty. Talks to the API from the host with fetch
 * and reads the DB directly from the container, independent of the app's frontend.
 */
import type { CheckResult } from '../runner/types.js';
import type { LaunchedApp, TodoRow } from './app-launcher.js';
import { assert, assertEq, CheckCollector, trunc, type CheckSpec } from './checks.js';
import type { ApiTodo, ScenarioVariant } from './fixtures.js';

interface ApiResponse {
  status: number;
  body: unknown;
  text: string;
  contentType: string;
}

export async function apiCall(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: string } = {},
): Promise<ApiResponse> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(10_000), headers: {} };
  if (opts.raw !== undefined) {
    init.body = opts.raw;
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text, contentType: res.headers.get('content-type') ?? '' };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$/;

export function assertTodoShape(t: unknown, what: string): asserts t is ApiTodo {
  assert(t && typeof t === 'object', `${what}: expected a Todo object, got ${trunc(JSON.stringify(t) ?? 'undefined')}`);
  const o = t as Record<string, unknown>;
  assert(Number.isInteger(o.id), `${what}: id must be an integer (got ${JSON.stringify(o.id)})`);
  assert(typeof o.title === 'string', `${what}: title must be a string`);
  assert(typeof o.completed === 'boolean', `${what}: completed must be a boolean (got ${JSON.stringify(o.completed)})`);
  assert(
    typeof o.createdAt === 'string' && ISO_UTC.test(o.createdAt) && !Number.isNaN(Date.parse(o.createdAt)),
    `${what}: createdAt must be an ISO-8601 UTC string (got ${JSON.stringify(o.createdAt)})`,
  );
}

function expectError(res: ApiResponse, status: number, code: string, what: string): void {
  assert(res.status === status, `${what}: expected HTTP ${status}, got ${res.status} (${trunc(res.text, 200)})`);
  const err = (res.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  assert(err && typeof err === 'object', `${what}: expected body {error:{code,message}}, got ${trunc(res.text, 200)}`);
  assert(err.code === code, `${what}: expected error.code ${code}, got ${JSON.stringify(err.code)}`);
  assert(typeof err.message === 'string' && err.message.length > 0, `${what}: error.message must be a non-empty string`);
}

/** Compare DB rows to API todos (same ids, titles, completion, timestamps). */
export function compareDbToApi(rows: TodoRow[], todos: ApiTodo[]): string | null {
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  if (rows.length !== todos.length) return `DB has ${rows.length} rows but API returned ${todos.length} todos`;
  for (const t of todos) {
    const r = byId.get(t.id);
    if (!r) return `todo id ${t.id} returned by the API is missing from the DB`;
    if (r.title !== t.title) return `id ${t.id}: DB title ${JSON.stringify(r.title)} != API title ${JSON.stringify(t.title)}`;
    if (Number(r.completed) !== (t.completed ? 1 : 0))
      return `id ${t.id}: DB completed=${r.completed} != API completed=${t.completed}`;
    if (Date.parse(r.created_at) !== Date.parse(t.createdAt))
      return `id ${t.id}: DB created_at ${r.created_at} != API createdAt ${t.createdAt}`;
  }
  return null;
}

const M = (id: string): CheckSpec => ({ id, category: 'backend', mandatory: true });

export async function runBackendTests(app: LaunchedApp, variant: ScenarioVariant): Promise<CheckResult[]> {
  const c = new CheckCollector();
  const url = app.url;
  const T = variant.titles;
  const api = (method: string, path: string, body?: unknown, raw?: string) =>
    apiCall(url, method, path, body, raw !== undefined ? { raw } : {});
  const list = async (): Promise<ApiTodo[]> => {
    const r = await api('GET', '/api/todos');
    assert(r.status === 200, `GET /api/todos returned ${r.status}`);
    assert(Array.isArray(r.body), `GET /api/todos did not return a JSON array: ${trunc(r.text, 200)}`);
    return r.body as ApiTodo[];
  };
  const create = async (title: string): Promise<ApiTodo> => {
    const r = await api('POST', '/api/todos', { title });
    assert(r.status === 201, `POST /api/todos returned ${r.status} (${trunc(r.text, 200)})`);
    assertTodoShape(r.body, 'POST /api/todos response');
    return r.body;
  };

  await c.run(M('api.list.initial_empty'), async () => {
    const r = await api('GET', '/api/todos');
    assert(r.status === 200, `GET /api/todos returned ${r.status}`);
    assert(/application\/json/i.test(r.contentType), `GET /api/todos content-type is ${r.contentType || 'missing'}`);
    assertEq(r.body, [], 'GET /api/todos on a fresh database');
  });

  await c.run(M('api.frontend.served'), async () => {
    const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(10_000) });
    const html = await r.text();
    assert(r.status === 200, `GET / returned ${r.status}`);
    assert(/<script/i.test(html) && /<div[^>]+id=["']?root/i.test(html), 'GET / did not return the built frontend HTML');
  });

  let created: ApiTodo | null = null;
  await c.run(M('api.create.valid'), async () => {
    const before = Date.now();
    created = await create(T.create);
    assertEq(created.title, T.create, 'created title');
    assertEq(created.completed, false, 'created completed');
    const ts = Date.parse(created.createdAt);
    assert(Math.abs(ts - before) < 10 * 60_000, `createdAt ${created.createdAt} is not close to the current time`);
    const all = await list();
    assert(
      all.some((t) => t.id === created!.id && t.title === T.create),
      'created todo not returned by GET /api/todos',
    );
  });

  await c.run(M('api.create.trims_title'), async () => {
    const t = await create(`   ${T.create2}\t  `);
    assertEq(t.title, T.create2, 'title after trimming');
  });

  await c.run(M('api.create.max_length_200'), async () => {
    const title = 'A'.repeat(200);
    const t = await create(title);
    assertEq(t.title.length, 200, 'length of a 200-char title');
    const del = await api('DELETE', `/api/todos/${t.id}`);
    assert(del.status === 204, `cleanup DELETE returned ${del.status}`);
  });

  await c.run(M('api.create.ignores_unknown_fields'), async () => {
    const r = await api('POST', '/api/todos', { title: T.keep, foo: 'bar', priority: 3 });
    assert(r.status === 201, `POST with unknown fields returned ${r.status} (${trunc(r.text, 200)})`);
    assertTodoShape(r.body, 'POST response');
    assert(!('foo' in (r.body as object)), 'unknown field "foo" was echoed back in the Todo');
  });

  const countBefore = async () => (await list()).length;
  const invalidPosts: Array<[string, unknown, string?]> = [
    ['api.validation.create_empty_title', { title: '' }],
    ['api.validation.create_whitespace_title', { title: '   \t ' }],
    ['api.validation.create_too_long_title', { title: variant.tooLongTitle }],
    ['api.validation.create_missing_title', {}],
    ['api.validation.create_title_not_string', { title: 12345 }],
    ['api.validation.create_title_null', { title: null }],
    ['api.validation.create_malformed_json', undefined, '{"title": "oops"'],
  ];
  for (const [id, body, raw] of invalidPosts) {
    await c.run(M(id), async () => {
      const n = await countBefore();
      const r = await api('POST', '/api/todos', body, raw);
      expectError(r, 400, 'VALIDATION_ERROR', `POST ${raw ?? JSON.stringify(body)}`);
      const after = await countBefore();
      assertEq(after, n, 'number of todos after a rejected POST');
    });
  }

  await c.run(M('api.validation.invalid_titles'), async () => {
    const n = await countBefore();
    for (const title of variant.invalidTitles) {
      const r = await api('POST', '/api/todos', { title });
      expectError(r, 400, 'VALIDATION_ERROR', `POST title ${trunc(JSON.stringify(title), 40)} (${[...title.trim()].length} code points after trim)`);
    }
    assertEq(await countBefore(), n, 'number of todos after rejected titles');
  });

  await c.run(M('api.create.boundary_titles'), async () => {
    for (const title of variant.boundaryTitles) {
      const t = await create(title);
      assertEq(t.title, title.trim(), `stored title for ${trunc(JSON.stringify(title), 40)}`);
      const row = (await app.readDb()).find((x) => Number(x.id) === t.id);
      assertEq(row?.title, title.trim(), 'DB title (trimmed)');
      const del = await api('DELETE', `/api/todos/${t.id}`);
      assert(del.status === 204, `cleanup DELETE returned ${del.status}`);
    }
  });

  await c.run(M('api.patch.title'), async () => {
    const t = await create(T.editFrom);
    const r = await api('PATCH', `/api/todos/${t.id}`, { title: `  ${T.editTo} ` });
    assert(r.status === 200, `PATCH title returned ${r.status} (${trunc(r.text, 200)})`);
    assertTodoShape(r.body, 'PATCH response');
    assertEq(r.body.title, T.editTo, 'patched (trimmed) title');
    assertEq(r.body.id, t.id, 'id after PATCH');
    assertEq(r.body.completed, false, 'completed after title-only PATCH');
    assertEq(r.body.createdAt, t.createdAt, 'createdAt after PATCH');
    const row = (await app.readDb()).find((x) => Number(x.id) === t.id);
    assertEq(row?.title, T.editTo, 'DB title after PATCH');
  });

  await c.run(M('api.patch.completed'), async () => {
    const t = await create(T.complete);
    let r = await api('PATCH', `/api/todos/${t.id}`, { completed: true });
    assert(r.status === 200, `PATCH completed=true returned ${r.status}`);
    assertTodoShape(r.body, 'PATCH response');
    assertEq(r.body.completed, true, 'completed after PATCH true');
    assertEq(r.body.title, T.complete, 'title after completed-only PATCH');
    let row = (await app.readDb()).find((x) => Number(x.id) === t.id);
    assertEq(Number(row?.completed), 1, 'DB completed after PATCH true');
    r = await api('PATCH', `/api/todos/${t.id}`, { completed: false });
    assert(r.status === 200, `PATCH completed=false returned ${r.status}`);
    assertEq((r.body as ApiTodo).completed, false, 'completed after PATCH false');
    row = (await app.readDb()).find((x) => Number(x.id) === t.id);
    assertEq(Number(row?.completed), 0, 'DB completed after PATCH false');
  });

  await c.run(M('api.patch.both_fields_and_unknown'), async () => {
    const t = await create(T.reopen);
    const r = await api('PATCH', `/api/todos/${t.id}`, { title: `${T.reopen} (2)`, completed: true, bogus: 1 });
    assert(r.status === 200, `PATCH with both fields returned ${r.status}`);
    assertTodoShape(r.body, 'PATCH response');
    assertEq([r.body.title, r.body.completed], [`${T.reopen} (2)`, true], '[title, completed] after PATCH');
  });

  const invalidPatches: Array<[string, unknown]> = [
    ['api.validation.patch_empty_body', {}],
    ['api.validation.patch_only_unknown_fields', { foo: 1 }],
    ['api.validation.patch_empty_title', { title: '   ' }],
    ['api.validation.patch_too_long_title', { title: 'B'.repeat(201) }],
    ['api.validation.patch_title_not_string', { title: 42 }],
    ['api.validation.patch_completed_not_boolean', { completed: 'yes' }],
  ];
  let patchTarget: ApiTodo | null = null;
  for (const [id, body] of invalidPatches) {
    await c.run(M(id), async () => {
      patchTarget ??= await create(T.persist);
      const before = (await list()).find((x) => x.id === patchTarget!.id);
      const r = await api('PATCH', `/api/todos/${patchTarget.id}`, body);
      expectError(r, 400, 'VALIDATION_ERROR', `PATCH ${JSON.stringify(body)}`);
      const after = (await list()).find((x) => x.id === patchTarget!.id);
      assertEq(after, before, 'todo after a rejected PATCH');
    });
  }

  await c.run(M('api.patch.not_found'), async () => {
    expectError(await api('PATCH', '/api/todos/987654', { completed: true }), 404, 'NOT_FOUND', 'PATCH unknown id');
  });

  await c.run(M('api.delete'), async () => {
    const t = await create(T.remove);
    const r = await api('DELETE', `/api/todos/${t.id}`);
    assert(r.status === 204, `DELETE returned ${r.status}`);
    assert(r.text.length === 0, 'DELETE 204 response must have an empty body');
    assert(!(await list()).some((x) => x.id === t.id), 'deleted todo still returned by GET');
    assert(!(await app.readDb()).some((x) => Number(x.id) === t.id), 'deleted todo still present in the DB');
    expectError(await api('DELETE', `/api/todos/${t.id}`), 404, 'NOT_FOUND', 'second DELETE of the same id');
    expectError(await api('PATCH', `/api/todos/${t.id}`, { completed: true }), 404, 'NOT_FOUND', 'PATCH of a deleted id');
  });

  await c.run(M('api.delete.not_found'), async () => {
    expectError(await api('DELETE', '/api/todos/987654'), 404, 'NOT_FOUND', 'DELETE unknown id');
  });

  await c.run(M('api.id.non_integer'), async () => {
    for (const bad of ['abc', '1.5', '-1x', '%20']) {
      expectError(await api('PATCH', `/api/todos/${bad}`, { completed: true }), 404, 'NOT_FOUND', `PATCH /api/todos/${bad}`);
      expectError(await api('DELETE', `/api/todos/${bad}`), 404, 'NOT_FOUND', `DELETE /api/todos/${bad}`);
    }
  });

  await c.run(M('api.ordering'), async () => {
    // 1. Newly created todos appear in creation order (createdAt asc, id asc).
    const titles = [`${T.keyboard} A`, `${T.keyboard} B`, `${T.keyboard} C`];
    const made: ApiTodo[] = [];
    for (const t of titles) made.push(await create(t));
    let all = await list();
    const sorted = [...all].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
    assertEq(all.map((t) => t.id), sorted.map((t) => t.id), 'GET order vs (createdAt asc, id asc)');
    const idx = made.map((m) => all.findIndex((t) => t.id === m.id));
    assert(idx[0] < idx[1] && idx[1] < idx[2], 'todos are not listed in creation order');

    // 2. Rows inserted directly with older / identical timestamps: createdAt wins over id,
    //    and id breaks ties between identical timestamps.
    const old = '2001-01-01T00:00:00.000Z';
    const q = (x: string) => x.replace(/'/g, "''");
    await app.writeDb(
      `INSERT INTO todos (title, completed, created_at) VALUES ('${q(T.mobile)} late-id-1', 0, '${old}'), ('${q(T.mobile)} late-id-2', 1, '${old}')`,
    );
    all = await list();
    const firstTwo = all.slice(0, 2).map((t) => t.title);
    assertEq(firstTwo, [`${T.mobile} late-id-1`, `${T.mobile} late-id-2`], 'first two titles (older createdAt inserted with higher ids)');
    assertTodoShape(all[0], 'directly inserted row via GET');
    assertEq(all[1].completed, true, 'completed of a row with completed=1 in the DB');
  });

  await c.run(M('db.schema'), async () => {
    const { columns, sql } = await app.dbSchema();
    const got = columns.map((col) => ({
      name: col.name,
      type: col.type.toUpperCase(),
      // INTEGER PRIMARY KEY reports notnull=0 unless spelled out; only check the other columns.
      notnull: col.name === 'id' ? null : Number(col.notnull),
      pk: Number(col.pk),
    }));
    assertEq(
      got,
      [
        { name: 'id', type: 'INTEGER', notnull: null, pk: 1 },
        { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'completed', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
      ],
      'todos table columns',
    );
    assert(/AUTOINCREMENT/i.test(sql), 'todos.id must be INTEGER PRIMARY KEY AUTOINCREMENT');
    const dflt = columns.find((k) => k.name === 'completed')?.dflt_value;
    assert(dflt !== null && dflt !== undefined && String(dflt).replace(/['"()]/g, '') === '0', 'completed must DEFAULT 0');
  });

  await c.run(M('db.matches_api'), async () => {
    const [rows, todos] = [await app.readDb(), await list()];
    const diff = compareDbToApi(rows, todos);
    assert(!diff, diff ?? '');
    assert(todos.length >= 5, `expected at least 5 todos by now, found ${todos.length}`);
  });

  await c.run(M('api.persistence.restart'), async () => {
    const before = await list();
    assert(before.length > 0, 'nothing to persist (no todos exist)');
    await app.restart();
    const after = await list();
    assertEq(after, before, 'todos after restarting the app process');
  });

  return c.results;
}
