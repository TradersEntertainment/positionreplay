/**
 * Generates the synthetic CSV fixture. SPEC §4.6.
 *
 * Same standing as the other two: shaped like a real trade export and a documented
 * Binance klines response so the adapter's code paths run offline, but the numbers are
 * invented and prove nothing about the live contract. Real klines come from
 * `pnpm capture:binance`.
 *
 * The file is deliberately awkward in the ways real exports are, so the mapping step
 * has something to do:
 *   - decorated header names ("Filled At", "Fill Price (USD)")
 *   - ISO8601 timestamps rather than an epoch
 *   - a symbol column carrying a perp suffix, so BTC-PERP has to map to BTCUSDT
 *   - fees written with a currency symbol and thousands separators
 *   - one unreadable row, so the "rows rejected" warning is exercised
 *   - a second symbol with no Binance listing, served by §4.6's OHLCV fallback
 *
 * Run: pnpm tsx scripts/make-csv-fixture.ts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, suggestMapping, type ColumnMapping } from '@trade-replay/adapters';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'csv', 'synthetic');

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


const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 7, 20, 0, 0, 0);

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

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

interface Trade {
  hours: number;
  symbol: string;
  side: string;
  price: number;
  size: number;
}

/**
 * Two positions. BTC-PERP scales in and closes at a profit; SHIB-PERP is the symbol
 * Binance will not resolve, so it exercises the uploaded-OHLCV path.
 */
const TRADES: Trade[] = [
  { hours: 0, symbol: 'BTC-PERP', side: 'Open Long', price: 92_000, size: 0.5 },
  { hours: 6, symbol: 'SHIB-PERP', side: 'Open Short', price: 0.0000241, size: 40_000_000 },
  { hours: 14, symbol: 'BTC-PERP', side: 'Open Long', price: 89_500, size: 0.3 },
  { hours: 30, symbol: 'SHIB-PERP', side: 'Close Short', price: 0.0000225, size: 40_000_000 },
  { hours: 44, symbol: 'BTC-PERP', side: 'Close Long', price: 97_250, size: 0.8 },
];

const TAKER_FEE = 0.00045;

