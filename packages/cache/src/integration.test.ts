/**
 * Does the cache actually cache?
 *
 * The unit tests above check the cache in isolation. This drives the real Hyperliquid
 * adapter against a recorded fixture through a counting fetch, which is the only way to
 * show that the wiring saves requests rather than merely storing rows.
 *
 * It lives in this package because packages/adapters must not depend on this one — the
 * dependency runs cache -> adapters, so that a browser bundle importing an adapter
 * never pulls in a native SQLite module.
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUnlimitedLimiter,
  hyperliquidAdapter,
  type AdapterContext,
  type FetchLike,
} from '@trade-replay/adapters';
import { createFixtureFetch } from '@trade-replay/adapters/hyperliquid';
// Node-only entry: keeps `node:fs` out of any browser bundle importing the adapter.
import { loadFixtureStore } from '@trade-replay/adapters/hyperliquid/fixtures';
import { HL_INTERVALS, buildEpisodes, seriesRangeFor, pickInterval } from '@trade-replay/core';
import { createCandleCache, createFillCache } from './index.js';
import { openCache, type CacheHandle } from './db.js';

const FIXTURE = join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  'fixtures/hyperliquid/synthetic',
);
const store = loadFixtureStore(FIXTURE);
const ADDRESS = '0x393d0b87ed38fc779fd9611144ae649ba6082109';
/** Well after the fixture's last bar, so every bucket in range is closed. */
const NOW = Date.UTC(2026, 0, 1);

const handles: CacheHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()?.close();
});

interface Net {
  fetch: FetchLike;
  calls: () => number;
  /** Request bodies, so a test can assert WHICH window was asked for. */
  bodies: () => Record<string, unknown>[];
  reset: () => void;
}

function counting(): Net {
  const inner = createFixtureFetch(store);
  let seen: Record<string, unknown>[] = [];
  return {
    fetch: (url, init) => {
      seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return inner(url, init);
    },
    calls: () => seen.length,
    bodies: () => seen,
    reset: () => {
      seen = [];
    },
  };
}

function context(fetch: FetchLike, handle: CacheHandle): AdapterContext {
  return {
    fetch,
    limiter: createUnlimitedLimiter(),
    sleep: async () => undefined,
    now: () => NOW,
    candleCache: createCandleCache(handle.db),
    fillCache: createFillCache(handle.db),
  };
}

function db(): CacheHandle {
  const handle = openCache({ url: ':memory:' });
  handles.push(handle);
  return handle;
}

const SERIES = { instrument: 'HYPE-PERP', interval: '1h', from: Date.UTC(2025, 10, 2), to: Date.UTC(2025, 10, 4) };

describe('candles through the adapter', () => {
  it('goes to the venue the first time and not the second', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());

    const first = await hyperliquidAdapter.fetchSeries(SERIES, ctx);
    expect(net.calls()).toBeGreaterThan(0);
    expect(first.kind).toBe('ohlcv');

    net.reset();
    const second = await hyperliquidAdapter.fetchSeries(SERIES, ctx);

    expect(net.calls()).toBe(0);
    expect(second).toEqual(first);
  });

  it('fetches only the new span when the window is widened', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());

    await hyperliquidAdapter.fetchSeries(SERIES, ctx);
    net.reset();

    const wider = { ...SERIES, to: SERIES.to + 24 * 3_600_000 };
    const result = await hyperliquidAdapter.fetchSeries(wider, ctx);

    // One request for the extra day, not a refetch of the whole window.
    expect(net.calls()).toBe(1);
    if (result.kind !== 'ohlcv') throw new Error('unreachable');
    expect(result.candles.length).toBeGreaterThan(48);
  });

  it('serves a reopened database without touching the venue', async () => {
    const net = counting();
    const handle = db();
    await hyperliquidAdapter.fetchSeries(SERIES, context(net.fetch, handle));

    // Same file, new connection: a restarted server must not refetch everything.
    net.reset();
    const again = await hyperliquidAdapter.fetchSeries(SERIES, context(net.fetch, handle));
    expect(net.calls()).toBe(0);
    expect(again.kind).toBe('ohlcv');
  });

  it('keeps a different interval separate rather than reusing the wrong bars', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());

    await hyperliquidAdapter.fetchSeries(SERIES, ctx);
    net.reset();
    await hyperliquidAdapter.fetchSeries({ ...SERIES, interval: '4h' }, ctx);

    expect(net.calls()).toBeGreaterThan(0);
  });
});

