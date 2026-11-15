import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BROWSER_SCENARIO_IDS,
  buildVariant,
  loadDesignFixtures,
  loadFixtureSets,
  mulberry32,
  parseFixtureSets,
  Rng,
  seedFromString,
  seedTodos,
} from '../../evaluator/fixtures.js';

describe('PRNG', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(124)()).not.toBe(mulberry32(123)());
  });

  it('shuffle is a permutation and fork streams are stable', () => {
    const r = new Rng(9);
    const s = r.shuffle([1, 2, 3, 4, 5, 6]);
    expect([...s].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Rng(9).fork('x').next()).toBe(new Rng(9).fork('x').next());
    expect(new Rng(9).fork('x').next()).not.toBe(new Rng(9).fork('y').next());
  });

  it('seedFromString is stable', () => {
    expect(seedFromString('run-1')).toBe(seedFromString('run-1'));
    expect(seedFromString('run-1')).not.toBe(seedFromString('run-2'));
  });
});

describe('fixtures', () => {
  it('parses {sets:{name:{todos}}}, {name:[...]} and string items', () => {
    expect(parseFixtureSets({ sets: { a: { todos: [{ title: 'x', completed: true }] } } })).toEqual({ a: [{ title: 'x', completed: true }] });
    expect(parseFixtureSets({ b: [{ title: 'y' }, 'z'] })).toEqual({ b: [{ title: 'y', completed: false }, { title: 'z', completed: false }] });
  });

  it('loads the dev fixtures and the design set from the spec', () => {
    const dev = loadFixtureSets('dev');
    expect(dev.source).toMatch(/fixtures\.json$/);
    const design = loadDesignFixtures();
    expect(design.length).toBeGreaterThan(0);
    expect(design.some((t) => t.completed)).toBe(true);
  });

  it('holdout uses the hidden invalid/boundary title lists; dev uses built-in ones', () => {
    const h = buildVariant('holdout', 1);
    const d = buildVariant('dev', 1);
    expect(h.invalidTitles.length).toBeGreaterThan(0);
    expect(h.boundaryTitles.length).toBeGreaterThan(0);
    expect(h.invalidTitles).not.toEqual(d.invalidTitles);
    for (const t of [...h.invalidTitles, ...d.invalidTitles]) {
      const n = [...t.trim()].length;
      expect(n === 0 || n > 200).toBe(true);
    }
    for (const t of [...h.boundaryTitles, ...d.boundaryTitles]) {
      const n = [...t.trim()].length;
      expect(n >= 1 && n <= 200).toBe(true);
    }
  });

  it('buildVariant is deterministic for the same (suite, seed)', () => {
    expect(buildVariant('dev', 42)).toEqual(buildVariant('dev', 42));
    expect(buildVariant('holdout', 7)).toEqual(buildVariant('holdout', 7));
  });

  it('different seeds and suites vary titles / orders', () => {
    const variants = [1, 2, 3, 4, 5].map((s) => buildVariant('dev', s));
    expect(new Set(variants.map((v) => v.titles.create)).size).toBeGreaterThan(1);
    expect(new Set(variants.map((v) => v.browserScenarioOrder.join())).size).toBeGreaterThan(1);
    const dev = buildVariant('dev', 1);
    const hold = buildVariant('holdout', 1);
    expect(dev.titles.create).not.toBe(hold.titles.create);
    expect(dev.fixtureSource).not.toBe(hold.fixtureSource);
  });

  it('variant titles are unique and never substrings of each other or of fixture titles', () => {
    for (const suite of ['dev', 'holdout'] as const) {
      for (let seed = 0; seed < 30; seed++) {
        const v = buildVariant(suite, seed);
        const titles = Object.values(v.titles).map((t) => t.toLowerCase());
        const fixtureTitles = Object.values(loadFixtureSets(suite).sets)
          .flat()
          .map((t) => t.title.toLowerCase());
        for (const t of titles) {
          expect(titles.filter((o) => o !== t && (o.includes(t) || t.includes(o)))).toEqual([]);
          expect(fixtureTitles.some((f) => f.includes(t) || t.includes(f))).toBe(false);
        }
        expect([...v.tooLongTitle.trim()].length).toBe(201);
        expect(v.mixedSet.some((t) => t.completed)).toBe(true);
        expect(v.mixedSet.some((t) => !t.completed)).toBe(true);
        expect([...v.browserScenarioOrder].sort()).toEqual([...BROWSER_SCENARIO_IDS].sort());
        expect([...v.sequenceOrder].sort()).toEqual(['complete', 'delete', 'edit', 'reopen']);
      }
    }
  });
});

describe('seedTodos', () => {
  // Tiny in-memory fake of the todo API (test double, not the app under test).
  let server: http.Server;
  let url = '';
  const calls: string[] = [];
  beforeAll(async () => {
    const todos: Array<{ id: number; title: string; completed: boolean; createdAt: string }> = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url} ${body}`);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') {
          const t = { id: todos.length + 1, title: JSON.parse(body).title, completed: false, createdAt: new Date().toISOString() };
          todos.push(t);
          res.statusCode = 201;
          res.end(JSON.stringify(t));
        } else if (req.method === 'PATCH') {
          const t = todos[Number(req.url!.split('/').pop()) - 1];
          Object.assign(t, JSON.parse(body));
          res.end(JSON.stringify(t));
        } else res.end(JSON.stringify(todos));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('creates in order and PATCHes completed ones', async () => {
    const created = await seedTodos(url, [
      { title: 'a', completed: false },
      { title: 'b', completed: true },
    ]);
    expect(created.map((t) => [t.title, t.completed])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(calls).toEqual(['POST /api/todos {"title":"a"}', 'POST /api/todos {"title":"b"}', 'PATCH /api/todos/2 {"completed":true}']);
  });
});
