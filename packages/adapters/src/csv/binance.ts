/**
 * Binance public klines. SPEC §4.6:
 *
 *   "Price data for CSV trades comes from Binance public klines
 *    (GET https://api.binance.com/api/v3/klines?symbol=&interval=&startTime=&endTime=
 *    &limit=1000, no auth, paginate)."
 *
 * No key, no signature, no authenticated endpoint — the two paths used here are
 * market data, which keeps this inside CLAUDE.md's read-only rule.
 */

import type { IntervalSpec, TimeRange } from '@trade-replay/core';
import { createTokenBucket } from '../limiter.js';
import { HttpError, VenueUnreachableError } from '../types.js';
import type { AdapterContext, CachedCandle, FetchLike, RateLimiter } from '../types.js';
import { withRetry } from '../withRetry.js';
import {
  BINANCE_INVALID_SYMBOL,
  BinanceErrorSchema,
  BinanceExchangeInfoSchema,
  BinanceKlinesSchema,
  BinanceContractError,
  parseBinance,
  type BinanceSymbolInfo,
} from './schemas.js';

export const BINANCE_API_BASE = 'https://api.binance.com';

/** Documented cap on one klines page; pagination exists because of it. */
export const BINANCE_MAX_LIMIT = 1000;

/**
 * Request weights, conservative.
 *
 * Binance answers with `X-MBX-USED-WEIGHT-1M` and escalates 429 → 418, where 418 is an
 * IP ban measured in minutes. Being throttled is recoverable; being banned strands
 * every user behind the same egress address, so the budget here is well under the
 * documented 6000/min.
 */
export const BINANCE_WEIGHTS = {
  capacity: 1200,
  refillPerMinute: 1200,
  klines: 2,
  exchangeInfo: 20,
} as const;

/** Intervals Binance serves, coarsest-last. Used by `pickInterval`. */
export const BINANCE_INTERVALS: readonly IntervalSpec[] = [
  { name: '1m', ms: 60_000 },
  { name: '3m', ms: 3 * 60_000 },
  { name: '5m', ms: 5 * 60_000 },
  { name: '15m', ms: 15 * 60_000 },
  { name: '30m', ms: 30 * 60_000 },
  { name: '1h', ms: 60 * 60_000 },
  { name: '2h', ms: 2 * 60 * 60_000 },
  { name: '4h', ms: 4 * 60 * 60_000 },
  { name: '6h', ms: 6 * 60 * 60_000 },
  { name: '8h', ms: 8 * 60 * 60_000 },
  { name: '12h', ms: 12 * 60 * 60_000 },
  { name: '1d', ms: 24 * 60 * 60_000 },
  { name: '3d', ms: 3 * 24 * 60 * 60_000 },
  { name: '1w', ms: 7 * 24 * 60 * 60_000 },
];

let sharedLimiter: RateLimiter | undefined;

function defaultLimiter(): RateLimiter {
  sharedLimiter ??= createTokenBucket({
    capacity: BINANCE_WEIGHTS.capacity,
    refillPerMinute: BINANCE_WEIGHTS.refillPerMinute,
  });
  return sharedLimiter;
}

/** Binance sends `Retry-After` in whole seconds on 429 and 418. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/** Thrown when Binance does not list the symbol at all. SPEC §4.6's fallback trigger. */
export class UnknownSymbolError extends Error {
  constructor(readonly symbol: string) {
    super(
      `Binance does not list "${symbol}". Map it to a Binance symbol (for example ` +
        `BTC → BTCUSDT), or upload your own OHLCV CSV for it.`,
    );
    this.name = 'UnknownSymbolError';
  }
}

interface BinanceGet {
  <T>(
    path: string,
    params: Record<string, string | number | undefined>,
    parse: (json: unknown) => T,
    context: string,
    weight: number,
  ): Promise<T>;
}

