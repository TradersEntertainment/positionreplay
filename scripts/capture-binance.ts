/**
 * Record real Binance klines into a CSV fixture directory.
 *
 *   pnpm capture:binance <trades.csv> [--symbol BTC=BTCUSDT] [--name <fixture-name>]
 *
 * Run where `api.binance.com` is reachable. It drives the ordinary CSV adapter through
 * a recording fetch, so what lands on disk is exactly what Binance returned — which is
 * the only way the schemas in csv/schemas.ts get checked against reality
 * (see docs/VERIFYING-M1.md).
 *
 * Read-only, unauthenticated: /api/v3/klines and /api/v3/exchangeInfo are public market
 * data. No key is sent and no write path exists.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  applyMapping,
  BINANCE_INTERVALS,
  createBinanceClient,
  documentIdFor,
  parseCsv,
  suggestMapping,
  symbolCandidates,
  UnknownSymbolError,
} from '@trade-replay/adapters';
import type { CsvSymbolSource, FetchLike, HttpRequest } from '@trade-replay/adapters';
import { buildEpisodes, pickInterval, seriesRangeFor } from '@trade-replay/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    symbol: { type: 'string', multiple: true },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`
pnpm capture:binance <trades.csv> [options]

  --symbol <CSV=BINANCE>   Map one CSV symbol, e.g. --symbol BTC-PERP=BTCUSDT.
                           Repeatable. Unmapped symbols use the first candidate
                           symbolCandidates() suggests, and are reported.
  --name <fixture-name>    Directory under fixtures/csv/. Defaults to the file name.

  Records the klines this file's positions need into fixtures/csv/<name>, alongside
  the trades file and its confirmed mapping, so the whole replay runs offline after.
`);
  process.exit(values.help ? 0 : 1);
}

const tradesPath = positionals[0]!;
const text = readFileSync(tradesPath, 'utf8');
const name = values.name ?? basename(tradesPath).replace(/\.csv$/i, '');
const OUT = join(ROOT, 'fixtures', 'csv', name);

const table = parseCsv(text);
const mapping = suggestMapping(table);
const { fills, issues } = applyMapping(table, mapping);

console.log(`file      ${tradesPath}`);
console.log(`mapping   ${JSON.stringify(mapping.columns)} (${mapping.timestampFormat})`);
console.log(`fills     ${fills.length}${issues.length > 0 ? `, ${issues.length} row(s) rejected` : ''}`);

/** --symbol BTC-PERP=BTCUSDT, repeated. */
const overrides = new Map<string, string>();
for (const pair of values.symbol ?? []) {
  const [from, to] = pair.split('=');
  if (!from || !to) {
    console.error(`Could not read --symbol "${pair}". Expected CSV=BINANCE, e.g. BTC-PERP=BTCUSDT.`);
    process.exit(1);
  }
  overrides.set(from.toUpperCase(), to.toUpperCase());
}

const recorded: { klines: Map<string, unknown>; symbols: unknown[] } = {
  klines: new Map(),
  symbols: [],
};

/** Records every response verbatim, then hands it on unchanged. */
const recordingFetch: FetchLike = async (url, init: HttpRequest) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.method === 'GET' ? {} : { body: init.body }),
  });
  const body = await response.text();

  if (response.ok) {
    const parsed: unknown = JSON.parse(body);
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/api/v3/klines') {
      const key = `${parsedUrl.searchParams.get('symbol')}-${parsedUrl.searchParams.get('interval')}`;
      const existing = (recorded.klines.get(key) ?? []) as unknown[];
      // Pages are appended: the fixture must hold the whole span, not the last page.
      recorded.klines.set(key, [...existing, ...(Array.isArray(parsed) ? parsed : [])]);
    } else if (parsedUrl.pathname === '/api/v3/exchangeInfo') {
      const info = parsed as { symbols?: unknown[] };
      recorded.symbols.push(...(info.symbols ?? []));
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: { get: (h: string) => response.headers.get(h) },
    text: async () => body,
  };
};

const ctx = { fetch: recordingFetch };
const client = createBinanceClient(ctx);

const episodes = buildEpisodes(fills, { venue: 'csv' });
const symbols = [...new Set(fills.map((f) => f.instrument))];

const sources: Record<string, CsvSymbolSource> = {};
const unresolved: string[] = [];

for (const symbol of symbols) {
  const candidates = overrides.has(symbol) ? [overrides.get(symbol)!] : symbolCandidates(symbol);
  const listed = await client.symbolInfo(candidates);
  const tradable = listed.find((s) => s.status === 'TRADING');

  if (!tradable) {
    // SPEC §4.6: this is the case where the user uploads their own OHLCV instead.
    unresolved.push(symbol);
    console.log(`  ${symbol} -> not listed (tried ${candidates.join(', ')})`);
    continue;
  }

  sources[symbol] = { kind: 'binance', symbol: tradable.symbol };
  console.log(`  ${symbol} -> ${tradable.symbol}`);
}

// Fetch exactly the candles these positions need, at the interval the app would pick.
for (const episode of episodes) {
  const source = sources[episode.instrument];
  if (!source || source.kind !== 'binance') continue;

  const now = Date.now();
  const range = seriesRangeFor(episode, now);
  const picked = pickInterval((episode.closedAt ?? now) - episode.openedAt, BINANCE_INTERVALS);
  const spec = BINANCE_INTERVALS.find((i) => i.name === picked.interval);
  if (!spec) {
    console.error(`  ${episode.displayName}: no Binance interval matched "${picked.interval}"`);
    continue;
  }
  if (picked.warning) console.log(`  ${episode.displayName}: ${picked.warning}`);

  try {
    const bars = await client.klines(source.symbol, picked.interval, range, spec.ms);
    console.log(`  ${episode.displayName} ${picked.interval}: ${bars.length} bars`);
  } catch (error) {
    if (error instanceof UnknownSymbolError) {
      unresolved.push(episode.instrument);
      continue;
    }
    throw error;
  }
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`  ${path.replace(ROOT, '.')}`);
}

console.log('\nWriting');
write(join(OUT, 'trades.csv'), text);
for (const [key, rows] of recorded.klines) {
  write(join(OUT, 'klines', `${key}.json`), `${JSON.stringify(rows)}\n`);
}
if (recorded.symbols.length > 0) {
  write(join(OUT, 'exchange-info.json'), `${JSON.stringify(recorded.symbols, null, 2)}\n`);
}
write(
  join(OUT, 'document.json'),
  `${JSON.stringify({ filename: basename(tradesPath), mapping, symbols: sources }, null, 2)}\n`,
);
write(
  join(OUT, 'meta.json'),
  `${JSON.stringify(
    {
      provenance: `RECORDED from api.binance.com by scripts/capture-binance.ts`,
      capturedAt: new Date().toISOString(),
      trades: fills.length,
      rejectedRows: issues.length,
      unresolvedSymbols: unresolved,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nFixture id: ${documentIdFor(text, mapping)}`);
console.log(`Replay it:  pnpm episodes --venue csv --fixture ${name}`);
if (unresolved.length > 0) {
  console.log(
    `\n${unresolved.length} symbol(s) are not listed on Binance: ${unresolved.join(', ')}.\n` +
      `  SPEC §4.6's fallback applies — add fixtures/csv/${name}/ohlcv/<SYMBOL>.csv and\n` +
      `  point document.json at it with { "kind": "ohlcv", "text": "", "filename": "<SYMBOL>.csv" }.`,
  );
}
