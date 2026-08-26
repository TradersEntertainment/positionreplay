/**
 * Replays recorded Hyperliquid responses through the real adapter code path.
 *
 * This is how the adapter is exercised where the venue is unreachable — a sandbox, a
 * CI runner, an egress-restricted environment. It routes on the same request bodies
 * the live client sends, so pagination, schema validation, mapping and the §5 fold
 * are all genuinely executed; only the socket is replaced.
 *
 * It is deliberately NOT a mock of the adapter: passing these tests proves our logic
 * is right about the data it is given. It proves nothing about whether the recorded
 * shape matches the live venue — only `pnpm verify:m1` can do that.
 */

import type { FetchLike, HttpResponse } from '../types.js';

/** Raw, unparsed venue payloads keyed the way the venue serves them. */
export interface FixtureStore {
  fills: unknown[];
  funding: unknown[];
  /** Keyed `${coin}-${interval}`, e.g. "HYPE-1h". */
  candles: Map<string, unknown[]>;
}

export interface FixtureFetchOptions {
  /** Bars returned per candleSnapshot response. SPEC §4.3 caps this at 5000. */
  candlePageLimit?: number;
  /** Fills returned per userFillsByTime response. SPEC §4.3 caps this at 2000. */
  fillPageLimit?: number;
  /** Called with every request body, so tests can assert on pagination behaviour. */
  onRequest?: (body: Record<string, unknown>) => void;
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

function timeOf(entry: unknown): number {
  const t = (entry as { time?: unknown }).time;
  return typeof t === 'number' ? t : Number.NaN;
}

function barTimeOf(entry: unknown): number {
  const t = (entry as { t?: unknown }).t;
  return typeof t === 'number' ? t : Number.NaN;
}

export function createFixtureFetch(store: FixtureStore, options: FixtureFetchOptions = {}): FetchLike {
  const fillPageLimit = options.fillPageLimit ?? 2000;
  const candlePageLimit = options.candlePageLimit ?? 5000;

  return async (_url, init) => {
    // Hyperliquid's entire API is one POST and the body carries the query, so a
    // request without one is a caller bug rather than a venue shape to tolerate.
    if (init.body === undefined) {
      throw new Error(`Hyperliquid fixture received a ${init.method} with no body.`);
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    options.onRequest?.(body);

    if (body['type'] === 'userFillsByTime') {
      const startTime = Number(body['startTime'] ?? 0);
      const endTime = Number(body['endTime'] ?? Number.POSITIVE_INFINITY);
      const page = store.fills
        .filter((f) => timeOf(f) >= startTime && timeOf(f) <= endTime)
        .sort((a, b) => timeOf(a) - timeOf(b))
        .slice(0, fillPageLimit);
      return ok(page);
    }

    if (body['type'] === 'userFunding') {
      const startTime = Number(body['startTime'] ?? 0);
      const endTime = Number(body['endTime'] ?? Number.POSITIVE_INFINITY);
      const page = store.funding
        .filter((f) => timeOf(f) >= startTime && timeOf(f) <= endTime)
        .sort((a, b) => timeOf(a) - timeOf(b))
        .slice(0, fillPageLimit);
      return ok(page);
    }

    if (body['type'] === 'candleSnapshot') {
      const req = body['req'] as Record<string, unknown> | undefined;
      if (!req) return fail(400, 'candleSnapshot requires a req object');
      const key = `${String(req['coin'])}-${String(req['interval'])}`;
      const bars = store.candles.get(key) ?? [];
      const startTime = Number(req['startTime'] ?? 0);
      const endTime = Number(req['endTime'] ?? Number.POSITIVE_INFINITY);
      const page = bars
        .filter((c) => barTimeOf(c) >= startTime && barTimeOf(c) <= endTime)
        .sort((a, b) => barTimeOf(a) - barTimeOf(b))
        .slice(0, candlePageLimit);
      return ok(page);
    }

    return fail(400, `Fixture has no recording for request type "${String(body['type'])}"`);
  };
}
