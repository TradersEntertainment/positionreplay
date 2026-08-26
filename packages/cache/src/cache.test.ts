import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CachedCandle, CandleKey } from '@trade-replay/adapters';
import { createCandleCache, createFillCache } from './index.js';
import { openCache, type CacheHandle } from './db.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const KEY: CandleKey = { venue: 'hyperliquid', instrument: 'HYPE-PERP', interval: '1h' };
const CTX = { intervalMs: HOUR, now: Date.UTC(2025, 10, 10) };

const handles: CacheHandle[] = [];
const dirs: string[] = [];

function memory(): CacheHandle {
  const handle = openCache({ url: ':memory:' });
  handles.push(handle);
  return handle;
}

function onDisk(): { handle: CacheHandle; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tr-cache-'));
  dirs.push(dir);
  const handle = openCache({ url: join(dir, 'cache.db') });
  handles.push(handle);
  return { handle, dir };
}

afterEach(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function bars(startTs: number, count: number, price = 10): CachedCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: startTs + i * HOUR,
    o: price + i,
    h: price + i + 1,
    l: price + i - 1,
    c: price + i,
    v: 100,
  }));
}

describe('candle cache — reads and writes', () => {
  it('returns nothing before anything is written', async () => {
    const cache = createCandleCache(memory().db);
    const range = { from: CTX.now - 10 * HOUR, to: CTX.now - 5 * HOUR };
    expect(await cache.read(KEY, range, CTX)).toEqual([]);
  });

  it('round-trips bars within the requested window', async () => {
    const cache = createCandleCache(memory().db);
    const from = CTX.now - 10 * HOUR;
    const written = bars(from, 5);

    await cache.write(KEY, written, { from, to: from + 5 * HOUR }, CTX);
    const read = await cache.read(KEY, { from, to: from + 5 * HOUR }, CTX);

    expect(read).toEqual(written);
  });

  it('clips reads to the requested window', async () => {
    const cache = createCandleCache(memory().db);
    const from = CTX.now - 20 * HOUR;
    await cache.write(KEY, bars(from, 20), { from, to: CTX.now }, CTX);

    const read = await cache.read(KEY, { from: from + 5 * HOUR, to: from + 8 * HOUR }, CTX);
    expect(read.map((b) => b.t)).toEqual([
      from + 5 * HOUR,
      from + 6 * HOUR,
      from + 7 * HOUR,
      from + 8 * HOUR,
    ]);
  });

  it('keeps different instruments and intervals apart', async () => {
    const cache = createCandleCache(memory().db);
    const from = CTX.now - 5 * HOUR;
    const range = { from, to: CTX.now };

    await cache.write(KEY, bars(from, 5, 10), range, CTX);
    await cache.write({ ...KEY, instrument: 'BTC-PERP' }, bars(from, 5, 90_000), range, CTX);
    await cache.write({ ...KEY, interval: '4h' }, bars(from, 5, 50), range, CTX);

    expect((await cache.read(KEY, range, CTX))[0]!.o).toBe(10);
    expect((await cache.read({ ...KEY, instrument: 'BTC-PERP' }, range, CTX))[0]!.o).toBe(90_000);
    expect((await cache.read({ ...KEY, interval: '4h' }, range, CTX))[0]!.o).toBe(50);
  });

  it('overwrites a bar rather than duplicating it', async () => {
    const cache = createCandleCache(memory().db);
    const from = CTX.now - 3 * HOUR;
    const range = { from, to: from + 2 * HOUR };

    await cache.write(KEY, bars(from, 2, 10), range, CTX);
    await cache.write(KEY, bars(from, 2, 99), range, CTX);

    const read = await cache.read(KEY, range, CTX);
    expect(read).toHaveLength(2);
    expect(read[0]!.o).toBe(99);
  });
});

