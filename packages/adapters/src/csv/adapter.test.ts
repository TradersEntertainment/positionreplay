import { describe, expect, it } from 'vitest';
import { buildEpisodes } from '@trade-replay/core';
import type { Candle, PriceSeries } from '@trade-replay/core';
import { InvalidInputError, SeriesUnavailableError } from '../types.js';
import type { AdapterContext, AdapterWarning, FetchLike } from '../types.js';
import { csvAdapter, instrumentKeyFor, splitInstrumentKey } from './index.js';
import { documentIdFor, type CsvDocument, type CsvDocumentStore } from './document.js';
import { suggestMapping, type ColumnMapping } from './mapping.js';
import { parseCsv } from './parse.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 10, 6);

const TRADES = [
  'timestamp,symbol,side,price,size,fee',
  `${T0},BTC,buy,92000,0.5,18.4`,
  `${T0 + 2 * HOUR},BTC,buy,89500,0.3,10.74`,
  `${T0 + 4 * HOUR},BTC,sell,95000,0.8,30.4`,
].join('\n');

function memoryStore(): CsvDocumentStore & { documents: Map<string, CsvDocument> } {
  const documents = new Map<string, CsvDocument>();
  return {
    documents,
    get: async (id) => documents.get(id) ?? null,
    put: async (doc) => {
      documents.set(doc.id, doc);
    },
  };
}

function documentFor(text = TRADES, symbols: CsvDocument['symbols'] = {}): CsvDocument {
  const mapping = suggestMapping(parseCsv(text));
  return {
    id: documentIdFor(text, mapping),
    filename: 'trades.csv',
    text,
    mapping,
    symbols,
    createdAt: T0,
  };
}

function contextFor(
  document: CsvDocument,
  extra: Partial<AdapterContext> = {},
): { ctx: AdapterContext; warnings: AdapterWarning[] } {
  const store = memoryStore();
  store.documents.set(document.id, document);
  const warnings: AdapterWarning[] = [];
  return {
    ctx: { csvStore: store, onWarning: (w) => warnings.push(w), sleep: async () => {}, ...extra },
    warnings,
  };
}

/** PriceSeries is a union; every CSV series is the ohlcv arm. */
function candlesOf(series: PriceSeries): Candle[] {
  if (series.kind !== 'ohlcv') throw new Error(`expected an ohlcv series, got ${series.kind}`);
  return series.candles;
}

function klinesFetch(bars: number): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify(
        Array.from({ length: bars }, (_, i) => [
          T0 + i * HOUR,
          '91000',
          '96000',
          '89000',
          String(92000 + i * 10),
          '10',
          T0 + (i + 1) * HOUR - 1,
        ]),
      ),
  });
}

describe('instrument keys', () => {
  it('round-trips', () => {
    const key = instrumentKeyFor('0123456789abcdef', 'BTC');
    expect(key).toBe('csv:0123456789abcdef:BTC');
    expect(splitInstrumentKey(key)).toEqual({ documentId: '0123456789abcdef', symbol: 'BTC' });
  });

  it('rejects a key from another venue rather than mis-parsing it', () => {
    expect(() => splitInstrumentKey('BTC-PERP')).toThrow(InvalidInputError);
  });

  it('keeps a symbol containing a colon intact', () => {
    const key = instrumentKeyFor('0123456789abcdef', 'BTC:USD');
    expect(splitInstrumentKey(key).symbol).toBe('BTC:USD');
  });
});