function createGet(ctx: AdapterContext, baseUrl: string): BinanceGet {
  const doFetch = ctx.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!doFetch) {
    throw new Error(
      'No fetch implementation available. Pass one via AdapterContext.fetch (this is also ' +
        'how the adapter is tested against recorded fixtures).',
    );
  }

  const limiter =
    ctx.limiter ??
    (ctx.now || ctx.sleep
      ? createTokenBucket({
          capacity: BINANCE_WEIGHTS.capacity,
          refillPerMinute: BINANCE_WEIGHTS.refillPerMinute,
          ...(ctx.now ? { now: ctx.now } : {}),
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        })
      : defaultLimiter());

  return async function get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    parse: (json: unknown) => T,
    context: string,
    weight: number,
  ): Promise<T> {
    await limiter.take(weight);

    const query = Object.entries(params)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;

    return withRetry(
      async () => {
        let response;
        try {
          response = await doFetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            body: '',
          });
        } catch (error) {
          throw new VenueUnreachableError(baseUrl, error);
        }

        const text = await response.text();

        if (!response.ok) {
          // An invalid symbol arrives as a 400 carrying code -1121. That is an answer
          // — "we don't list this" — not a transport failure, and retrying it three
          // more times only spends rate-limit budget to be told the same thing.
          const envelope = BinanceErrorSchema.safeParse(safeJson(text));
          if (envelope.success && envelope.data.code === BINANCE_INVALID_SYMBOL) {
            throw new UnknownSymbolError(String(params['symbol'] ?? ''));
          }
          throw new HttpError(
            response.status,
            url,
            text,
            parseRetryAfter(response.headers.get('retry-after')),
          );
        }

        const json = safeJson(text);
        if (json === undefined) {
          throw new BinanceContractError(
            context,
            [{ path: '', message: 'response body was not valid JSON' }],
            text.slice(0, 500),
          );
        }
        return parse(json);
      },
      { ...(ctx.sleep ? { sleep: ctx.sleep } : {}) },
    );
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface BinanceClient {
  klines(
    symbol: string,
    interval: string,
    range: TimeRange,
    intervalMs: number,
  ): Promise<CachedCandle[]>;
  symbolInfo(symbols: readonly string[]): Promise<BinanceSymbolInfo[]>;
}

export function createBinanceClient(
  ctx: AdapterContext = {},
  baseUrl = BINANCE_API_BASE,
): BinanceClient {
  const get = createGet(ctx, baseUrl);

  return {
    async klines(symbol, interval, range, intervalMs): Promise<CachedCandle[]> {
      const out: CachedCandle[] = [];
      let cursor = range.from;

      // Paginate forward. Binance caps a page at 1000 bars and returns them ascending,
      // so the next request starts one millisecond after the last bar we received —
      // starting *at* it would re-request that bar forever on a range that ends
      // exactly on a bucket boundary.
      while (cursor <= range.to) {
        const page = await get(
          '/api/v3/klines',
          {
            symbol,
            interval,
            startTime: cursor,
            endTime: range.to,
            limit: BINANCE_MAX_LIMIT,
          },
          (json) => parseBinance(BinanceKlinesSchema, json, `klines ${symbol} ${interval}`),
          `klines ${symbol} ${interval}`,
          BINANCE_WEIGHTS.klines,
        );

        if (page.length === 0) break;

        for (const k of page) {
          out.push({
            t: k[0],
            o: Number(k[1]),
            h: Number(k[2]),
            l: Number(k[3]),
            c: Number(k[4]),
            v: Number(k[5]),
          });
        }

        const last = page[page.length - 1]!;
        if (page.length < BINANCE_MAX_LIMIT) break;
        const next = last[0] + intervalMs;
        // Defensive: a page that does not advance would spin forever.
        if (next <= cursor) break;
        cursor = next;
      }

      return out;
    },

    async symbolInfo(symbols): Promise<BinanceSymbolInfo[]> {
      if (symbols.length === 0) return [];
      // The `symbols` filter keeps this to a few kilobytes; the unfiltered
      // exchangeInfo response is megabytes and carries the same weight.
      const info = await get(
        '/api/v3/exchangeInfo',
        { symbols: JSON.stringify([...symbols]) },
        (json) => parseBinance(BinanceExchangeInfoSchema, json, 'exchangeInfo'),
        'exchangeInfo',
        BINANCE_WEIGHTS.exchangeInfo,
      );
      return info.symbols;
    },
  };
}

/**
 * Candidate Binance symbols for a CSV symbol, best first.
 *
 * SPEC §4.6 asks for a symbol-mapping step, `BTC → BTCUSDT`. This produces the
 * suggestions that step offers; it never silently commits to one, because "BTC" could
 * reasonably mean BTCUSDT, BTCUSDC or BTCFDUSD and the difference shows up as a
 * slightly wrong price on every frame.
 */
export function symbolCandidates(raw: string): string[] {
  const symbol = raw.trim().toUpperCase();
  if (symbol === '') return [];

  // Strip the decorations perp venues add: "BTC-PERP", "BTC-USD-SWAP", "BTCUSDT.P".
  const base = symbol
    .replace(/[.-]P$/, '')
    .replace(/[-/_]?(PERP|PERPETUAL|SWAP|FUTURES)$/, '')
    .replace(/[-/_]/g, '');

  const quotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'USD'];
  const alreadyQuoted = quotes.find((q) => base.endsWith(q) && base.length > q.length);

  const out: string[] = [];
  const push = (s: string): void => {
    if (s.length >= 5 && !out.includes(s)) out.push(s);
  };

  if (alreadyQuoted) {
    push(base);
    // "BTCUSD" is not a Binance spot symbol; "BTCUSDT" is. Offer the substitution.
    const stem = base.slice(0, -alreadyQuoted.length);
    for (const q of quotes) push(stem + q);
  } else {
    for (const q of quotes) push(base + q);
  }

  return out;
}
