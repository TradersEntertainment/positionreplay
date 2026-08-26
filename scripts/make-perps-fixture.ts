/**
 * Generates the synthetic Polymarket Perps fixture.
 *
 * Same standing as the Hyperliquid one: shaped like a documented response so the
 * adapter's code paths run offline, but the numbers are invented and prove nothing
 * about the live contract. Real recordings come from `pnpm capture:pm`.
 *
 * It models what `/v1/info/fills` actually serves: the account's whole history. Two
 * positions are still open (one of them force-closed partway by a liquidation, so the
 * §4.4.3 marker has something to draw) and a third has been opened and fully closed —
 * which is the case the option-A path could never produce and the whole reason this
 * fixture was regenerated.
 *
 * The history is written as several small pages so the adapter's cursor walk is really
 * exercised. A single-page fixture would let a broken pagination loop pass.
 *
 * Run: pnpm tsx scripts/make-perps-fixture.ts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'polymarket-perps', 'synthetic');

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
const BASE = Date.UTC(2026, 7, 20, 0, 0, 0);
const TAKER_FEE = 0.0004;

const INSTRUMENTS = [
  { instrument_id: 1, symbol: 'BTC-PERP', quantity_decimals: 4, price_decimals: 1, category: 'crypto', base_asset: 'BTC', quote_asset: 'pUSD', funding_interval: 3_600_000, max_leverage: 20, isolated_only: false },
  { instrument_id: 2, symbol: 'ETH-PERP', quantity_decimals: 3, price_decimals: 2, category: 'crypto', base_asset: 'ETH', quote_asset: 'pUSD', funding_interval: 3_600_000, max_leverage: 20, isolated_only: false },
  { instrument_id: 3, symbol: 'SOL-PERP', quantity_decimals: 2, price_decimals: 3, category: 'crypto', base_asset: 'SOL', quote_asset: 'pUSD', funding_interval: 3_600_000, max_leverage: 20, isolated_only: false },
];

/** Fills to a page of `/v1/info/fills`. Small on purpose — see the header comment. */
const HISTORY_PAGE = 3;

interface Leg {
  instrument_id: number;
  hours: number;
  side: 'long' | 'short';
  price: number;
  quantity: number;
  liquidation?: boolean;
  adl?: boolean;
}

/**
 * BTC scales in and takes a partial liquidation; ETH is a plain short; both end open.
 * SOL opens and closes completely, which is the case `/v1/info/fills` made reachable.
 */
const LEGS: Leg[] = [
  { instrument_id: 1, hours: 0, side: 'long', price: 92_000, quantity: 0.5 },
  { instrument_id: 3, hours: 2, side: 'long', price: 178.4, quantity: 40 },
  { instrument_id: 2, hours: 6, side: 'short', price: 3_150, quantity: 4 },
  { instrument_id: 3, hours: 11, side: 'long', price: 171.25, quantity: 25 },
  { instrument_id: 1, hours: 14, side: 'long', price: 89_500, quantity: 0.3 },
  { instrument_id: 3, hours: 19, side: 'short', price: 196.8, quantity: 65 },
  { instrument_id: 2, hours: 26, side: 'short', price: 3_310, quantity: 2 },
  { instrument_id: 1, hours: 30, side: 'short', price: 84_200, quantity: 0.4, liquidation: true },
];

interface PmFillOut {
  trade_id: string;
  order_id: string;
  instrument_id: number;
  side: 'long' | 'short';
  price: string;
  quantity: string;
  taker: boolean;
  fee: string;
  fee_asset: string;
  previous_size: string;
  previous_entry_price: string;
  pnl: string;
  timestamp: number;
  liquidation: boolean;
  adl: boolean;
  hash: string;
}

/**
 * Fold the legs the way SPEC §5 does, so `previous_size` and `previous_entry_price`
 * describe the state genuinely preceding each fill. A fixture whose oracle disagreed
 * with its own fills would make the cross-check meaningless.
 */
