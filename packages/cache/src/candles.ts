/**
 * Candle cache. SPEC.md §10.
 *
 * "candles(venue, instrument, interval, bucketStart) -> immutable once the bar closes.
 * Cache forever. Only the most recent (still-open) bar is volatile."
 */

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  CachedCandle,
  CandleCache,
  CandleCacheContext,
  CandleKey,
} from '@trade-replay/adapters';
import type { TimeRange } from '@trade-replay/core';
import type { CacheDb } from './db.js';
import { candleCoverage, candles } from './schema.js';

export interface CandleCacheHandle extends CandleCache {
  /** Exposed so a test can assert coverage rows are merged, not accumulated. */
  coverageRowCount(key: CandleKey): Promise<number>;
}

/**
 * Start of the bucket still being filled at `now`.
 *
 * Everything from here on is volatile: the bar has not closed, so its high, low, close
 * and volume can all still change.
 */
function openBucketStart(ctx: CandleCacheContext): number {
  return Math.floor(ctx.now / ctx.intervalMs) * ctx.intervalMs;
}

/** Subtract a sorted, non-overlapping set of covered spans from `range`. */
function subtractCoverage(range: TimeRange, covered: readonly TimeRange[]): TimeRange[] {
  const gaps: TimeRange[] = [];
  let cursor = range.from;

  for (const span of covered) {
    if (span.to < cursor) continue;
    if (span.from > range.to) break;
    if (span.from > cursor) gaps.push({ from: cursor, to: Math.min(range.to, span.from - 1) });
    cursor = Math.max(cursor, span.to + 1);
    if (cursor > range.to) break;
  }

  if (cursor <= range.to) gaps.push({ from: cursor, to: range.to });
  return gaps;
}

export function createCandleCache(db: CacheDb): CandleCacheHandle {
  const keyFilter = (key: CandleKey) =>
    and(
      eq(candleCoverage.venue, key.venue),
      eq(candleCoverage.instrument, key.instrument),
      eq(candleCoverage.interval, key.interval),
    );

  const readCoverage = (key: CandleKey): TimeRange[] =>
    db
      .select({ from: candleCoverage.fromTs, to: candleCoverage.toTs })
      .from(candleCoverage)
      .where(keyFilter(key))
      .orderBy(asc(candleCoverage.fromTs))
      .all();

  return {
    async read(key, range, ctx) {
      // The bar currently forming must never be served: it is not final yet.
      const cutoff = openBucketStart(ctx) - 1;
      const to = Math.min(range.to, cutoff);
      if (to < range.from) return [];

      return db
        .select({
          t: candles.bucketStart,
          o: candles.o,
          h: candles.h,
          l: candles.l,
          c: candles.c,
          v: candles.v,
        })
        .from(candles)
        .where(
          and(
            eq(candles.venue, key.venue),
            eq(candles.instrument, key.instrument),
            eq(candles.interval, key.interval),
            gte(candles.bucketStart, range.from),
            lte(candles.bucketStart, to),
          ),
        )
        .orderBy(asc(candles.bucketStart))
        .all();
    },

    async missing(key, range, ctx) {
      const openBucket = openBucketStart(ctx);
      const closedTo = Math.min(range.to, openBucket - 1);

      // Anything at or past the open bucket is volatile and always refetched.
      const volatileTail: TimeRange[] =
        range.to >= openBucket ? [{ from: Math.max(range.from, openBucket), to: range.to }] : [];

      if (closedTo < range.from) return volatileTail;

      const gaps = subtractCoverage({ from: range.from, to: closedTo }, readCoverage(key));
      return [...gaps, ...volatileTail];
    },

    async write(key, bars, range, ctx) {
      const openBucket = openBucketStart(ctx);
      // Store only closed bars, and only claim coverage up to the last closed bucket —
      // claiming the open one would freeze a half-formed bar into the cache forever.
      const closed = bars.filter((bar) => bar.t < openBucket);
      const coveredTo = Math.min(range.to, openBucket - 1);

      db.transaction((tx) => {
        if (closed.length > 0) {
          tx.insert(candles)
            .values(
              closed.map((bar: CachedCandle) => ({
                venue: key.venue,
                instrument: key.instrument,
                interval: key.interval,
                bucketStart: bar.t,
                o: bar.o,
                h: bar.h,
                l: bar.l,
                c: bar.c,
                v: bar.v,
              })),
            )
            .onConflictDoUpdate({
              target: [candles.venue, candles.instrument, candles.interval, candles.bucketStart],
              set: {
                o: sql`excluded.o`,
                h: sql`excluded.h`,
                l: sql`excluded.l`,
                c: sql`excluded.c`,
                v: sql`excluded.v`,
              },
            })
            .run();
        }

        if (coveredTo < range.from) return;

        // Merge the new span with anything it touches, so repeated small fetches do not
        // leave thousands of adjacent rows to walk on every read.
        const existing = tx
          .select({ from: candleCoverage.fromTs, to: candleCoverage.toTs })
          .from(candleCoverage)
          .where(keyFilter(key))
          .orderBy(asc(candleCoverage.fromTs))
          .all();

        let from = range.from;
        let to = coveredTo;
        const keep: TimeRange[] = [];
        for (const span of existing) {
          // Adjacent counts as overlapping: [0,10] and [11,20] are one span.
          if (span.to + 1 < from || span.from - 1 > to) keep.push(span);
          else {
            from = Math.min(from, span.from);
            to = Math.max(to, span.to);
          }
        }

        tx.delete(candleCoverage).where(keyFilter(key)).run();
        tx.insert(candleCoverage)
          .values(
            [...keep, { from, to }]
              .sort((a, b) => a.from - b.from)
              .map((span) => ({
                venue: key.venue,
                instrument: key.instrument,
                interval: key.interval,
                fromTs: span.from,
                toTs: span.to,
              })),
          )
          .run();
      });
    },

    async coverageRowCount(key) {
      return readCoverage(key).length;
    },
  };
}
