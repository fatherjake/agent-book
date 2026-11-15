import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTask } from '../../runner/tasks.js';
import { REPO_ROOT } from '../../runner/env.js';
import { findBannedTerm } from '../../researcher/config-guard.js';
import { emptyBook, expected, fmt, levelAt, makeBook, SUITES, tooltipParts, usd } from '../../evaluator/tasks/tiny-depth/fixtures.js';
import { referencePath, SHOTS } from '../../evaluator/tasks/tiny-depth/visual.js';

const M = 1_000_000;

describe('tiny-depth task registry', () => {
  it('loads with its prompt, spec, builder, evaluator and hidden reference', () => {
    const t = getTask('tiny-depth');
    expect(t.kind).toBe('brownfield');
    expect(t.workspace.snapshot).toBe('git-diff');
    expect(t.browserAgent).toBe('none');
    expect(existsSync(t.promptPath!)).toBe(true);
    expect(existsSync(join(t.specPath, 'feature.md'))).toBe(true);
    expect(existsSync(join(t.specPath, 'depth.png'))).toBe(true);
    // reference.diff is kept out of git (the repo is public); only present on machines that have it.
    expect(t.referenceDiffPaths).toEqual([join(REPO_ROOT, 'evaluator/tasks/tiny-depth/reference.diff')]);
    for (const suite of ['dev', 'holdout']) for (const shot of SHOTS) expect(existsSync(referencePath(suite, shot))).toBe(true);
  });

  it('the public spec and the baseline config contain no banned term', () => {
    const t = getTask('tiny-depth');
    const base = join(REPO_ROOT, 'configs', 'baseline');
    const files = [join(base, 'system-prompt.md'), ...readdirSync(join(base, 'skills')).map((f) => join(base, 'skills', f))];
    for (const f of files) expect(findBannedTerm(readFileSync(f, 'utf8'), t.bannedTerms), f).toBeNull();
  });
});

describe('tiny-depth expectations (spec §3, §4)', () => {
  const book = {
    market: 'X',
    best_bid: 100 * M,
    best_ask: 102 * M,
    oracle_price: null,
    mark_price: null,
    bids: [
      [100 * M, 2 * M],
      [98 * M, 1 * M],
      [90 * M, 3 * M],
    ] as [number, number][],
    asks: [
      [102 * M, 1 * M],
      [105 * M, 4 * M],
    ] as [number, number][],
  };

  it('centres on the mid and spans the farther side symmetrically', () => {
    const e = expected(book)!;
    expect(e.centre).toBe(101_000_000n);
    expect(e.lo).toBe(90_000_000n);
    expect(e.hi).toBe(112_000_000n);
    expect(e.mid).toBe(101_000_000n);
    expect(e.spread).toBe(2_000_000n);
  });

  it('picks the level in effect at a price on each side', () => {
    const e = expected(book)!;
    const at = (usdPrice: number) => levelAt(e, usdPrice * M)!.price / 1_000_000n;
    expect([100.5, 99, 95, 80].map(at)).toEqual([100n, 100n, 98n, 90n]);
    expect([101.5, 104, 111].map(at)).toEqual([102n, 102n, 105n]);
  });

  it('formats the tooltip parts like ui/src/lib/scale.ts', () => {
    const e = expected(book)!;
    expect(tooltipParts(e.bids[1])).toEqual(['Bid', '$98.00', '3.000000', '$298.00']);
    expect(usd(49_999_995_000n)).toBe('$50,000.00');
    expect(fmt(512_000n)).toBe('0.512000');
  });

  it('centres a one-sided book on its best price and has no expectation for an empty one', () => {
    const one = makeBook('t', 100, 200, 3, 0, 5, 0);
    expect(expected(one)!.centre).toBe(BigInt(one.best_bid!));
    expect(expected(one)!.mid).toBeNull();
    expect(expected(emptyBook())).toBeNull();
  });

  it('suite fixtures are deterministic, within the API limit of 20 levels, and spread over both halves', () => {
    for (const s of Object.values(SUITES)) {
      for (const b of [s.main, s.update]) {
        expect(b.bids.length).toBeLessThanOrEqual(20);
        expect(b.asks.length).toBeLessThanOrEqual(20);
        const e = expected(b)!;
        expect(Number(e.centre - e.bids[e.bids.length - 1].price) / Number(e.half)).toBeGreaterThan(0.5);
        expect(Number(e.asks[e.asks.length - 1].price - e.centre) / Number(e.half)).toBeGreaterThan(0.5);
      }
    }
    expect(makeBook('same', 50_000, 400, 5, 5, 20, 20)).toEqual(makeBook('same', 50_000, 400, 5, 5, 20, 20));
  });
});