describe('csvAdapter.parseInput', () => {
  it('accepts a stored document id', async () => {
    const document = documentFor();
    const { ctx } = contextFor(document);
    expect(await csvAdapter.parseInput(document.id, ctx)).toEqual({
      venue: 'csv',
      address: document.id,
      label: 'trades.csv',
    });
  });

  it('rejects a wallet address, which is not how a CSV is addressed', async () => {
    const { ctx } = contextFor(documentFor());
    await expect(
      csvAdapter.parseInput('0x393d0b87ed38fc779fd9611144ae649ba6082109', ctx),
    ).rejects.toThrow(InvalidInputError);
  });

  it('says the upload is gone rather than returning no positions', async () => {
    const { ctx } = contextFor(documentFor());
    await expect(csvAdapter.parseInput('deadbeefdeadbeef', ctx)).rejects.toThrow(/re-upload/);
  });

  it('explains that a store is required rather than failing obscurely', async () => {
    await expect(csvAdapter.parseInput('0123456789abcdef', {})).rejects.toThrow(
      /needs a document store/,
    );
  });
});

describe('csvAdapter.fetchFills', () => {
  it('reads the document through the mapping', async () => {
    const document = documentFor();
    const { ctx } = contextFor(document);
    const fills = await csvAdapter.fetchFills({ venue: 'csv', address: document.id }, undefined, ctx);
    expect(fills).toHaveLength(3);
    expect(fills[0]?.instrument).toBe(instrumentKeyFor(document.id, 'BTC'));
    expect(fills[0]?.displayName).toBe('BTC');
  });

  it('reconstructs an episode whose PnL is the arithmetic of the file', async () => {
    const document = documentFor();
    const { ctx } = contextFor(document);
    const fills = await csvAdapter.fetchFills({ venue: 'csv', address: document.id }, undefined, ctx);
    const episodes = buildEpisodes(fills, { venue: 'csv' });

    expect(episodes).toHaveLength(1);
    const episode = episodes[0]!;
    // 0.5 @ 92000 and 0.3 @ 89500 -> 0.8 @ 91062.50, closed at 95000.
    expect(episode.avgEntry).toBeCloseTo(91062.5, 6);
    expect(episode.realizedPnl).toBeCloseTo((95000 - 91062.5) * 0.8, 6);
    expect(episode.totalFees).toBeCloseTo(18.4 + 10.74 + 30.4, 6);
    expect(episode.closedAt).toBe(T0 + 4 * HOUR);
  });

  it('honours a time range', async () => {
    const document = documentFor();
    const { ctx } = contextFor(document);
    const fills = await csvAdapter.fetchFills(
      { venue: 'csv', address: document.id },
      { from: T0 + HOUR, to: T0 + 3 * HOUR },
      ctx,
    );
    expect(fills).toHaveLength(1);
  });

  it('warns about rows it could not read instead of dropping them silently', async () => {
    const text = [TRADES, `${T0 + 5 * HOUR},BTC,flatten,96000,0.1,1`].join('\n');
    const document = documentFor(text);
    const { ctx, warnings } = contextFor(document);
    const fills = await csvAdapter.fetchFills({ venue: 'csv', address: document.id }, undefined, ctx);
    expect(fills).toHaveLength(3);
    expect(warnings.map((w) => w.kind)).toContain('csv_rows_rejected');
    expect(warnings[0]?.message).toContain('flatten');
  });

  it('warns about a ragged row', async () => {
    const text = [TRADES, `${T0 + 5 * HOUR},BTC,sell,96000`].join('\n');
    const { ctx, warnings } = contextFor(documentFor(text));
    await csvAdapter
      .fetchFills({ venue: 'csv', address: documentFor(text).id }, undefined, ctx)
      .catch(() => undefined);
    expect(warnings.map((w) => w.kind)).toContain('csv_ragged_rows');
  });
});