function buildFills(): { fills: PmFillOut[]; finalSizes: Map<number, { size: number; entry: number }> } {
  const state = new Map<number, { net: number; avg: number }>();
  const out: PmFillOut[] = [];
  let tradeId = 5_000;

  for (const leg of [...LEGS].sort((a, b) => a.hours - b.hours)) {
    const instrument = INSTRUMENTS.find((i) => i.instrument_id === leg.instrument_id)!;
    const s = state.get(leg.instrument_id) ?? { net: 0, avg: 0 };
    const previousSize = s.net;
    const previousEntry = s.avg;

    const signed = leg.side === 'long' ? leg.quantity : -leg.quantity;
    let pnl = 0;

    if (Math.abs(s.net) < 1e-9) {
      s.avg = leg.price;
      s.net = signed;
    } else if (Math.sign(signed) === Math.sign(s.net)) {
      s.avg = (s.avg * Math.abs(s.net) + leg.price * leg.quantity) / (Math.abs(s.net) + leg.quantity);
      s.net += signed;
    } else {
      const closedQty = Math.min(leg.quantity, Math.abs(s.net));
      pnl = (leg.price - s.avg) * closedQty * (s.net > 0 ? 1 : -1);
      s.net += signed;
      if (Math.abs(s.net) < 1e-9) {
        s.net = 0;
        s.avg = 0;
      }
    }

    state.set(leg.instrument_id, s);

    out.push({
      trade_id: String(tradeId),
      order_id: String(tradeId * 7),
      instrument_id: leg.instrument_id,
      side: leg.side,
      price: leg.price.toFixed(instrument.price_decimals),
      quantity: leg.quantity.toFixed(instrument.quantity_decimals),
      taker: true,
      fee: (leg.price * leg.quantity * TAKER_FEE).toFixed(6),
      fee_asset: 'pUSD',
      previous_size: previousSize.toFixed(instrument.quantity_decimals),
      previous_entry_price: previousEntry.toFixed(instrument.price_decimals),
      pnl: pnl.toFixed(6),
      timestamp: BASE + leg.hours * HOUR,
      liquidation: leg.liquidation === true,
      adl: leg.adl === true,
      hash: `0xpm${(tradeId++).toString(16)}fixture`,
    });
  }

  const finalSizes = new Map<number, { size: number; entry: number }>();
  for (const [id, s] of state) finalSizes.set(id, { size: s.net, entry: s.avg });

  return { fills: out, finalSizes };
}

/** Piecewise-linear path through the fill prices, no noise — the walk adds that. */
function anchorAt(instrumentId: number, t: number): number {
  const anchors = LEGS.filter((l) => l.instrument_id === instrumentId)
    .sort((a, b) => a.hours - b.hours)
    .map((l) => ({ t: BASE + l.hours * HOUR, p: l.price }));

  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (t <= first.t) return first.p * (1 - 0.03 * ((first.t - t) / (24 * HOUR)));
  if (t >= last.t) return last.p * (1 + 0.01 * ((t - last.t) / (24 * HOUR)));

  let lo = first;
  let hi = last;
  for (let i = 0; i < anchors.length - 1; i++) {
    if (t >= anchors[i]!.t && t <= anchors[i + 1]!.t) {
      lo = anchors[i]!;
      hi = anchors[i + 1]!;
      break;
    }
  }
  const span = hi.t - lo.t || 1;
  return lo.p + ((hi.p - lo.p) * (t - lo.t)) / span;
}

/** SPEC §4.4.2 klines are tuples: [ts, o, h, l, c, volume, trades]. */
function buildKlines(instrumentId: number, stepMs: number): (number | number)[][] {
  const rand = mulberry32(instrumentId * 31 + 7);
  const from = BASE - 12 * HOUR;
  const to = BASE + 44 * HOUR;
  const rows: number[][] = [];
  let prevClose = anchorAt(instrumentId, from);

  for (let t = from; t < to; t += stepMs) {
    const o = prevClose;
    const c = anchorAt(instrumentId, t + stepMs) * (1 + (rand() - 0.5) * 0.004);
    prevClose = c;
    const drift = Math.abs(c - o) + o * 0.0015;
    const h = Math.max(o, c) + drift * rand();
    const l = Math.min(o, c) - drift * rand();
    rows.push([t, o, h, l, c, 500 + rand() * 5_000, Math.floor(20 + rand() * 300)]);
  }
  return rows;
}

