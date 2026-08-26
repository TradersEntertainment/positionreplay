/**
 * Replays recorded Binance responses through the real adapter code path.
 *
 * Routes on the request URL. Everything above the socket runs for real — pagination,
 * Zod validation, the symbol mapping and the §5 fold — so a fixture run exercises the
 * same reconstruction the live path does.
 */

import type { FetchLike, HttpResponse } from '../types.js';
import { BINANCE_MAX_LIMIT } from './binance.js';

export interface BinanceFixtureStore {
  /** Keyed `${symbol}-${interval}`; the value is the raw klines array. */
  klines: Map<string, unknown>;
  /** Keyed by symbol; the raw exchangeInfo `symbols` entry. */
  symbols: Map<string, unknown>;
}

export interface BinanceFixtureOptions {
  onRequest?: (path: string, params: URLSearchParams) => void;
}

function ok(data: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  };
}

function fail(status: number, body: unknown): HttpResponse {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

/** Klines are positional arrays; element 0 is the bucket open time. */
function isKline(row: unknown): row is [number, ...unknown[]] {
  return Array.isArray(row) && typeof row[0] === 'number';
}

export function createBinanceFixtureFetch(
  store: BinanceFixtureStore,
  options: BinanceFixtureOptions = {},
): FetchLike {
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    const params = url.searchParams;
    options.onRequest?.(url.pathname, params);

    if (url.pathname === '/api/v3/klines') {
      const symbol = params.get('symbol') ?? '';
      const interval = params.get('interval') ?? '';
      const rows = store.klines.get(`${symbol}-${interval}`);

      if (rows === undefined) {
        // Binance's own answer for a symbol it does not list, so the adapter's
        // UnknownSymbolError path is exercised rather than bypassed.
        return fail(400, { code: -1121, msg: 'Invalid symbol.' });
      }

      const start = Number(params.get('startTime') ?? Number.NEGATIVE_INFINITY);
      const end = Number(params.get('endTime') ?? Number.POSITIVE_INFINITY);
      const limit = Math.min(Number(params.get('limit') ?? BINANCE_MAX_LIMIT), BINANCE_MAX_LIMIT);

      const all = (Array.isArray(rows) ? rows : []).filter(isKline);
      const within = all
        .filter((row) => row[0] >= start && row[0] <= end)
        .sort((a, b) => a[0] - b[0]);

      // Slicing to `limit` is what makes the adapter's pagination real here: a fixture
      // that always returned everything would leave that loop untested.
      return ok(within.slice(0, limit));
    }

    if (url.pathname === '/api/v3/exchangeInfo') {
      const requested = parseSymbolsParam(params.get('symbols'));
      const symbols = requested
        .map((s) => store.symbols.get(s))
        .filter((entry): entry is unknown => entry !== undefined);
      return ok({ symbols });
    }

    return fail(404, { code: -1121, msg: `No fixture for ${url.pathname}` });
  };
}

function parseSymbolsParam(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
