/**
 * Unit tests for the hidden Mastodon checks (no Docker needed): rspec report mapping, Link header
 * parsing, runner output parsing, and consistency of the task definitions with the hidden
 * upstream spec copies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFrugalJson } from './evaluate.js';
import { encodeForm, parseLinkHeader } from './http.js';
import { parseRspecJson, regressionCheckId, regressionChecks, upstreamChecks, type ExpectedExample, type RspecReport } from './rspec.js';
import { FORWARDER_SCRIPT } from './container.js';
import * as bookmarks from '../mastodon-bookmarks/index.js';
import * as filters from '../mastodon-filters/index.js';

const ex = (file: string, full: string, status: string, exception?: RspecReport['examples'][0]['exception']) => ({
  file_path: `./${file}`,
  full_description: full,
  status,
  line_number: 1,
  exception,
});

describe('rspec mapping', () => {
  const expected: ExpectedExample[] = [
    { id: 'upstream.a:one', file: 'spec/a_spec.rb', fullDescription: 'A one', mandatory: true },
    { id: 'upstream.a:two', file: 'spec/a_spec.rb', fullDescription: 'A two', mandatory: false },
    { id: 'upstream.b:three', file: 'spec/b_spec.rb', fullDescription: 'B three', mandatory: true },
  ];

  it('maps passed / failed / missing examples', () => {
    const report: RspecReport = {
      examples: [ex('spec/a_spec.rb', 'A one', 'passed'), ex('spec/a_spec.rb', 'A two', 'failed', { class: 'RSpec::Expectations::ExpectationNotMetError', message: 'expected 200' })],
      summary: { errors_outside_of_examples_count: 1 },
      messages: ["An error occurred while loading ./spec/b_spec.rb.\nNameError: uninitialized constant Foo"],
    };
    const checks = upstreamChecks(expected, [{ report }]);
    expect(checks.map((c) => [c.id, c.outcome, c.mandatory, c.category])).toEqual([
      ['upstream.a:one', 'pass', true, 'backend'],
      ['upstream.a:two', 'fail', false, 'backend'],
      ['upstream.b:three', 'fail', true, 'backend'],
    ]);
    expect(checks[1].message).toContain('expected 200');
    expect(checks[2].message).toContain('uninitialized constant Foo');
  });

  it('a missing report fails every expected example with the note', () => {
    const checks = upstreamChecks(expected, [{ report: null, note: 'rspec upstream timed out' }]);
    expect(checks.every((c) => c.outcome === 'fail')).toBe(true);
    expect(checks[0].message).toContain('timed out');
  });

  it('aggregates regression per file and excludes upstream examples', () => {
    const report: RspecReport = {
      examples: [
        ex('spec/x_spec.rb', 'X ok', 'passed'),
        ex('spec/x_spec.rb', 'X pending', 'pending'),
        ex('spec/y_spec.rb', 'Y ok', 'passed'),
        ex('spec/y_spec.rb', 'Y bad', 'failed', { class: 'E', message: 'boom' }),
        ex('spec/a_spec.rb', 'A one', 'failed', { class: 'E', message: 'upstream failure' }),
        ex('spec/a_spec.rb', 'A old', 'passed'),
      ],
    };
    const checks = regressionChecks(
      [
        { file: 'spec/x_spec.rb', mandatory: true },
        { file: 'spec/y_spec.rb', mandatory: true },
        { file: 'spec/a_spec.rb', mandatory: true },
        { file: 'spec/z_spec.rb', mandatory: false },
      ],
      [{ report }],
      expected,
    );
    expect(checks.map((c) => [c.id, c.outcome])).toEqual([
      ['regression.x', 'pass'],
      ['regression.y', 'fail'],
      ['regression.a', 'pass'],
      ['regression.z', 'fail'],
    ]);
    expect(checks[1].message).toContain('boom');
  });

  it('parses the json out of noisy output and builds ids', () => {
    expect(parseRspecJson('warning: foo\n{"examples":[],"summary":{}}\n')).toEqual({ examples: [], summary: {} });
    expect(parseRspecJson('not json')).toBeNull();
    expect(regressionCheckId('./spec/controllers/api/v1/favourites_controller_spec.rb')).toBe('regression.controllers/api/v1/favourites_controller');
  });
});

describe('http helpers', () => {
  it('parses Link headers', () => {
    const h = '<http://127.0.0.1:5000/api/v1/bookmarks?limit=1&max_id=7>; rel="next", <http://127.0.0.1:5000/api/v1/bookmarks?limit=1&since_id=7>; rel="prev"';
    expect(parseLinkHeader(h)).toEqual({
      next: 'http://127.0.0.1:5000/api/v1/bookmarks?limit=1&max_id=7',
      prev: 'http://127.0.0.1:5000/api/v1/bookmarks?limit=1&since_id=7',
    });
    expect(parseLinkHeader(null)).toEqual({});
  });
  it('encodes arrays as key[]', () => {
    expect(encodeForm({ phrase: 'a b', context: ['home', 'public'], irreversible: true, x: undefined })).toBe('phrase=a+b&context%5B%5D=home&context%5B%5D=public&irreversible=true');
  });
  it('extracts the last FRUGAL_JSON line', () => {
    expect(extractFrugalJson('noise\nFRUGAL_JSON:{"a":1}\nmore\nFRUGAL_JSON:{"a":2}\n')).toEqual({ a: 2 });
    expect(extractFrugalJson('nothing')).toBeUndefined();
  });
  it('forwarder script is ES5 (runs on Node 8)', () => {
    expect(FORWARDER_SCRIPT).not.toMatch(/=>|\bconst\b|\blet\b|`|catch\s*\{/);
  });
});

/** Full descriptions of the `it` blocks of an RSpec file (indentation-based; enough for these files). */
function rspecFullDescriptions(file: string): string[] {
  const out: string[] = [];
  const stack: Array<{ indent: number; desc: string }> = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\s*)(?:RSpec\.)?(describe|context|it)\s+(?:(['"])(.*?)\3|([A-Z][\w:]*))/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const desc = m[4] ?? m[5];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const join = (parts: string[]) => parts.reduce((acc, p) => (acc === '' ? p : /^[#.]|^::/.test(p) ? acc + p : `${acc} ${p}`), '');
    if (m[2] === 'it') out.push(join([...stack.map((s) => s.desc), desc]));
    else stack.push({ indent, desc });
  }
  return out;
}

describe.each([
  ['mastodon-bookmarks', bookmarks.TASK_DEFINITION],
  ['mastodon-filters', filters.TASK_DEFINITION],
])('%s task definition', (_id, def) => {
  it('expected upstream examples exist in the hidden upstream copies', () => {
    for (const x of def.expectedUpstream) {
      const up = def.upstreamFiles.find((f) => f.dest === x.file);
      expect(up, `no upstream file for ${x.file}`).toBeTruthy();
      const fulls = rspecFullDescriptions(path.join(def.dir, 'upstream', up!.src));
      expect(fulls).toContain(x.fullDescription);
    }
  });
  it('every upstream example of the new spec files is a check', () => {
    for (const f of def.upstreamFiles) {
      if (def.regression.some((r) => r.file === f.dest)) continue; // extended existing file: only the new examples
      const fulls = rspecFullDescriptions(path.join(def.dir, 'upstream', f.src));
      expect(fulls.sort()).toEqual(def.expectedUpstream.filter((x) => x.file === f.dest).map((x) => x.fullDescription).sort());
    }
  });
  it('check ids are unique and well-formed', () => {
    const ids = [
      ...def.expectedUpstream.map((x) => x.id),
      ...def.regression.map((r) => regressionCheckId(r.file)),
      ...def.apiChecks.map((c) => c.spec.id),
      ...def.uiChecks.map((c) => c.spec.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(upstream|regression|api|ui)\.[\w./:-]+$/);
  });
  it('hidden files exist', () => {
    for (const rb of def.rubyFiles) expect(fs.existsSync(path.resolve(def.dir, rb)), rb).toBe(true);
    for (const f of [...def.upstreamFiles, ...def.fabricators]) expect(fs.existsSync(path.join(def.dir, 'upstream', f.src)), f.src).toBe(true);
  });
});
