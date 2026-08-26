import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../types.js';
import type { AdapterContext, FetchLike } from '../types.js';
import {
  BINANCE_MAX_LIMIT,
  UnknownSymbolError,
  createBinanceClient,
  symbolCandidates,
} from './binance.js';
import { BinanceContractError } from './schemas.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 10, 6);

/** One kline as Binance sends it: a positional array of mixed numbers and strings. */
function kline(t: number, close: number): unknown[] {
  return [
    t,
    String(close - 10),
    String(close + 20),
    String(close - 30),
    String(close),
    '12.5',
    t + HOUR - 1,
    '1150000',
    308,
    '6.1',
    '560000',
    '0',
  ];
}

interface StubOptions {
  status?: number;
  headers?: Record<string, string>;
}

function stubFetch(
  body: (url: string) => unknown,
  options: StubOptions = {},
): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const payload = body(url);
    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      headers: { get: (name: string) => options.headers?.[name.toLowerCase()] ?? null },
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  return { fetch, urls };
}

const ctx = (fetch: FetchLike): AdapterContext => ({ fetch, sleep: async () => {} });

describe('symbolCandidates', () => {
  it('offers the conventional quote assets for a bare base', () => {
    expect(symbolCandidates('BTC')).toEqual(['BTCUSDT', 'BTCUSDC', 'BTCFDUSD', 'BTCBUSD', 'BTCUSD']);
  });

  it('strips a perp suffix', () => {
    expect(symbolCandidates('BTC-PERP')[0]).toBe('BTCUSDT');
    expect(symbolCandidates('ETH_SWAP')[0]).toBe('ETHUSDT');
    expect(symbolCandidates('SOLUSDT.P')[0]).toBe('SOLUSDT');
  });

  it('keeps an already-quoted symbol first but offers substitutions', () => {
    const candidates = symbolCandidates('BTCUSD');
    expect(candidates[0]).toBe('BTCUSD');
    // BTCUSD is not a Binance spot symbol; BTCUSDT is the one that will work.
    expect(candidates).toContain('BTCUSDT');
  });

  it('returns nothing for an empty symbol', () => {
    expect(symbolCandidates('  ')).toEqual([]);
  });
});

