/**
 * CSV adapter. SPEC §4.6, milestone M7.
 *
 * The only adapter whose "account" is a file rather than a wallet. The uploaded
 * document is stored by the host (see `CsvDocumentStore`) under a content hash, and
 * that hash occupies the address slot everywhere else in the app — so `/a/csv/<id>`,
 * a replay deep link and the SPEC §10 candle cache all work unchanged.
 *
 * Price data comes from Binance public klines, or from the user's own OHLCV file when
 * Binance does not list the symbol.
 */

import type {
  Fill,
  IntervalSpec,
  PriceSeries,
  Candle,
  TimeRange,
} from '@trade-replay/core';
import { withCandleCache } from '../cacheHelpers.js';
import {
  InvalidInputError,
  SeriesUnavailableError,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type AdapterWarning,
  type CachedCandle,
  type SeriesRequest,
} from '../types.js';
import { BINANCE_INTERVALS, createBinanceClient } from './binance.js';
import { CSV_DOCUMENT_ID, type CsvDocument, type CsvSymbolSource } from './document.js';
import { applyMapping } from './mapping.js';
import { parseOhlcvCsv } from './ohlcv.js';
import { parseCsv } from './parse.js';

export const CSV_VENUE = 'csv' as const;

/** `csv:<documentId>:<SYMBOL>` — see `instrumentKeyFor`. */
const INSTRUMENT_KEY = /^csv:([0-9a-f]{16}):(.+)$/;

/**
 * Instrument keys are document-scoped on purpose.
 *
 * `fetchSeries` receives only a `SeriesRequest`, with no account on it. For a wallet
 * venue that is fine — "BTC-PERP" means the same thing to everyone. A CSV's "BTC"
 * means whatever that file's symbol mapping says, so the key has to carry the
 * document, or the adapter cannot tell which Binance symbol to fetch.
 */
export function instrumentKeyFor(documentId: string, symbol: string): string {
  return `csv:${documentId}:${symbol}`;
}

export function splitInstrumentKey(key: string): { documentId: string; symbol: string } {
  const match = INSTRUMENT_KEY.exec(key);
  if (!match) {
    throw new InvalidInputError(
      `"${key}" is not a CSV instrument key. Expected csv:<documentId>:<SYMBOL>.`,
    );
  }
  return { documentId: match[1]!, symbol: match[2]! };
}

function storeFrom(ctx: AdapterContext | undefined): NonNullable<AdapterContext['csvStore']> {
  const store = ctx?.csvStore;
  if (!store) {
    throw new Error(
      'The CSV adapter needs a document store. Pass one via AdapterContext.csvStore — ' +
        'apps/web supplies the SQLite-backed store, and tests supply an in-memory one.',
    );
  }
  return store;
}

async function loadDocument(id: string, ctx: AdapterContext | undefined): Promise<CsvDocument> {
  const document = await storeFrom(ctx).get(id);
  if (!document) {
    throw new InvalidInputError(
      `No uploaded file with id ${id}. Uploads are kept server-side and can be cleared; ` +
        `re-upload the CSV to get a new link.`,
    );
  }
  return document;
}

/** The document id, validated. SPEC §11 case 10: a bad handle is an error, not empty. */
async function parseInput(raw: string, ctx?: AdapterContext): Promise<AdapterInput> {
  const id = raw.trim().toLowerCase();
  if (!CSV_DOCUMENT_ID.test(id)) {
    throw new InvalidInputError(
      `"${raw}" is not an uploaded-file id. A CSV replay is addressed by the id returned ` +
        `when the file was uploaded, not by a wallet address.`,
    );
  }
  const document = await loadDocument(id, ctx);
  return { venue: CSV_VENUE, address: id, label: document.filename };
}

/**
 * Fills from the uploaded document.
 *
 * The mapping is applied on every read rather than stored pre-parsed, for the same
 * reason SPEC §10 caches raw venue payloads: a fix to `applyMapping` then corrects
 * every existing document instead of only the ones uploaded afterwards.
 */
