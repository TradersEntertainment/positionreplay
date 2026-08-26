/**
 * Generates the synthetic Hyperliquid fixture used by the adapter tests and by
 * `pnpm episodes --fixture`.
 *
 * This exists because the venue APIs are not reachable from every environment (see
 * docs/VERIFYING-M1.md). It is NOT a substitute for real data: it is shaped exactly
 * like a documented Hyperliquid response so the code paths are exercised, but the
 * numbers are invented. Real recordings come from `pnpm capture:hl`.
 *
 * Run: pnpm tsx scripts/make-synthetic-fixture.ts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'hyperliquid', 'synthetic');

/**
 * Drop the cache built from the previous version of this fixture.
 *
 * SPEC §10 treats a closed candle as immutable and caches it forever, which is right
 * for a venue and wrong for a file that was just regenerated: without this, the next
 * run is served the *old* bars and the fixture appears not to have changed at all.
 */
function dropFixtureCache(venue: string, fixture: string): void {
  const slug = `${venue}-${fixture}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const base = join(ROOT, '.data', `cache-fixture-${slug}.db`);
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${base}${suffix}`, { force: true });
}


/** Deterministic PRNG — the fixture must be byte-identical on every regeneration. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;
const BASE = Date.UTC(2025, 10, 1, 0, 0, 0);
const TAKER_FEE = 0.00045;

interface Leg {
  coin: string;
  hours: number;
  side: 'A' | 'B';
  px: number;
  sz: number;
}

/**
 * A history chosen to exercise every branch of the §5 fold:
 * scale-in, partial close, full close, a short, a flip through zero, and a second
 * instrument so grouping is covered.
 */
const LEGS: Leg[] = [
  { coin: 'HYPE', hours: 0, side: 'B', px: 13.5, sz: 1000 }, // open long
  { coin: 'HYPE', hours: 18, side: 'B', px: 12.8, sz: 500 }, // scale in
  { coin: 'HYPE', hours: 50, side: 'A', px: 15.2, sz: 600 }, // partial close
  { coin: 'HYPE', hours: 96, side: 'A', px: 16.8, sz: 900 }, // close
  { coin: 'HYPE', hours: 120, side: 'A', px: 18.0, sz: 800 }, // open short
  { coin: 'HYPE', hours: 160, side: 'B', px: 16.5, sz: 1200 }, // FLIP short -> long
  { coin: 'HYPE', hours: 200, side: 'A', px: 17.25, sz: 400 }, // close the flipped long
  { coin: 'BTC', hours: 30, side: 'B', px: 92_000, sz: 0.5 }, // second instrument
  { coin: 'BTC', hours: 140, side: 'A', px: 97_400, sz: 0.5 },
];

interface HlFillOut {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  feeToken: string;
  tid: number;
}

/**
 * Fold the legs the same way SPEC §5 does, so the `dir` labels and `closedPnl`
 * values in the fixture are internally consistent. A fixture whose venue fields
 * disagreed with its own fills would make the cross-check tests meaningless.
 */
function buildFills(): HlFillOut[] {
  const state = new Map<string, { net: number; avg: number }>();
  const out: HlFillOut[] = [];
  let tid = 800_000;

  for (const leg of LEGS) {
    const s = state.get(leg.coin) ?? { net: 0, avg: 0 };
    const signed = leg.side === 'B' ? leg.sz : -leg.sz;
    const wasLong = s.net > 0;
    let closedPnl = 0;
    let dir: string;

    if (Math.abs(s.net) < 1e-9) {
      dir = signed > 0 ? 'Open Long' : 'Open Short';
      s.avg = leg.px;
      s.net = signed;
    } else if (Math.sign(signed) === Math.sign(s.net)) {
      dir = wasLong ? 'Open Long' : 'Open Short';
      s.avg = (s.avg * Math.abs(s.net) + leg.px * leg.sz) / (Math.abs(s.net) + leg.sz);
      s.net += signed;
    } else {
      const closedQty = Math.min(leg.sz, Math.abs(s.net));
      closedPnl = (leg.px - s.avg) * closedQty * (wasLong ? 1 : -1);
      const remainder = leg.sz - closedQty;
      if (remainder > 1e-9) {
        dir = wasLong ? 'Long > Short' : 'Short > Long';
        s.net = Math.sign(signed) * remainder;
        s.avg = leg.px;
      } else {
        dir = wasLong ? 'Close Long' : 'Close Short';
        s.net += signed;
        if (Math.abs(s.net) < 1e-9) {
          s.net = 0;
          s.avg = 0;
        }
      }
    }

    state.set(leg.coin, s);

    out.push({
      coin: leg.coin,
      px: String(leg.px),
      sz: String(leg.sz),
      side: leg.side,
      time: BASE + leg.hours * HOUR,
      startPosition: (signed > 0 ? s.net - signed : s.net - signed).toFixed(4),
      dir,
      closedPnl: closedPnl.toFixed(6),
      hash: `0x${(tid + 7).toString(16).padStart(12, '0')}fixture`,
      oid: tid * 3,
      crossed: true,
      fee: (leg.px * leg.sz * TAKER_FEE).toFixed(6),
      feeToken: 'USDC',
      tid: tid++,
    });
  }

  return out.sort((a, b) => a.time - b.time);
}

