/**
 * The rules a real `fetch` enforces and a test double does not.
 *
 * Every adapter is tested against an injected fetch, which is what makes them testable
 * offline at all — but a double accepts whatever it is handed. A GET carrying
 * `body: ''` passed 470 tests and every fixture replay, then failed in production with
 * "Request with GET/HEAD method cannot have body", which reads as a network problem
 * and is not one.
 *
 * So this suite hands each client a double that enforces what undici enforces.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpRequest } from './types.js';
import { createPerpsClient } from './polymarket-perps/client.js';
import { PmInstrumentsSchema } from './polymarket-perps/schemas.js';
import { createBinanceClient } from './csv/binance.js';
import { createHlClient } from './hyperliquid/client.js';
import { HlCandlesSchema } from './hyperliquid/schemas.js';

/** Rejects exactly what the platform's fetch rejects, and records what it was sent. */
function strictFetch(payload: unknown): { fetch: FetchLike; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const fetch: FetchLike = async (_url, init) => {
    seen.push(init);
    const method = init.method.toUpperCase();
    if ((method === 'GET' || method === 'HEAD') && init.body !== undefined) {
      throw new TypeError('Request with GET/HEAD method cannot have body.');
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetch, seen };
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 20);

describe('GET clients send no body', () => {
  it('Polymarket Perps', async () => {
    const { fetch, seen } = strictFetch([]);
    await createPerpsClient({ fetch, sleep: async () => {} }).get(
      '/v1/info/instruments',
      {},
      PmInstrumentsSchema,
      'instruments',
      1,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.body).toBeUndefined();
  });

  it('Binance klines', async () => {
    const { fetch, seen } = strictFetch([]);
    await createBinanceClient({ fetch, sleep: async () => {} }).klines(
      'BTCUSDT',
      '1h',
      { from: T0, to: T0 + HOUR },
      HOUR,
    );
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.body).toBeUndefined();
  });
});

describe('the guard itself', () => {
  it('rejects the exact call that shipped broken', async () => {
    // Belt and braces: if this ever stops throwing, the two checks above stop meaning
    // anything and would pass against a client that reintroduced the bug.
    const { fetch } = strictFetch([]);
    await expect(
      fetch('https://example.test/x', { method: 'GET', headers: {}, body: '' }),
    ).rejects.toThrow(/cannot have body/);
  });
});

describe('POST clients still send one', () => {
  it('Hyperliquid, whose whole API is a POST', async () => {
    // The mirror of the check above: dropping the body here would break the venue that
    // does need it, and the two must not be fixed into each other's shape.
    const { fetch, seen } = strictFetch([]);
    await createHlClient({ fetch, sleep: async () => {} }).info(
      { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: T0, endTime: T0 + HOUR } },
      HlCandlesSchema,
      'candleSnapshot',
      1,
    );
    expect(seen[0]?.method).toBe('POST');
    expect(typeof seen[0]?.body).toBe('string');
    expect(seen[0]?.body).toContain('candleSnapshot');
  });
});