/** SPEC §10: "Only the most recent (still-open) bar is volatile." */
describe('candle cache — the still-forming bar', () => {
  it('never serves a bar whose bucket has not closed', async () => {
    const cache = createCandleCache(memory().db);
    // The bucket containing `now` is still filling.
    const openBucket = Math.floor(CTX.now / HOUR) * HOUR;
    const from = openBucket - 3 * HOUR;

    await cache.write(KEY, bars(from, 4), { from, to: CTX.now }, CTX);
    const read = await cache.read(KEY, { from, to: CTX.now }, CTX);

    expect(read.map((b) => b.t)).not.toContain(openBucket);
    expect(read).toHaveLength(3);
  });

  it('always reports the volatile tail as missing, so it is refetched', async () => {
    const cache = createCandleCache(memory().db);
    const openBucket = Math.floor(CTX.now / HOUR) * HOUR;
    const from = openBucket - 3 * HOUR;
    const range = { from, to: CTX.now };

    await cache.write(KEY, bars(from, 4), range, CTX);
    const missing = await cache.missing(KEY, range, CTX);

    // Everything closed is covered; the open bucket must still be requested.
    expect(missing).toHaveLength(1);
    expect(missing[0]!.to).toBe(CTX.now);
    expect(missing[0]!.from).toBeLessThanOrEqual(openBucket);
  });

  it('is a pure hit for a window entirely in the past', async () => {
    const cache = createCandleCache(memory().db);
    const from = CTX.now - 100 * HOUR;
    const to = CTX.now - 50 * HOUR;

    await cache.write(KEY, bars(from, 51), { from, to }, CTX);
    expect(await cache.missing(KEY, { from, to }, CTX)).toEqual([]);
  });
});

describe('candle cache — coverage (gap tracking)', () => {
  it('reports the whole range missing when nothing is cached', async () => {
    const cache = createCandleCache(memory().db);
    const range = { from: CTX.now - 10 * HOUR, to: CTX.now - 5 * HOUR };
    expect(await cache.missing(KEY, range, CTX)).toEqual([range]);
  });

  it('does NOT refetch a span the venue simply had no bars for', async () => {
    const cache = createCandleCache(memory().db);
    const from = CTX.now - 20 * HOUR;
    const to = CTX.now - 10 * HOUR;

    // A quiet market: the request succeeded and returned nothing.
    await cache.write(KEY, [], { from, to }, CTX);

    // Row-only caching cannot tell this from "never asked" and would refetch forever.
    expect(await cache.missing(KEY, { from, to }, CTX)).toEqual([]);
  });

  it('reports only the uncovered part when the range is widened', async () => {
    const cache = createCandleCache(memory().db);
    const mid = { from: CTX.now - 20 * HOUR, to: CTX.now - 10 * HOUR };
    await cache.write(KEY, bars(mid.from, 11), mid, CTX);

    const wider = { from: CTX.now - 30 * HOUR, to: CTX.now - 5 * HOUR };
    const missing = await cache.missing(KEY, wider, CTX);

    expect(missing).toHaveLength(2);
    expect(missing[0]).toEqual({ from: wider.from, to: mid.from - 1 });
    expect(missing[1]).toEqual({ from: mid.to + 1, to: wider.to });
  });

  it('finds a hole between two covered spans', async () => {
    const cache = createCandleCache(memory().db);
    const base = CTX.now - 100 * HOUR;
    await cache.write(KEY, [], { from: base, to: base + 10 * HOUR }, CTX);
    await cache.write(KEY, [], { from: base + 30 * HOUR, to: base + 40 * HOUR }, CTX);

    const missing = await cache.missing(KEY, { from: base, to: base + 40 * HOUR }, CTX);
    expect(missing).toEqual([{ from: base + 10 * HOUR + 1, to: base + 30 * HOUR - 1 }]);
  });

  it('merges touching coverage rather than accumulating rows forever', async () => {
    const cache = createCandleCache(memory().db);
    const base = CTX.now - 100 * HOUR;

    for (let i = 0; i < 10; i++) {
      await cache.write(KEY, [], { from: base + i * HOUR, to: base + (i + 1) * HOUR }, CTX);
    }

    expect(await cache.coverageRowCount(KEY)).toBe(1);
    expect(await cache.missing(KEY, { from: base, to: base + 10 * HOUR }, CTX)).toEqual([]);
  });
});

describe('candle cache — persistence', () => {
  it('survives closing and reopening the database', async () => {
    const { handle, dir } = onDisk();
    const from = CTX.now - 10 * HOUR;
    const range = { from, to: CTX.now - 5 * HOUR };

    await createCandleCache(handle.db).write(KEY, bars(from, 6), range, CTX);
    handle.close();

    const reopened = openCache({ url: join(dir, 'cache.db') });
    handles.push(reopened);
    const read = await createCandleCache(reopened.db).read(KEY, range, CTX);

    expect(read).toHaveLength(6);
    expect(await createCandleCache(reopened.db).missing(KEY, range, CTX)).toEqual([]);
  });
});

