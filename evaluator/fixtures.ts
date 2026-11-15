/**
 * Fixture loading, deterministic variation and seeding.
 *
 * - Dev fixtures:     benchmark/spec/fixtures.json   (visible to the coding agent)
 * - Holdout fixtures: evaluator/holdout/fixtures.json (hidden)
 * - The "design" set (used for the visual comparison) always comes from the spec file.
 *
 * Every random choice (task names, action orders, which fixture set) comes from a seeded PRNG, and
 * the seed is recorded in the EvaluationResult, so a run's evaluation can be reproduced exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
export const DEV_FIXTURES_PATH = path.join(REPO_ROOT, 'benchmark', 'spec', 'fixtures.json');
export const HOLDOUT_FIXTURES_PATH = path.join(REPO_ROOT, 'evaluator', 'holdout', 'fixtures.json');

export type Suite = 'dev' | 'holdout';

export interface FixtureTodo {
  title: string;
  completed: boolean;
}
export type FixtureSets = Record<string, FixtureTodo[]>;

export interface ApiTodo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, good-enough deterministic PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly f: () => number;
  constructor(readonly seed: number) {
    this.f = mulberry32(seed);
  }
  next(): number {
    return this.f();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.f() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    if (!arr.length) throw new Error('pick from empty array');
    return arr[this.int(arr.length)];
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /** Derive an independent child stream (stable per label). */
  fork(label: string): Rng {
    let h = this.seed ^ 0x9e3779b9;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
    return new Rng(h >>> 0);
  }
}

/** Default seed when the caller supplies none: derived from a string (e.g. the runId). */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function normalizeTodo(x: unknown): FixtureTodo | null {
  if (typeof x === 'string') return { title: x, completed: false };
  if (x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string') {
    return { title: (x as { title: string }).title, completed: !!(x as { completed?: unknown }).completed };
  }
  return null;
}

function normalizeSet(v: unknown): FixtureTodo[] | null {
  const arr = Array.isArray(v)
    ? v
    : v && typeof v === 'object' && Array.isArray((v as { todos?: unknown }).todos)
      ? (v as { todos: unknown[] }).todos
      : null;
  if (!arr) return null;
  const todos = arr.map(normalizeTodo);
  return todos.every((t): t is FixtureTodo => t !== null) ? todos : null;
}

/** Parse a fixtures file. Accepts {sets:{name:[...]}} or {name:[...]} (items may be {todos:[...]}). */
export function parseFixtureSets(raw: unknown): FixtureSets {
  const root =
    raw && typeof raw === 'object' && (raw as { sets?: unknown }).sets && typeof (raw as { sets: unknown }).sets === 'object'
      ? (raw as { sets: Record<string, unknown> }).sets
      : (raw as Record<string, unknown>);
  const out: FixtureSets = {};
  if (Array.isArray(root)) {
    // An array of named sets: [{name, todos}]
    for (const item of root as unknown[]) {
      const name = (item as { name?: unknown })?.name;
      const set = normalizeSet(item);
      if (typeof name === 'string' && set) out[name] = set;
    }
    return out;
  }
  for (const [name, v] of Object.entries(root ?? {})) {
    const set = normalizeSet(v);
    if (set) out[name] = set;
  }
  return out;
}