/** Piecewise-linear price path through the fill prices. No noise — the walk adds it. */
function anchorAt(coin: string, t: number): number {
  const anchors = LEGS.filter((l) => l.coin === coin).map((l) => ({
    t: BASE + l.hours * HOUR,
    p: l.px,
  }));
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;

  let base: number;
  if (t <= first.t) base = first.p * (1 - 0.04 * ((first.t - t) / (24 * HOUR)));
  else if (t >= last.t) base = last.p * (1 + 0.02 * ((t - last.t) / (24 * HOUR)));
  else {
    let lo = anchors[0]!;
    let hi = anchors[anchors.length - 1]!;
    for (let i = 0; i < anchors.length - 1; i++) {
      if (t >= anchors[i]!.t && t <= anchors[i + 1]!.t) {
        lo = anchors[i]!;
        hi = anchors[i + 1]!;
        break;
      }
    }
    const span = hi.t - lo.t || 1;
    base = lo.p + ((hi.p - lo.p) * (t - lo.t)) / span;
  }

  return base;
}

interface HlCandleOut {
  T: number;
  c: string;
  h: string;
  i: string;
  l: string;
  n: number;
  o: string;
  s: string;
  t: number;
  v: string;
}

function buildCandles(coin: string, interval: string, stepMs: number, decimals: number): HlCandleOut[] {
  const rand = mulberry32(coin === 'HYPE' ? 42 : 99);
  const from = BASE - 24 * HOUR;
  const to = BASE + 232 * HOUR;
  const bars: HlCandleOut[] = [];

  // A continuous walk: each bar opens where the last one closed. Drawing open and
  // close from independent noise made half the bars print red inside a clean uptrend.
  let prevClose = anchorAt(coin, from);

  for (let t = from; t < to; t += stepMs) {
    const o = prevClose;
    const c = anchorAt(coin, t + stepMs) * (1 + (rand() - 0.5) * 0.005);
    prevClose = c;
    const drift = Math.abs(c - o) + o * 0.0018;
    const h = Math.max(o, c) + drift * rand();
    const l = Math.min(o, c) - drift * rand();
    bars.push({
      t,
      T: t + stepMs - 1,
      s: coin,
      i: interval,
      o: o.toFixed(decimals),
      c: c.toFixed(decimals),
      h: h.toFixed(decimals),
      l: l.toFixed(decimals),
      v: (1000 + rand() * 9000).toFixed(2),
      n: Math.floor(50 + rand() * 500),
    });
  }

  return bars;
}

interface HlFundingOut {
  time: number;
  hash: string;
  delta: {
    type: 'funding';
    coin: string;
    usdc: string;
    szi: string;
    fundingRate: string;
  };
}

/** Funding accrues hourly while a position is open. Negative usdc = the trader paid. */
function buildFunding(): HlFundingOut[] {
  const rand = mulberry32(7);
  const out: HlFundingOut[] = [];

  for (const coin of ['HYPE', 'BTC']) {
    const legs = LEGS.filter((l) => l.coin === coin);
    const start = BASE + legs[0]!.hours * HOUR;
    const end = BASE + legs[legs.length - 1]!.hours * HOUR;
    let net = 0;
    let index = 0;

    for (let t = start; t <= end; t += 8 * HOUR) {
      // Track net size at t so the funding amount is proportional to exposure.
      net = 0;
      for (const l of legs) {
        if (BASE + l.hours * HOUR <= t) net += l.side === 'B' ? l.sz : -l.sz;
      }
      if (Math.abs(net) < 1e-9) continue;

      const rate = (rand() - 0.45) * 0.00004;
      const notional = Math.abs(net) * (coin === 'HYPE' ? 15 : 94_000);
      out.push({
        time: t,
        hash: `0xfund${(index++).toString().padStart(6, '0')}${coin.toLowerCase()}`,
        delta: {
          type: 'funding',
          coin,
          // Long pays a positive rate, so the cash flow is the negative of it.
          usdc: (-(net > 0 ? 1 : -1) * rate * notional).toFixed(6),
          szi: net.toFixed(4),
          fundingRate: rate.toFixed(10),
        },
      });
    }
  }

  return out.sort((a, b) => a.time - b.time);
}

// Only the intervals §6.1 can actually select for these episode lengths. Generating
// finer ones just bloats the repo with data no code path reads.
const INTERVALS: [string, number, number][] = [
  ['15m', 15 * 60_000, 4],
  ['30m', 30 * 60_000, 4],
  ['1h', HOUR, 4],
  ['2h', 2 * HOUR, 4],
  ['4h', 4 * HOUR, 4],
];

function write(relative: string, data: unknown, compact = false): void {
  const path = join(OUT, relative);
  mkdirSync(dirname(path), { recursive: true });
  // Candle arrays are long and nobody reads them by eye; fills and funding are short
  // and are worth keeping diffable.
  writeFileSync(path, `${compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`);
  console.log(`  wrote ${relative}`);
}

const fills = buildFills();
console.log(`Generating synthetic Hyperliquid fixture into fixtures/hyperliquid/synthetic`);
write('fills.json', fills);
write('funding.json', buildFunding());

for (const coin of ['HYPE', 'BTC']) {
  for (const [interval, stepMs, decimals] of INTERVALS) {
    write(
      `candles/${coin}-${interval}.json`,
      buildCandles(coin, interval, stepMs, coin === 'BTC' ? 1 : decimals),
      true,
    );
  }
}

write('meta.json', {
  provenance: 'SYNTHETIC — generated by scripts/make-synthetic-fixture.ts',
  warning:
    'These numbers are invented. They are shaped like documented Hyperliquid responses ' +
    'so the adapter code paths are exercised offline, but they prove nothing about the ' +
    'live venue contract. Real recordings come from `pnpm capture:hl`.',
  address: '0x0000000000000000000000000000000000000000',
  generatedFrom: 'deterministic seed; regeneration is byte-identical',
  fillCount: fills.length,
  range: { from: BASE - 24 * HOUR, to: BASE + 232 * HOUR },
});

console.log('Done.');

// Last, so a generator that threw leaves the old fixture and its cache consistent.
dropFixtureCache('hyperliquid', 'synthetic');