describe('csvAdapter.fetchSeries', () => {
  const req = (document: CsvDocument): Parameters<typeof csvAdapter.fetchSeries>[0] => ({
    instrument: instrumentKeyFor(document.id, 'BTC'),
    interval: '1h',
    from: T0,
    to: T0 + 4 * HOUR,
  });

  it('fetches Binance klines for a mapped symbol', async () => {
    const document = documentFor(TRADES, { BTC: { kind: 'binance', symbol: 'BTCUSDT' } });
    const { ctx } = contextFor(document, { fetch: klinesFetch(5) });
    const series = await csvAdapter.fetchSeries(req(document), ctx);
    expect(series.kind).toBe('ohlcv');
    expect(candlesOf(series)).toHaveLength(5);
    expect(candlesOf(series)[0]?.c).toBe(92000);
  });

  it('asks Binance for the symbol the user mapped, not the CSV symbol', async () => {
    const urls: string[] = [];
    const document = documentFor(TRADES, { BTC: { kind: 'binance', symbol: 'BTCUSDT' } });
    const inner = klinesFetch(5);
    const { ctx } = contextFor(document, {
      fetch: (url, init) => {
        urls.push(url);
        return inner(url, init);
      },
    });
    await csvAdapter.fetchSeries(req(document), ctx);
    expect(urls[0]).toContain('symbol=BTCUSDT');
  });

  it('serves a user-supplied OHLCV file with no network at all', async () => {
    const ohlcv = [
      'time,open,high,low,close,volume',
      `${T0},91990,92020,91970,92000,12`,
      `${T0 + HOUR},92000,92500,91900,92400,9`,
    ].join('\n');
    const document = documentFor(TRADES, { BTC: { kind: 'ohlcv', text: ohlcv } });
    const { ctx } = contextFor(document, {
      fetch: () => {
        throw new Error('the network must not be touched for a local OHLCV file');
      },
    });
    const series = await csvAdapter.fetchSeries(req(document), ctx);
    expect(candlesOf(series)).toHaveLength(2);
  });

  it('reports an unmapped symbol as unavailable rather than drawing nothing', async () => {
    const document = documentFor();
    const { ctx } = contextFor(document, { fetch: klinesFetch(5) });
    await expect(csvAdapter.fetchSeries(req(document), ctx)).rejects.toThrow(
      SeriesUnavailableError,
    );
  });

  it('reports an empty Binance response as unavailable', async () => {
    const document = documentFor(TRADES, { BTC: { kind: 'binance', symbol: 'BTCUSDT' } });
    const { ctx } = contextFor(document, { fetch: klinesFetch(0) });
    await expect(csvAdapter.fetchSeries(req(document), ctx)).rejects.toThrow(
      SeriesUnavailableError,
    );
  });

  it('rejects an interval Binance does not serve', async () => {
    const document = documentFor(TRADES, { BTC: { kind: 'binance', symbol: 'BTCUSDT' } });
    const { ctx } = contextFor(document, { fetch: klinesFetch(5) });
    await expect(
      csvAdapter.fetchSeries({ ...req(document), interval: '7m' }, ctx),
    ).rejects.toThrow(/Unknown interval "7m"/);
  });
});

describe('csvAdapter shape', () => {
  it('offers no funding, because a fills CSV carries none', () => {
    expect(csvAdapter.fetchFunding).toBeUndefined();
  });

  it('exposes Binance intervals so callers need no venue constant', () => {
    expect(csvAdapter.intervals.map((i) => i.name)).toContain('1h');
  });
});

describe('documentIdFor', () => {
  it('is stable for the same file and mapping', () => {
    const mapping = suggestMapping(parseCsv(TRADES));
    expect(documentIdFor(TRADES, mapping)).toBe(documentIdFor(TRADES, mapping));
  });

  it('changes when the mapping changes, so a remap is its own replay', () => {
    const mapping = suggestMapping(parseCsv(TRADES));
    const { fee: _dropped, ...withoutFee } = mapping.columns;
    const remapped: ColumnMapping = { ...mapping, columns: withoutFee };
    expect(documentIdFor(TRADES, remapped)).not.toBe(documentIdFor(TRADES, mapping));
  });

  it('changes when the file changes', () => {
    const mapping = suggestMapping(parseCsv(TRADES));
    expect(documentIdFor(`${TRADES}\n`, mapping)).not.toBe(documentIdFor(TRADES, mapping));
  });
});
