/**
 * Fill cache. SPEC.md §10.
 *
 * "fills(venue, address) -> cache with a `lastSyncedTs`; on refetch only request
 * startTime = lastSyncedTs."
 *
 * Payloads are stored verbatim. SPEC §4.3 caps Hyperliquid history at roughly the most
 * recent 10,000 fills, so an aged-out fill cannot be refetched at any price — and the
 * venue contract has not been checked live yet (docs/VERIFYING-M1.md), so keeping the
 * original payload means a corrected schema re-derives from cache, not from the network.
 */

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FillCache, FillSyncState, RawFillRecord } from '@trade-replay/adapters';
import type { VenueId } from '@trade-replay/core';
import type { CacheDb } from './db.js';
import { fillSyncs, fills } from './schema.js';

export function createFillCache(db: CacheDb): FillCache {
  const accountFilter = (venue: VenueId, address: string) =>
    and(eq(fills.venue, venue), eq(fills.address, address));

  return {
    async readState(venue, address) {
      const row = db
        .select({ syncedFromTs: fillSyncs.syncedFromTs, lastSyncedTs: fillSyncs.lastSyncedTs })
        .from(fillSyncs)
        .where(and(eq(fillSyncs.venue, venue), eq(fillSyncs.address, address)))
        .get();
      return row ?? null;
    },

    async read(venue, address, range) {
      return db
        .select({ id: fills.id, ts: fills.ts, payload: fills.payload })
        .from(fills)
        .where(and(accountFilter(venue, address), gte(fills.ts, range.from), lte(fills.ts, range.to)))
        .orderBy(asc(fills.ts), asc(fills.id))
        .all();
    },

    async write(venue, address, records, state) {
      db.transaction((tx) => {
        if (records.length > 0) {
          tx.insert(fills)
            .values(
              records.map((record: RawFillRecord) => ({
                venue,
                address,
                id: record.id,
                ts: record.ts,
                payload: record.payload,
              })),
            )
            // SPEC §10 restarts at lastSyncedTs, so the boundary fill arrives again.
            .onConflictDoUpdate({
              target: [fills.venue, fills.address, fills.id],
              set: { ts: sql`excluded.ts`, payload: sql`excluded.payload` },
            })
            .run();
        }

        const existing = tx
          .select({ syncedFromTs: fillSyncs.syncedFromTs, lastSyncedTs: fillSyncs.lastSyncedTs })
          .from(fillSyncs)
          .where(and(eq(fillSyncs.venue, venue), eq(fillSyncs.address, address)))
          .get();

        // The window only ever widens. An incremental sync that returned nothing must
        // not roll `lastSyncedTs` back and cause the tail to be refetched; a backfill
        // that reached further back must not be forgotten.
        const merged: FillSyncState = existing
          ? {
              syncedFromTs: Math.min(existing.syncedFromTs, state.syncedFromTs),
              lastSyncedTs: Math.max(existing.lastSyncedTs, state.lastSyncedTs),
            }
          : state;

        tx.insert(fillSyncs)
          .values({ venue, address, ...merged, updatedAt: Date.now() })
          .onConflictDoUpdate({
            target: [fillSyncs.venue, fillSyncs.address],
            set: {
              syncedFromTs: merged.syncedFromTs,
              lastSyncedTs: merged.lastSyncedTs,
              updatedAt: Date.now(),
            },
          })
          .run();
      });
    },
  };
}
