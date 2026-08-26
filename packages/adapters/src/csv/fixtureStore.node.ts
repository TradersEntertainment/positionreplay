/**
 * Node-only loader for a recorded CSV/Binance fixture directory.
 *
 * Split from fixtureFetch.ts for the same reason as the other venues': importing the
 * replay logic must never drag `node:fs` into a browser bundle.
 *
 * Layout (written by scripts/make-csv-fixture.ts and by `pnpm capture:binance`):
 *   <dir>/trades.csv                  the uploaded file
 *   <dir>/document.json               its confirmed mapping and symbol sources
 *   <dir>/klines/<SYMBOL>-<interval>.json
 *   <dir>/exchange-info.json          optional, the `symbols` array
 *   <dir>/ohlcv/<SYMBOL>.csv          optional, §4.6's fallback series
 *   <dir>/meta.json
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BinanceFixtureStore } from './fixtureFetch.js';
import { documentIdFor, type CsvDocument, type CsvSymbolSource } from './document.js';
import type { ColumnMapping } from './mapping.js';

export interface CsvFixtureMeta {
  provenance?: string;
  warning?: string;
  capturedAt?: string;
}

/** What document.json holds; the id is derived, never stored. */
interface StoredDocument {
  filename: string;
  mapping: ColumnMapping;
  symbols: Record<string, CsvSymbolSource>;
}

export interface LoadedCsvFixture extends BinanceFixtureStore {
  meta: CsvFixtureMeta;
  document: CsvDocument;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadCsvFixtureStore(dir: string): LoadedCsvFixture {
  if (!existsSync(dir)) {
    throw new Error(
      `No CSV fixture at ${dir}. Generate the synthetic one with ` +
        `\`pnpm tsx scripts/make-csv-fixture.ts\`, or record real klines with ` +
        `\`pnpm capture:binance <SYMBOL>\`.`,
    );
  }

  const text = readFileSync(join(dir, 'trades.csv'), 'utf8');
  const stored = readJson(join(dir, 'document.json')) as StoredDocument;

  // The `ohlcv` source kind carries the file inline, so a fixture keeps it in its own
  // file and it is inlined here — which also keeps document.json readable.
  const symbols: Record<string, CsvSymbolSource> = {};
  for (const [symbol, source] of Object.entries(stored.symbols)) {
    if (source.kind === 'ohlcv' && source.text === '' && source.filename) {
      symbols[symbol] = {
        kind: 'ohlcv',
        text: readFileSync(join(dir, 'ohlcv', source.filename), 'utf8'),
        filename: source.filename,
      };
    } else {
      symbols[symbol] = source;
    }
  }

  const klines = new Map<string, unknown>();
  const klinesDir = join(dir, 'klines');
  if (existsSync(klinesDir)) {
    for (const file of readdirSync(klinesDir)) {
      if (file.endsWith('.json')) klines.set(file.replace(/\.json$/, ''), readJson(join(klinesDir, file)));
    }
  }

  const symbolInfo = new Map<string, unknown>();
  const infoPath = join(dir, 'exchange-info.json');
  if (existsSync(infoPath)) {
    const entries = readJson(infoPath);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const symbol = (entry as { symbol?: unknown }).symbol;
        if (typeof symbol === 'string') symbolInfo.set(symbol, entry);
      }
    }
  }

  const metaPath = join(dir, 'meta.json');

  return {
    klines,
    symbols: symbolInfo,
    meta: existsSync(metaPath) ? (readJson(metaPath) as CsvFixtureMeta) : {},
    document: {
      // Derived rather than stored: the id is a hash of the file and its mapping, so
      // a fixture whose CSV was edited gets a new id automatically instead of serving
      // stale content under the old one.
      id: documentIdFor(text, stored.mapping),
      filename: stored.filename,
      text,
      mapping: stored.mapping,
      symbols,
      createdAt: 0,
    },
  };
}