describe('createBinanceClient.klines', () => {
  it('maps a positional kline onto named fields', async () => {
    const { fetch } = stubFetch(() => [kline(T0, 92000)]);
    const bars = await createBinanceClient(ctx(fetch)).klines(
      'BTCUSDT',
      '1h',
      { from: T0, to: T0 + HOUR },
      HOUR,
    );
    expect(bars).toEqual([{ t: T0, o: 91990, h: 92020, l: 91970, c: 92000, v: 12.5 }]);
  });

  it('sends the documented query parameters', async () => {
    const { fetch, urls } = stubFetch(() => [kline(T0, 92000)]);
    await createBinanceClient(ctx(fetch)).klines('BTCUSDT', '1h', { from: T0, to: T0 + HOUR }, HOUR);
    expect(urls[0]).toContain('/api/v3/klines?');
    expect(urls[0]).toContain('symbol=BTCUSDT');
    expect(urls[0]).toContain('interval=1h');
    expect(urls[0]).toContain(`startTime=${T0}`);
    expect(urls[0]).toContain(`endTime=${T0 + HOUR}`);
    expect(urls[0]).toContain(`limit=${BINANCE_MAX_LIMIT}`);
  });

  it('accepts trailing elements Binance may append', async () => {
    const { fetch } = stubFetch(() => [[...kline(T0, 92000), 'a new field']]);
    const bars = await createBinanceClient(ctx(fetch)).klines(
      'BTCUSDT',
      '1h',
      { from: T0, to: T0 + HOUR },
      HOUR,
    );
    expect(bars).toHaveLength(1);
  });

  it('paginates past the 1000-bar page cap', async () => {
    const pages: unknown[][] = [
      Array.from({ length: BINANCE_MAX_LIMIT }, (_, i) => kline(T0 + i * HOUR, 90000 + i)),
      [kline(T0 + BINANCE_MAX_LIMIT * HOUR, 91000)],
    ];
    let call = 0;
    const { fetch, urls } = stubFetch(() => pages[call++] ?? []);
    const bars = await createBinanceClient(ctx(fetch)).klines(
      'BTCUSDT',
      '1h',
      { from: T0, to: T0 + 1200 * HOUR },
      HOUR,
    );
    expect(bars).toHaveLength(BINANCE_MAX_LIMIT + 1);
    expect(urls).toHaveLength(2);
    // The second page starts one interval past the last bar, not at it.
    expect(urls[1]).toContain(`startTime=${T0 + BINANCE_MAX_LIMIT * HOUR}`);
  });

  it('stops on a short page rather than requesting an empty one', async () => {
    const { fetch, urls } = stubFetch(() => [kline(T0, 92000)]);
    await createBinanceClient(ctx(fetch)).klines(
      'BTCUSDT',
      '1h',
      { from: T0, to: T0 + 5000 * HOUR },
      HOUR,
    );
    expect(urls).toHaveLength(1);
  });

  it('stops on an empty first page', async () => {
    const { fetch, urls } = stubFetch(() => []);
    const bars = await createBinanceClient(ctx(fetch)).klines(
      'BTCUSDT',
      '1h',
      { from: T0, to: T0 + 100 * HOUR },
      HOUR,
    );
    expect(bars).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('names an unlisted symbol instead of reporting a generic 400', async () => {
    const { fetch } = stubFetch(() => ({ code: -1121, msg: 'Invalid symbol.' }), { status: 400 });
    await expect(
      createBinanceClient(ctx(fetch)).klines('NOTACOIN', '1h', { from: T0, to: T0 + HOUR }, HOUR),
    ).rejects.toThrow(UnknownSymbolError);
  });

  it('does not retry an unlisted symbol', async () => {
    const { fetch, urls } = stubFetch(() => ({ code: -1121, msg: 'Invalid symbol.' }), {
      status: 400,
    });
    await expect(
      createBinanceClient(ctx(fetch)).klines('NOTACOIN', '1h', { from: T0, to: T0 + HOUR }, HOUR),
    ).rejects.toThrow(UnknownSymbolError);
    expect(urls).toHaveLength(1);
  });

  it('surfaces a rate limit as an HttpError carrying Retry-After', async () => {
    const { fetch } = stubFetch(() => ({ code: -1003, msg: 'Too much request weight used' }), {
      status: 429,
      headers: { 'retry-after': '12' },
    });
    const error = await createBinanceClient(ctx(fetch))
      .klines('BTCUSDT', '1h', { from: T0, to: T0 + HOUR }, HOUR)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).retryAfterMs).toBe(12_000);
  });

  it('rejects a response whose shape changed, naming what arrived', async () => {
    const { fetch } = stubFetch(() => [{ openTime: T0, open: '92000' }]);
    const error = await createBinanceClient(ctx(fetch))
      .klines('BTCUSDT', '1h', { from: T0, to: T0 + HOUR }, HOUR)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BinanceContractError);
    expect((error as Error).message).toContain('openTime');
  });

  it('rejects a body that is not JSON at all', async () => {
    const { fetch } = stubFetch(() => '<html>maintenance</html>');
    await expect(
      createBinanceClient(ctx(fetch)).klines('BTCUSDT', '1h', { from: T0, to: T0 + HOUR }, HOUR),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe('createBinanceClient.symbolInfo', () => {
  it('filters the request to the symbols asked about', async () => {
    const { fetch, urls } = stubFetch(() => ({
      symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' }],
    }));
    const info = await createBinanceClient(ctx(fetch)).symbolInfo(['BTCUSDT']);
    expect(info[0]?.symbol).toBe('BTCUSDT');
    expect(urls[0]).toContain(encodeURIComponent('["BTCUSDT"]'));
  });

  it('makes no request for an empty list', async () => {
    const spy = vi.fn();
    const { fetch } = stubFetch(() => {
      spy();
      return { symbols: [] };
    });
    expect(await createBinanceClient(ctx(fetch)).symbolInfo([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
