/**
 * The cache-aware fetch flow. SPEC.md §10.
 *
 * Lives here rather than inside the Hyperliquid adapter so the Perps adapter reuses it
 * in M6 instead of reimplementing gap logic — which is exactly the sort of thing two
 * implementations get subtly different.
 */

import type { TimeRange } from '@trade-replay/core';
import type {
  CachedCandle,
  CandleCache,
  CandleKey,
  FillCache,
  RawFillRecord,
} from './types.js';
import type { VenueId } from '@trade-replay/core';

export interface CandleCacheOptions {
  cache: CandleCache | undefined;
  key: CandleKey;
  range: TimeRange;
  intervalMs: number;
  now: number;
  /** Fetches one contiguous span from the venue, paginating internally. */
  fetchSpan: (span: TimeRange) => Promise<CachedCandle[]>;
}

/**
 * Serve a candle range from cache, fetching only what is missing.
 *
 * The still-forming bar is deliberately not persisted (SPEC §10 calls it volatile), so
 * it is merged back in from the live fetch rather than read from the cache.
 */
export async function withCandleCache(options: CandleCacheOptions): Promise<CachedCandle[]> {
  const { cache, key, range, intervalMs, now, fetchSpan } = options;
  if (!cache) return fetchSpan(range);

  const ctx = { intervalMs, now };
  const missing = await cache.missing(key, range, ctx);

  const fetched: CachedCandle[] = [];
  for (const span of missing) {
    const bars = await fetchSpan(span);
    fetched.push(...bars);
    // Coverage is recorded per span, so an empty span still counts as asked.
    await cache.write(key, bars, span, ctx);
  }

  const openBucket = Math.floor(now / intervalMs) * intervalMs;
  const stored = await cache.read(key, range, ctx);
  const volatile = fetched.filter((bar) => bar.t >= openBucket);

  if (volatile.length === 0) return stored;

  const byBucket = new Map<number, CachedCandle>();
  for (const bar of [...stored, ...volatile]) byBucket.set(bar.t, bar);
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

export interface FillCacheOptions {
  cache: FillCache | undefined;
  venue: VenueId;
  address: string;
  range: TimeRange;
  fetchSpan: (span: TimeRange) => Promise<RawFillRecord[]>;
}

/**
 * Serve an account's fills from cache, syncing only the edges.
 *
 * SPEC §10: "on refetch only request startTime = lastSyncedTs". `lastSyncedTs` advances
 * to the newest fill actually seen, never to the requested end — advancing to "now"
 * would skip any fill the venue had not yet indexed at that instant, and a missed fill
 * silently corrupts the whole reconstruction downstream.
 */
export async function withFillCache(options: FillCacheOptions): Promise<RawFillRecord[]> {
  const { cache, venue, address, range, fetchSpan } = options;
  if (!cache) return fetchSpan(range);

  const state = await cache.readState(venue, address);
  const newest = (records: readonly RawFillRecord[], fallback: number): number =>
    records.reduce((max, record) => Math.max(max, record.ts), fallback);

  if (!state) {
    const records = await fetchSpan(range);
    await cache.write(venue, address, records, {
      syncedFromTs: range.from,
      lastSyncedTs: newest(records, range.from),
    });
  } else {
    // Backfill: this request reaches further back than anything synced so far.
    if (range.from < state.syncedFromTs) {
      const records = await fetchSpan({ from: range.from, to: state.syncedFromTs });
      await cache.write(venue, address, records, {
        syncedFromTs: range.from,
        lastSyncedTs: state.lastSyncedTs,
      });
    }
    // Forward sync: everything since the newest fill we already hold.
    if (range.to > state.lastSyncedTs) {
      const records = await fetchSpan({ from: state.lastSyncedTs, to: range.to });
      await cache.write(venue, address, records, {
        syncedFromTs: Math.min(range.from, state.syncedFromTs),
        lastSyncedTs: newest(records, state.lastSyncedTs),
      });
    }
  }

  return cache.read(venue, address, range);
}