describe('fill cache (SPEC §10)', () => {
  const ADDRESS = '0x393d0b87ed38fc779fd9611144ae649ba6082109';
  const record = (id: string, ts: number) => ({ id, ts, payload: { tid: id, time: ts } });

  it('has no state for an account it has never seen', async () => {
    const cache = createFillCache(memory().db);
    expect(await cache.readState('hyperliquid', ADDRESS)).toBeNull();
  });

  it('stores fills and the sync window', async () => {
    const cache = createFillCache(memory().db);
    await cache.write(
      'hyperliquid',
      ADDRESS,
      [record('a', 1_000), record('b', 2_000)],
      { syncedFromTs: 0, lastSyncedTs: 2_000 },
    );

    expect(await cache.readState('hyperliquid', ADDRESS)).toEqual({
      syncedFromTs: 0,
      lastSyncedTs: 2_000,
    });
    const read = await cache.read('hyperliquid', ADDRESS, { from: 0, to: 10_000 });
    expect(read.map((r) => r.id)).toEqual(['a', 'b']);
    expect(read[0]!.payload).toEqual({ tid: 'a', time: 1_000 });
  });

  it('dedupes by id across syncs, since the boundary fill comes back', async () => {
    const cache = createFillCache(memory().db);
    await cache.write('hyperliquid', ADDRESS, [record('a', 1_000)], {
      syncedFromTs: 0,
      lastSyncedTs: 1_000,
    });
    // SPEC §10 restarts at lastSyncedTs, which re-returns the fill on that boundary.
    await cache.write('hyperliquid', ADDRESS, [record('a', 1_000), record('b', 2_000)], {
      syncedFromTs: 0,
      lastSyncedTs: 2_000,
    });

    const read = await cache.read('hyperliquid', ADDRESS, { from: 0, to: 10_000 });
    expect(read.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns fills in timestamp order regardless of insert order', async () => {
    const cache = createFillCache(memory().db);
    await cache.write(
      'hyperliquid',
      ADDRESS,
      [record('c', 3_000), record('a', 1_000), record('b', 2_000)],
      { syncedFromTs: 0, lastSyncedTs: 3_000 },
    );

    const read = await cache.read('hyperliquid', ADDRESS, { from: 0, to: 10_000 });
    expect(read.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters to the requested window', async () => {
    const cache = createFillCache(memory().db);
    await cache.write(
      'hyperliquid',
      ADDRESS,
      [record('a', 1_000), record('b', 2_000), record('c', 3_000)],
      { syncedFromTs: 0, lastSyncedTs: 3_000 },
    );

    const read = await cache.read('hyperliquid', ADDRESS, { from: 2_000, to: 2_500 });
    expect(read.map((r) => r.id)).toEqual(['b']);
  });

  it('keeps accounts apart', async () => {
    const cache = createFillCache(memory().db);
    const other = '0x0000000000000000000000000000000000000001';
    await cache.write('hyperliquid', ADDRESS, [record('a', 1_000)], {
      syncedFromTs: 0,
      lastSyncedTs: 1_000,
    });

    expect(await cache.read('hyperliquid', other, { from: 0, to: 10_000 })).toEqual([]);
    expect(await cache.readState('hyperliquid', other)).toBeNull();
  });

  it('widens the synced window rather than narrowing it', async () => {
    const cache = createFillCache(memory().db);
    await cache.write('hyperliquid', ADDRESS, [], { syncedFromTs: 5_000, lastSyncedTs: 9_000 });
    // A later backfill reaches further back; the earlier bound must win.
    await cache.write('hyperliquid', ADDRESS, [], { syncedFromTs: 1_000, lastSyncedTs: 9_000 });

    expect(await cache.readState('hyperliquid', ADDRESS)).toEqual({
      syncedFromTs: 1_000,
      lastSyncedTs: 9_000,
    });
  });

  it('never moves lastSyncedTs backwards', async () => {
    const cache = createFillCache(memory().db);
    await cache.write('hyperliquid', ADDRESS, [], { syncedFromTs: 0, lastSyncedTs: 9_000 });
    // An empty incremental sync must not discard what is already known.
    await cache.write('hyperliquid', ADDRESS, [], { syncedFromTs: 0, lastSyncedTs: 4_000 });

    expect((await cache.readState('hyperliquid', ADDRESS))!.lastSyncedTs).toBe(9_000);
  });
});