describe('fills through the adapter', () => {
  it('asks for the whole history once, then only forward from the newest fill', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());
    const input = { venue: 'hyperliquid' as const, address: ADDRESS };

    const first = await hyperliquidAdapter.fetchFills(input, undefined, ctx);
    expect(first.length).toBeGreaterThan(0);
    expect(net.bodies()[0]!['startTime']).toBe(0);

    net.reset();
    const second = await hyperliquidAdapter.fetchFills(input, undefined, ctx);

    // SPEC §10: "on refetch only request startTime = lastSyncedTs". One small forward
    // sync remains — the point is that it no longer asks for the whole history.
    expect(net.calls()).toBe(1);
    expect(net.bodies()[0]!['startTime']).toBe(Math.max(...first.map((f) => f.ts)));
    expect(second).toEqual(first);
  });

  it('reconstructs identical episodes from cache as from the venue', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());
    const input = { venue: 'hyperliquid' as const, address: ADDRESS };

    const live = buildEpisodes(await hyperliquidAdapter.fetchFills(input, undefined, ctx), {
      venue: 'hyperliquid',
    });
    const cached = buildEpisodes(await hyperliquidAdapter.fetchFills(input, undefined, ctx), {
      venue: 'hyperliquid',
    });

    // The whole point of caching raw payloads: the §5 fold runs again on read, so a
    // later correction to the fold or the schema fixes cached data too.
    expect(cached).toEqual(live);
    expect(cached.length).toBeGreaterThanOrEqual(4);
  });

  it('backfills when a later request reaches further back', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());
    const input = { venue: 'hyperliquid' as const, address: ADDRESS };

    const late = { from: Date.UTC(2025, 10, 5), to: NOW };
    await hyperliquidAdapter.fetchFills(input, late, ctx);
    net.reset();

    const full = await hyperliquidAdapter.fetchFills(input, { from: 0, to: NOW }, ctx);

    // Without a syncedFromTs the cache would think it already held everything and
    // serve a history missing its beginning.
    expect(net.calls()).toBeGreaterThan(0);
    expect(Math.min(...full.map((f) => f.ts))).toBeLessThan(late.from);
  });
});

describe('a full episode load', () => {
  it('is served entirely from cache the second time', async () => {
    const net = counting();
    const ctx = context(net.fetch, db());
    const input = { venue: 'hyperliquid' as const, address: ADDRESS };

    const load = async () => {
      const fills = await hyperliquidAdapter.fetchFills(input, undefined, ctx);
      const range = { from: Math.min(...fills.map((f) => f.ts)), to: Math.max(...fills.map((f) => f.ts)) };
      const funding = (await hyperliquidAdapter.fetchFunding?.(input, range, ctx)) ?? [];
      const episodes = buildEpisodes(fills, { venue: 'hyperliquid', funding });

      for (const episode of episodes) {
        const seriesRange = seriesRangeFor(episode, NOW);
        const picked = pickInterval((episode.closedAt ?? NOW) - episode.openedAt, HL_INTERVALS);
        await hyperliquidAdapter.fetchSeries(
          { instrument: episode.instrument, interval: picked.interval, ...seriesRange },
          ctx,
        );
      }
      return episodes;
    };

    const first = await load();
    const firstCalls = net.calls();
    net.reset();
    const second = await load();

    expect(second).toEqual(first);
    // Funding has no cache of its own yet, so a couple of calls remain; what matters is
    // that candles and fill pagination stopped hitting the venue.
    expect(net.calls()).toBeLessThan(firstCalls / 2);
  });
});