/** A fee as a spreadsheet writes one: currency symbol, thousands separator, 2dp. */
function feeCell(notional: number): string {
  const fee = notional * TAKER_FEE;
  return `$${fee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tradesCsv(): string {
  const lines = ['Filled At,Market,Order Side,Fill Price (USD),Quantity,Fee,Notes'];

  for (const trade of TRADES) {
    const ts = BASE + trade.hours * HOUR;
    lines.push(
      [
        iso(ts),
        trade.symbol,
        trade.side,
        String(trade.price),
        String(trade.size),
        feeCell(trade.price * trade.size),
        '',
      ].join(','),
    );
  }

  // One row nothing can read. SPEC §4.6 does not promise a clean file, and the
  // adapter must report this rather than quietly reconstruct without it.
  lines.push([iso(BASE + 50 * HOUR), 'BTC-PERP', 'rebalance', '96000', '0.1', '$4.32', ''].join(','));

  return `${lines.join('\n')}\n`;
}

/**
 * Binance klines: positional arrays, exactly as documented.
 *
 * The path is steered through `waypoints` — the prices the trades file fills at — so
 * every marker lands on a bar that actually printed there. A random walk that ignored
 * them would put the entry and exit outside the chart, which is not what a real
 * symbol's candles look like next to real fills on that symbol.
 */
function klines(
  symbol: string,
  seed: number,
  start: number,
  price: number,
  bars: number,
  waypoints: { bar: number; price: number }[] = [],
): unknown[] {
  const random = mulberry32(seed);
  const out: unknown[] = [];
  let last = price;

  for (let i = 0; i < bars; i++) {
    const t = start + i * HOUR;

    // Pull toward the next waypoint, in proportion to how close it is.
    const next = waypoints.find((w) => w.bar >= i);
    const pull = next && next.bar > i ? (next.price - last) / (next.bar - i + 1) : 0;
    const drift = (random() - 0.5) * last * 0.006 + pull;

    const open = last;
    const close = next && next.bar === i ? next.price : Math.max(open + drift, open * 0.9);
    const high = Math.max(open, close) * (1 + random() * 0.004);
    const low = Math.min(open, close) * (1 - random() * 0.004);
    const volume = 40 + random() * 90;

    const round = (n: number): string => n.toFixed(symbol === 'SHIBUSDT' ? 8 : 2);
    out.push([
      t,
      round(open),
      round(high),
      round(low),
      round(close),
      volume.toFixed(4),
      t + HOUR - 1,
      (volume * close).toFixed(4),
      Math.floor(200 + random() * 900),
      (volume * 0.5).toFixed(4),
      (volume * close * 0.5).toFixed(4),
      '0',
    ]);
    last = close;
  }

  return out;
}

/** The user's own OHLCV file, for the symbol Binance does not list. */
function ohlcvCsv(
  seed: number,
  start: number,
  price: number,
  bars: number,
  waypoints: { bar: number; price: number }[],
): string {
  const rows = klines('SHIBUSDT', seed, start, price, bars, waypoints) as [number, ...string[]][];
  const lines = ['time,open,high,low,close,volume'];
  for (const row of rows) {
    lines.push([row[0], row[1], row[2], row[3], row[4], row[5]].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`  ${path.replace(ROOT, '.')}`);
}

const trades = tradesCsv();
const table = parseCsv(trades);
const suggested = suggestMapping(table);

// The generator asserts what the UI will show: this header is decorated enough that
// the suggestion has to earn every column. If a future change to the hint list breaks
// that, the fixture stops being a test of the mapping step and this catches it.
const REQUIRED = ['timestamp', 'symbol', 'side', 'price', 'size', 'fee'] as const;
for (const field of REQUIRED) {
  if (suggested.columns[field] === undefined) {
    throw new Error(`suggestMapping failed to find "${field}" in: ${table.header.join(', ')}`);
  }
}

const mapping: ColumnMapping = suggested;

const startSeries = BASE - 4 * HOUR;
const bars = 56;
const LEAD_BARS = 4;

/**
 * Where the series has to be when each fill happens.
 *
 * The 1h and 15m tables cover the same wall-clock span at different resolutions, so
 * each one's waypoints are the same prices at its own bar spacing.
 */
function waypointsFor(symbol: string, barsPerHour: number): { bar: number; price: number }[] {
  return TRADES.filter((t) => t.symbol === symbol).map((t) => ({
    bar: (LEAD_BARS + t.hours) * barsPerHour,
    price: t.price,
  }));
}

write(join(OUT, 'trades.csv'), trades);
write(
  join(OUT, 'klines', `BTCUSDT-1h.json`),
  `${JSON.stringify(
    klines('BTCUSDT', 91, startSeries, 91_000, bars, waypointsFor('BTC-PERP', 1)),
    null,
    0,
  )}\n`,
);
write(
  join(OUT, 'klines', `BTCUSDT-15m.json`),
  `${JSON.stringify(
    (() => {
      const quarter = HOUR / 4;
      const rows = klines('BTCUSDT', 92, startSeries, 91_000, bars * 4, waypointsFor('BTC-PERP', 4));
      // klines() steps by the hour; restamp to 15-minute buckets.
      return (rows as [number, ...unknown[]][]).map((row, i) => [
        startSeries + i * quarter,
        ...row.slice(1, 6),
        startSeries + (i + 1) * quarter - 1,
        ...row.slice(7),
      ]);
    })(),
    null,
    0,
  )}\n`,
);
write(
  join(OUT, 'ohlcv', 'SHIB-PERP.csv'),
  ohlcvCsv(77, startSeries, 0.0000238, bars, waypointsFor('SHIB-PERP', 1)),
);
write(
  join(OUT, 'exchange-info.json'),
  `${JSON.stringify(
    [{ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' }],
    null,
    2,
  )}\n`,
);
write(
  join(OUT, 'document.json'),
  `${JSON.stringify(
    {
      filename: 'trades.csv',
      mapping,
      symbols: {
        'BTC-PERP': { kind: 'binance', symbol: 'BTCUSDT' },
        // `text: ''` tells the loader to inline ohlcv/SHIB-PERP.csv, which keeps this
        // file readable instead of embedding a few thousand bars in a JSON string.
        'SHIB-PERP': { kind: 'ohlcv', text: '', filename: 'SHIB-PERP.csv' },
      },
    },
    null,
    2,
  )}\n`,
);
write(
  join(OUT, 'meta.json'),
  `${JSON.stringify(
    {
      provenance: 'SYNTHETIC — generated by scripts/make-csv-fixture.ts',
      warning:
        'These numbers are invented. The trades file is shaped like a real exchange ' +
        'export and the klines like a documented Binance response, so the adapter code ' +
        'paths are exercised offline, but they prove nothing about the live Binance ' +
        'contract. Real klines come from `pnpm capture:binance`.',
      trades: TRADES.length,
      rejectedRows: 1,
      symbols: { 'BTC-PERP': 'binance BTCUSDT', 'SHIB-PERP': 'uploaded OHLCV (§4.6 fallback)' },
    },
    null,
    2,
  )}\n`,
);

console.log(`\nWrote the synthetic CSV fixture. ${TRADES.length} trades, 1 unreadable row.`);

// Last, so a generator that threw leaves the old fixture and its cache consistent.
dropFixtureCache('csv', 'synthetic');
