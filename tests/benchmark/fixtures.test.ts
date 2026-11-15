import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const spec = readJson('benchmark/spec/fixtures.json');
const holdout = readJson('evaluator/holdout/fixtures.json');
const contract = parse(fs.readFileSync(path.join(root, 'benchmark/spec/api-contract.yaml'), 'utf8'));

const MIN = contract.components.schemas.Todo.properties.title.minLength as number;
const MAX = contract.components.schemas.Todo.properties.title.maxLength as number;
const ISO = new RegExp(contract.components.schemas.Todo.properties.createdAt.pattern);

/** Mirrors the contract: trim, then 1..200 Unicode code points. */
function isValidTitle(raw: string): boolean {
  const len = [...raw.trim()].length;
  return len >= MIN && len <= MAX;
}

interface Fixture {
  title: string;
  completed: boolean;
  createdAt: string;
}

function checkSets(sets: Record<string, { description: string; todos: Fixture[] }>) {
  for (const [name, set] of Object.entries(sets)) {
    expect(typeof set.description, name).toBe('string');
    let prev = '';
    for (const t of set.todos) {
      expect(Object.keys(t).sort(), name).toEqual(['completed', 'createdAt', 'title']);
      expect(isValidTitle(t.title), `${name}: ${t.title}`).toBe(true);
      expect(t.title, `${name}: stored titles are already trimmed`).toBe(t.title.trim());
      expect(typeof t.completed).toBe('boolean');
      expect(t.createdAt).toMatch(ISO);
      expect(t.createdAt > prev, `${name}: createdAt strictly ascending`).toBe(true);
      prev = t.createdAt;
    }
    const titles = set.todos.map((t) => t.title);
    expect(new Set(titles).size, `${name}: unique titles`).toBe(titles.length);
  }
}

describe('fixtures', () => {
  it('contract limits are 1..200 and fixture files agree', () => {
    expect([MIN, MAX]).toEqual([1, 200]);
    expect(spec.limits).toEqual({ titleMinLength: MIN, titleMaxLength: MAX });
    expect(holdout.limits).toEqual({ titleMinLength: MIN, titleMaxLength: MAX });
  });

  it('spec fixture sets are valid', () => checkSets(spec.sets));
  it('holdout fixture sets are valid', () => checkSets(holdout.sets));

  it('design set is a 4-5 item mix of active and completed todos', () => {
    const todos: Fixture[] = spec.sets.design.todos;
    expect(todos.length).toBeGreaterThanOrEqual(4);
    expect(todos.length).toBeLessThanOrEqual(5);
    expect(todos.some((t) => t.completed)).toBe(true);
    expect(todos.some((t) => !t.completed)).toBe(true);
  });

  it('holdout sets are separate from the visible ones and cover edge cases', () => {
    const visibleTitles = new Set(
      Object.values(spec.sets).flatMap((s: any) => s.todos.map((t: Fixture) => t.title)),
    );
    for (const [name, set] of Object.entries<any>(holdout.sets)) {
      expect(spec.sets[name], name).toBeUndefined();
      for (const t of set.todos) expect(visibleTitles.has(t.title), t.title).toBe(false);
    }
    const all: Fixture[] = Object.values<any>(holdout.sets).flatMap((s) => s.todos);
    expect(all.some((t) => [...t.title].length === MAX)).toBe(true);
    expect(all.some((t) => /[^\x00-\x7f]/.test(t.title))).toBe(true);
    expect(Object.values<any>(holdout.sets).some((s) => s.todos.length === 0)).toBe(true);
  });

  it('holdout invalid/boundary title lists agree with the contract', () => {
    for (const v of holdout.invalidTitles.values) expect(isValidTitle(v), JSON.stringify(v)).toBe(false);
    for (const v of holdout.boundaryTitles.values) expect(isValidTitle(v), JSON.stringify(v)).toBe(true);
  });
});