/** Mark history is sparse on purpose: only buckets with an update are returned. */
function buildMarkHistory(instrumentId: number): number[][] {
  const rand = mulberry32(instrumentId * 97 + 3);
  const from = BASE + 29 * HOUR;
  const to = BASE + 31 * HOUR;
  const rows: number[][] = [];

  for (let t = from; t < to; t += 1_000) {
    // Roughly a third of seconds see a mark update; the rest are gaps to forward-fill.
    if (rand() > 0.34) continue;
    rows.push([t, anchorAt(instrumentId, t) * (1 + (rand() - 0.5) * 0.0015)]);
  }
  return rows;
}

function write(relative: string, data: unknown, compact = false): void {
  const path = join(OUT, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`);
  console.log(`  wrote ${relative}`);
}

const ADDRESS = '0x393d0b87ed38fc779fd9611144ae649ba6082109';
const { fills, finalSizes } = buildFills();

console.log('Generating synthetic Polymarket Perps fixture into fixtures/polymarket-perps/synthetic');
write('instruments.json', INSTRUMENTS);

// Still written, and still true: the portfolio reports what is open right now. It is no
// longer the entry point — the history endpoint is — but the option-A path still reads
// it, and a fixture that only serves the new path would hide a regression in the old one.
write('portfolio.json', {
  equity: '128400.500000',
  positions: [...finalSizes.entries()]
    .filter(([, s]) => Math.abs(s.size) > 1e-9)
    .map(([instrument_id, s]) => ({
      instrument_id,
      size: s.size.toFixed(4),
      entry_price: s.entry.toFixed(2),
    })),
});

/**
 * The history endpoint: newest first, in pages, each naming the cursor for the next.
 *
 * The last page carries `more: false` and no cursor, which is how the walk terminates.
 */
const descending = [...fills].sort((a, b) => b.timestamp - a.timestamp);
for (let start = 0, page = 0; start < descending.length; start += HISTORY_PAGE, page++) {
  const slice = descending.slice(start, start + HISTORY_PAGE);
  const more = start + HISTORY_PAGE < descending.length;
  write(page === 0 ? 'fills/first.json' : `fills/cursor-${page}.json`, {
    data: slice,
    more,
    ...(more ? { cursor: `cursor-${page + 1}` } : {}),
  });
}

for (const instrument of INSTRUMENTS) {
  write(
    `position-fills/${instrument.instrument_id}.json`,
    fills.filter((f) => f.instrument_id === instrument.instrument_id),
  );
  for (const [name, ms] of [['1m', 60_000], ['5m', 5 * 60_000], ['15m', 15 * 60_000], ['1h', HOUR]] as const) {
    write(`klines/${instrument.instrument_id}-${name}.json`, { data: buildKlines(instrument.instrument_id, ms), more: false }, true);
  }
  write(`mark-history/${instrument.instrument_id}-1s.json`, { data: buildMarkHistory(instrument.instrument_id), more: false }, true);
}

write('meta.json', {
  provenance: 'SYNTHETIC — generated by scripts/make-perps-fixture.ts',
  warning:
    'These numbers are invented. They are shaped like documented Polymarket Perps responses ' +
    'so the adapter code paths are exercised offline, but they prove nothing about the live ' +
    'venue contract. Real recordings come from `pnpm capture:pm`.',
  mode: 'full history via /v1/info/fills; portfolio + position-fills also recorded',
  address: ADDRESS,
  fillCount: fills.length,
  historyPages: Math.ceil(fills.length / HISTORY_PAGE),
  openPositions: [...finalSizes.values()].filter((s) => Math.abs(s.size) > 1e-9).length,
});

console.log('Done.');

// Last, so a generator that threw leaves the old fixture and its cache consistent.
dropFixtureCache('polymarket-perps', 'synthetic');