function readSets(file: string): FixtureSets | null {
  if (!fs.existsSync(file)) return null;
  return parseFixtureSets(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Built-in fallback used only if a fixture file is missing (recorded in the report). */
const FALLBACK: Record<Suite, FixtureSets> = {
  dev: {
    small: [
      { title: 'Buy groceries', completed: false },
      { title: 'Walk the dog', completed: true },
      { title: 'Read a book', completed: false },
    ],
  },
  holdout: {
    errands: [
      { title: 'Renew passport', completed: true },
      { title: 'Book dentist appointment', completed: false },
      { title: 'Return library books', completed: false },
      { title: 'Pay electricity bill', completed: true },
    ],
    project: [
      { title: 'Draft Q3 roadmap', completed: false },
      { title: 'Review pull request #42', completed: false },
      { title: 'Café menu — update prices (50% off)', completed: true },
    ],
  },
};

export interface LoadedFixtures {
  sets: FixtureSets;
  source: string;
}

export function loadFixtureSets(suite: Suite): LoadedFixtures {
  const file = suite === 'dev' ? DEV_FIXTURES_PATH : HOLDOUT_FIXTURES_PATH;
  const sets = readSets(file);
  if (sets && Object.keys(sets).length) return { sets, source: path.relative(REPO_ROOT, file) };
  return { sets: FALLBACK[suite], source: `builtin-fallback:${suite}` };
}

/** The "design" fixture set from the spec (used for design.png and the visual comparison). */
export function loadDesignFixtures(): FixtureTodo[] {
  const sets = readSets(DEV_FIXTURES_PATH);
  if (!sets?.design) throw new Error(`no "design" set in ${DEV_FIXTURES_PATH}`);
  return sets.design;
}

// ---------------------------------------------------------------------------
// Variation
// ---------------------------------------------------------------------------

const POOLS: Record<Suite, { verbs: string[]; objects: string[] }> = {
  dev: {
    verbs: ['Buy', 'Clean', 'Call', 'Fix', 'Plan', 'Write', 'Water', 'Wash', 'Order', 'Check'],
    objects: ['groceries', 'the garage', 'grandma', 'the bike', 'a picnic', 'thank-you notes', 'the plants', 'the car', 'new shoes', 'the mail'],
  },
  holdout: {
    verbs: ['Schedule', 'Refactor', 'Archive', 'Translate', 'Sketch', 'Prune', 'Calibrate', 'Organise', 'Repaint', 'Defrost'],
    objects: ['the quarterly review', 'legacy invoices', 'the herb garden', 'Zoë’s birthday card', 'the 3D printer', 'café receipts', 'the attic', 'flight to São Paulo', 'old photos & letters', 'the freezer'],
  },
};

export interface ScenarioVariant {
  suite: Suite;
  seed: number;
  fixtureSource: string;
  /** Fixture set used to pre-populate most scenarios. */
  baseSetName: string;
  baseSet: FixtureTodo[];
  /** A mixed set (has both active and completed items) for filter tests. */
  mixedSet: FixtureTodo[];
  titles: {
    create: string;
    create2: string;
    editFrom: string;
    editTo: string;
    complete: string;
    reopen: string;
    remove: string;
    keep: string;
    persist: string;
    error: string;
    keyboard: string;
    mobile: string;
  };
  /** Over-limit (201 chars after trim) title. */
  tooLongTitle: string;
  /** Titles the API must reject (400) — holdout: from the hidden fixture file. */
  invalidTitles: string[];
  /** Titles the API must accept and store trimmed — holdout: from the hidden fixture file. */
  boundaryTitles: string[];
  /** Order in which the browser-agent scenarios run. */
  browserScenarioOrder: string[];
  /** Order of the operations in the deterministic "sequence" scenario. */
  sequenceOrder: Array<'complete' | 'reopen' | 'edit' | 'delete'>;
}

export const BROWSER_SCENARIO_IDS = [
  'create',
  'edit',
  'complete',
  'reopen',
  'delete',
  'filter',
  'persistence',
  'invalid_input',
  'api_error',
] as const;

/** Deterministically derive all scenario inputs from (suite, seed). */
export function buildVariant(suite: Suite, seed: number): ScenarioVariant {
  const rng = new Rng(seed);
  const { sets, source } = loadFixtureSets(suite);
  const names = Object.keys(sets).filter((n) => n !== 'design' && sets[n].length > 0);
  const candidates = names.length ? names : Object.keys(sets);
  const baseSetName = rng.fork('set').pick(candidates.sort());
  const baseSet = sets[baseSetName];

  // Mixed set: base set with completion pattern guaranteed to include both states.
  let mixedSet = baseSet.map((t) => ({ ...t }));
  if (mixedSet.length < 3) {
    mixedSet = [...mixedSet, ...FALLBACK[suite][Object.keys(FALLBACK[suite])[0]].map((t) => ({ ...t }))];
  }
  if (!mixedSet.some((t) => t.completed)) mixedSet[rng.int(mixedSet.length)].completed = true;
  if (!mixedSet.some((t) => !t.completed)) mixedSet[rng.int(mixedSet.length)].completed = false;
  mixedSet = dedupeTitles(mixedSet);

  const taken = new Set(Object.values(sets).flat().map((t) => t.title.toLowerCase()));
  const pool = POOLS[suite];
  const tr = rng.fork('titles');
  const fresh = (): string => {
    for (let i = 0; i < 1000; i++) {
      const t = `${tr.pick(pool.verbs)} ${tr.pick(pool.objects)} ${10 + tr.int(90)}`;
      const lower = t.toLowerCase();
      // Avoid any title that is a prefix/substring of another to keep accessible names unambiguous.
      if (![...taken].some((x) => x.includes(lower) || lower.includes(x))) {
        taken.add(lower);
        return t;
      }
    }
    throw new Error('could not generate a unique title');
  };
  const titles = {
    create: fresh(),
    create2: fresh(),
    editFrom: fresh(),
    editTo: fresh(),
    complete: fresh(),
    reopen: fresh(),
    remove: fresh(),
    keep: fresh(),
    persist: fresh(),
    error: fresh(),
    keyboard: fresh(),
    mobile: fresh(),
  };
  const filler = suite === 'dev' ? 'x' : 'é';
  const tooLongTitle = `${titles.create} `.padEnd(201, filler);

  const lists = loadTitleLists(suite);
  return {
    suite,
    seed,
    fixtureSource: source,
    invalidTitles: lists.invalid,
    boundaryTitles: lists.boundary,
    baseSetName,
    baseSet,
    mixedSet,
    titles,
    tooLongTitle,
    browserScenarioOrder: rng.fork('browser-order').shuffle(BROWSER_SCENARIO_IDS),
    sequenceOrder: rng.fork('sequence').shuffle(['complete', 'reopen', 'edit', 'delete'] as const),
  };
}

const DEV_TITLE_LISTS = {
  invalid: ['', '   ', '\t\n ', 'q'.repeat(201), `  ${'r'.repeat(201)}  `],
  boundary: ['b', '  trimmed title  ', 'm'.repeat(200), ` ${'n'.repeat(200)}\t`, 'ü'.repeat(200)],
};

/** invalidTitles/boundaryTitles lists ({values:[...]} or bare arrays) for the suite. */
export function loadTitleLists(suite: Suite): { invalid: string[]; boundary: string[] } {
  if (suite === 'dev' || !fs.existsSync(HOLDOUT_FIXTURES_PATH)) return DEV_TITLE_LISTS;
  const raw = JSON.parse(fs.readFileSync(HOLDOUT_FIXTURES_PATH, 'utf8')) as Record<string, unknown>;
  const list = (v: unknown): string[] | null => {
    const arr = Array.isArray(v) ? v : Array.isArray((v as { values?: unknown })?.values) ? (v as { values: unknown[] }).values : null;
    return arr && arr.every((x) => typeof x === 'string') ? (arr as string[]) : null;
  };
  return {
    invalid: list(raw.invalidTitles) ?? DEV_TITLE_LISTS.invalid,
    boundary: list(raw.boundaryTitles) ?? DEV_TITLE_LISTS.boundary,
  };
}

function dedupeTitles(todos: FixtureTodo[]): FixtureTodo[] {
  const seen = new Set<string>();
  return todos.filter((t) => {
    const k = t.title.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Seeding via the API
// ---------------------------------------------------------------------------

/** Thrown when the app's API rejects seeding: the app's fault, not the evaluator's. */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** Create todos in array order through the public API (POST, then PATCH for completed ones). */
export async function seedTodos(baseUrl: string, todos: FixtureTodo[]): Promise<ApiTodo[]> {
  const created: ApiTodo[] = [];
  for (const t of todos) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/todos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t.title }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new SeedError(`POST /api/todos failed while seeding: ${(e as Error).message}`);
    }
    if (res.status !== 201) throw new SeedError(`POST /api/todos returned ${res.status} while seeding "${t.title}"`);
    let todo = (await res.json().catch(() => null)) as ApiTodo | null;
    if (!todo || typeof todo.id !== 'number') throw new SeedError('POST /api/todos returned no todo with a numeric id');
    if (t.completed) {
      const p = await fetch(`${baseUrl}/api/todos/${todo.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: true }),
        signal: AbortSignal.timeout(10_000),
      }).catch((e: Error) => {
        throw new SeedError(`PATCH failed while seeding: ${e.message}`);
      });
      if (p.status !== 200) throw new SeedError(`PATCH /api/todos/${todo.id} returned ${p.status} while seeding`);
      todo = (await p.json().catch(() => todo)) as ApiTodo;
    }
    created.push(todo);
  }
  return created;
}

/** GET /api/todos from the host (independent of the browser). */
export async function apiList(baseUrl: string): Promise<ApiTodo[]> {
  const res = await fetch(`${baseUrl}/api/todos`, { signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) throw new SeedError(`GET /api/todos returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new SeedError('GET /api/todos did not return an array');
  return body as ApiTodo[];
}
