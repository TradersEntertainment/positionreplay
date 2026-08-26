/**
 * Replays recorded Polymarket Perps responses through the real adapter code path.
 *
 * Routes on the request URL, because this venue is GET-with-query-params rather than
 * Hyperliquid's single POST endpoint. Everything above the socket is genuinely
 * executed: pagination, Zod validation, mapping and the §5 fold.
 */

import type { FetchLike, HttpResponse } from '../types.js';

export interface PerpsFixtureStore {
  instruments: unknown;
  portfolio: unknown;
  /** Keyed by instrument id. The option-A endpoint. */
  positionFills: Map<number, unknown>;
  /**
   * `/v1/info/fills` pages, keyed by the cursor that asks for them.
   *
   * The first page is keyed by the empty string, since the first request carries no
   * cursor. Recorded as several pages so a broken cursor walk fails here rather than in
   * production against an account with more than one page of history.
   */
  history: Map<string, unknown>;
  /** Keyed `${instrumentId}-${interval}`. */
  klines: Map<string, unknown>;
  /** Keyed `${instrumentId}-1s`. */
  markHistory: Map<string, unknown>;
}

export interface PerpsFixtureOptions {
  onRequest?: (path: string, params: URLSearchParams) => void;
  /** Force a status for one path, so error handling can be exercised. */
  failWith?: (path: string, params: URLSearchParams) => number | undefined;
  /**
   * Body for a forced failure.
   *
   * The venue's error handling reads the body, not just the status: a 400 carrying
   * `{"error":"account not found"}` means a wrong address space and gets its own
   * message. A test that could only set the status could not reach that branch.
   */
  body?: (path: string, params: URLSearchParams) => string;
}

function ok(data: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  };
}

function fail(status: number, message: string): HttpResponse {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => message,
  };
}

/** Bucket rows within [start, end], honouring the venue's 1000-row page limit. */
function page(rows: unknown, start: number, end: number, limit = 1000) {
  const body = rows as { data?: [number, ...number[]][] } | undefined;
  const all = body?.data ?? [];
  const within = all.filter((row) => row[0] >= start && row[0] <= end).sort((a, b) => a[0] - b[0]);
  const slice = within.slice(0, limit);
  return { data: slice, more: within.length > limit };
}

export function createPerpsFixtureFetch(
  store: PerpsFixtureStore,
  options: PerpsFixtureOptions = {},
): FetchLike {
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const params = url.searchParams;
    options.onRequest?.(path, params);

    const forced = options.failWith?.(path, params);
    if (forced !== undefined) {
      return fail(forced, options.body?.(path, params) ?? `fixture forced ${forced} for ${path}`);
    }

    if (path === '/v1/info/instruments') return ok(store.instruments);
    if (path === '/v1/info/public-portfolio') return ok(store.portfolio);

    if (path === '/v1/info/position-fills') {
      const id = Number(params.get('instrument_id'));
      return ok(store.positionFills.get(id) ?? []);
    }

    if (path === '/v1/info/fills') {
      const cursor = params.get('cursor') ?? '';
      const page = store.history.get(cursor);
      // An unrecorded cursor is a bug in the walk, not an empty history — returning an
      // empty page would let it pass as "the account has nothing older".
      if (page === undefined) {
        return fail(404, `Fixture has no /v1/info/fills page for cursor "${cursor}"`);
      }
      return ok(page);
    }

    const start = Number(params.get('start_timestamp') ?? 0);
    const end = Number(params.get('end_timestamp') ?? Number.MAX_SAFE_INTEGER);

    if (path === '/v1/info/klines') {
      const key = `${params.get('instrument_id')}-${params.get('interval')}`;
      const rows = store.klines.get(key);
      if (!rows) return ok({ data: [], more: false });
      return ok(page(rows, start, end));
    }

    if (path === '/v1/info/mark-history') {
      const key = `${params.get('instrument_id')}-${params.get('interval')}`;
      const rows = store.markHistory.get(key);
      if (!rows) return ok({ data: [], more: false });
      return ok(page(rows, start, end));
    }

    return fail(404, `Fixture has no recording for ${path}`);
  };
}