async function fetchFills(
  input: AdapterInput,
  range?: TimeRange,
  ctx?: AdapterContext,
): Promise<Fill[]> {
  const document = await loadDocument(input.address, ctx);
  const table = parseCsv(document.text);
  const { fills, issues } = applyMapping(table, document.mapping);

  if (table.raggedRows.length > 0) {
    warn(ctx, {
      kind: 'csv_ragged_rows',
      message:
        `${table.raggedRows.length} row(s) had a different number of columns than the ` +
        `header and were padded or truncated.`,
      detail: { rows: table.raggedRows.slice(0, 20) },
    });
  }

  if (issues.length > 0) {
    warn(ctx, {
      kind: 'csv_rows_rejected',
      message:
        `${issues.length} row(s) could not be read and are not in this reconstruction. ` +
        `First: row ${issues[0]!.row + 1}, ${issues[0]!.field} "${issues[0]!.value}" — ` +
        `${issues[0]!.reason}.`,
      detail: { issues: issues.slice(0, 20) },
    });
  }

  const scoped = fills.map((fill) => ({
    ...fill,
    instrument: instrumentKeyFor(document.id, fill.instrument),
  }));

  if (!range) return scoped;
  return scoped.filter((f) => f.ts >= range.from && f.ts <= range.to);
}

async function fetchSeries(req: SeriesRequest, ctx?: AdapterContext): Promise<PriceSeries> {
  const { documentId, symbol } = splitInstrumentKey(req.instrument);
  const document = await loadDocument(documentId, ctx);

  const source = document.symbols[symbol];
  if (!source) {
    throw new SeriesUnavailableError(req.instrument, req.interval, {
      from: req.from,
      to: req.to,
    });
  }

  const spec = BINANCE_INTERVALS.find((i) => i.name === req.interval);
  if (!spec) {
    throw new Error(
      `Unknown interval "${req.interval}". Available: ${BINANCE_INTERVALS.map((i) => i.name).join(', ')}`,
    );
  }

  const bars = await barsFor(source, req, spec, ctx);

  // SPEC §11 case 8: no price data must be a clear error, never a blank canvas.
  if (bars.length === 0) {
    throw new SeriesUnavailableError(req.instrument, req.interval, {
      from: req.from,
      to: req.to,
    });
  }

  const candles: Candle[] = bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  return { kind: 'ohlcv', instrument: req.instrument, interval: req.interval, candles };
}

async function barsFor(
  source: CsvSymbolSource,
  req: SeriesRequest,
  spec: IntervalSpec,
  ctx: AdapterContext | undefined,
): Promise<CachedCandle[]> {
  if (source.kind === 'ohlcv') {
    // A local file needs no cache and no network; it is already the whole series.
    const { bars, skippedRows } = parseOhlcvCsv(source.text);
    if (skippedRows.length > 0) {
      warn(ctx, {
        kind: 'csv_rows_rejected',
        message: `${skippedRows.length} bar(s) in the uploaded OHLCV file could not be read.`,
        detail: { rows: skippedRows.slice(0, 20) },
      });
    }
    return bars.filter((b) => b.t >= req.from && b.t <= req.to);
  }

  const client = createBinanceClient(ctx);
  return withCandleCache({
    cache: ctx?.candleCache,
    // Keyed by the Binance symbol, not by the document: two people uploading files
    // that both trade BTC share one set of bars rather than refetching them.
    key: { venue: CSV_VENUE, instrument: `binance:${source.symbol}`, interval: req.interval },
    range: { from: req.from, to: req.to },
    intervalMs: spec.ms,
    now: (ctx?.now ?? Date.now)(),
    fetchSpan: (span) => client.klines(source.symbol, req.interval, span, spec.ms),
  });
}

function warn(ctx: AdapterContext | undefined, warning: AdapterWarning): void {
  ctx?.onWarning?.(warning);
}

export const csvAdapter: Adapter = {
  id: CSV_VENUE,
  intervals: BINANCE_INTERVALS,
  parseInput,
  fetchFills,
  fetchSeries,
  // No fetchFunding: a CSV of fills carries no funding payments, and inventing a
  // number from public rates for an unknown venue would be exactly the fabrication
  // CLAUDE.md forbids. The HUD shows funding as unavailable.
};
