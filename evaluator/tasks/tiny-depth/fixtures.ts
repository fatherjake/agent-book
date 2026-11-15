/**
 * HIDDEN fixtures and expectations for task tiny-depth. Every expectation here is derived from the
 * public spec (benchmark/tasks/tiny-depth/spec/feature.md), never from the reference code:
 *
 *   axis   centre = (best bid + best ask) / 2 (integer division; the best price of the only side when
 *          one side is empty); half = max(centre - lowest bid, highest ask - centre); the plot spans
 *          [centre - half, centre + half] linearly across its full width.
 *   level  left of the centre: the bid with the lowest price >= p, or the best bid when none;
 *          right of the centre: the ask with the highest price <= p, or the best ask when none.
 *   text   Total = fmt(cumulative size); Value = usd(sum over levels of price*size/1e6, each
 *          term truncated); prices with usd(); Mid/Spread like the order book's spread row.
 */

export const SCALE = 1_000_000n;
export type Level = [number, number];

export interface Book {
  market: string;
  best_bid: number | null;
  best_ask: number | null;
  oracle_price: number | null;
  mark_price: number | null;
  bids: Level[];
  asks: Level[];
}

// ---- formatting (same rules as ui/src/lib/scale.ts, which the spec tells the agent to use) -------

export function usd(v: bigint): string {
  const neg = v < 0n;
  const cents = ((neg ? -v : v) + SCALE / 200n) / (SCALE / 100n);
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (cents % 100n).toString().padStart(2, '0');
  return (neg ? '-$' : '$') + whole + '.' + frac;
}

export function fmt(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return (neg ? '-' : '') + (a / SCALE).toString() + '.' + (a % SCALE).toString().padStart(6, '0');
}

// ---- expectations --------------------------------------------------------------------------------

export interface Step {
  side: 'bid' | 'ask';
  price: bigint;
  total: bigint;
  value: bigint;
}

export interface Expected {
  bids: Step[];
  asks: Step[];
  centre: bigint;
  half: bigint;
  lo: bigint;
  hi: bigint;
  mid: bigint | null;
  spread: bigint | null;
}

function steps(side: 'bid' | 'ask', levels: Level[]): Step[] {
  let total = 0n;
  let value = 0n;
  return levels.map(([p, s]) => {
    const price = BigInt(p);
    const size = BigInt(s);
    total += size;
    value += (price * size) / SCALE;
    return { side, price, total, value };
  });
}

export function expected(book: Book): Expected | null {
  const bids = steps('bid', book.bids);
  const asks = steps('ask', book.asks);
  if (!bids.length && !asks.length) return null;
  const bb = bids[0]?.price;
  const ba = asks[0]?.price;
  const centre = bb != null && ba != null ? (bb + ba) / 2n : (bb ?? ba)!;
  let half = 0n;
  if (bids.length) half = centre - bids[bids.length - 1].price;
  if (asks.length && asks[asks.length - 1].price - centre > half) half = asks[asks.length - 1].price - centre;
  return {
    bids,
    asks,
    centre,
    half,
    lo: centre - half,
    hi: centre + half,
    mid: bb != null && ba != null ? centre : null,
    spread: bb != null && ba != null ? ba - bb : null,
  };
}

/** The level in effect at `price` (a float in scaled units), or null on an empty side. */
export function levelAt(e: Expected, price: number): Step | null {
  if (price < Number(e.centre)) {
    if (!e.bids.length) return null;
    let hit = e.bids[0];
    for (const r of e.bids) if (Number(r.price) >= price) hit = r;
    return hit;
  }
  if (!e.asks.length) return null;
  let hit = e.asks[0];
  for (const r of e.asks) if (Number(r.price) <= price) hit = r;
  return hit;
}

export function tooltipParts(s: Step): string[] {
  return [s.side === 'bid' ? 'Bid' : 'Ask', usd(s.price), fmt(s.total), usd(s.value)];
}

// ---- deterministic books -------------------------------------------------------------------------

function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A book around `centreUsd` with `nb` bids and `na` asks (at most 20 per side, as the API sends).
 * Each side spans about `bidSpanUsd` / `askSpanUsd` beyond its best price with irregular gaps
 * (multiples of 0.50, at least 0.50), and sizes from 0.001 to 2.5 in 0.001 steps.
 */
export function makeBook(seed: string, centreUsd: number, spreadCents: number, nb: number, na: number, bidSpanUsd: number, askSpanUsd: number, market = 'BTC-PERP'): Book {
  const r = rng(seed);
  const c = Math.round(centreUsd * 100);
  const side = (start: number, n: number, dir: 1 | -1, spanUsd: number): Level[] => {
    const weights = Array.from({ length: Math.max(n - 1, 0) }, () => 0.25 + r() * r() * 3);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const out: Level[] = [];
    let cents = start;
    for (let i = 0; i < n; i++) {
      if (i > 0) cents += dir * Math.max(50, Math.round((spanUsd * 100 * weights[i - 1]) / sum / 50) * 50);
      const size = (1 + Math.floor(r() * r() * 2500)) * 1000;
      out.push([cents * 10_000, size]);
    }
    return out;
  };
  const bids = side(c - Math.floor(spreadCents / 2), nb, -1, bidSpanUsd);
  const asks = side(c + Math.ceil(spreadCents / 2), na, 1, askSpanUsd);
  return {
    market,
    best_bid: bids[0]?.[0] ?? null,
    best_ask: asks[0]?.[0] ?? null,
    oracle_price: c * 10_000,
    mark_price: c * 10_000,
    bids,
    asks,
  };
}

export const emptyBook = (market = 'BTC-PERP'): Book => ({ market, best_bid: null, best_ask: null, oracle_price: null, mark_price: null, bids: [], asks: [] });

export interface SuiteFixtures {
  viewport: { width: number; height: number };
  main: Book;
  update: Book;
  oneSided: Book;
}

export const SUITES: Record<'dev' | 'holdout', SuiteFixtures> = {
  dev: {
    viewport: { width: 1440, height: 900 },
    main: makeBook('tiny-depth/dev/main', 50_000, 400, 12, 10, 70, 52),
    update: makeBook('tiny-depth/dev/update', 50_180.5, 300, 8, 14, 38, 64),
    oneSided: makeBook('tiny-depth/dev/one', 49_900, 200, 9, 0, 44, 0),
  },
  holdout: {
    viewport: { width: 1280, height: 800 },
    main: makeBook('tiny-depth/holdout/main', 48_250.25, 600, 9, 15, 40, 58),
    update: makeBook('tiny-depth/holdout/update', 48_011, 250, 16, 7, 66, 41),
    oneSided: makeBook('tiny-depth/holdout/one', 48_400, 200, 0, 11, 0, 37),
  },
};
