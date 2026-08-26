/**
 * Cache schema. SPEC.md §10.
 *
 * Drizzle rather than raw SQL on purpose: SPEC §15.3 makes "nothing has reached past
 * Drizzle into raw SQLite SQL" the condition for the Postgres migration being a
 * dialect swap rather than a rewrite. Keep it that way.
 */

import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Venue fills, stored verbatim.
 *
 * SPEC §4.3: Hyperliquid serves roughly the most recent 10,000 fills, so an aged-out
 * fill cannot be refetched at any price. The raw payload is kept rather than a parsed
 * `Fill` so that a schema correction — the venue contract is still unverified, see
 * docs/VERIFYING-M1.md — re-derives from cache rather than from the network.
 */
export const fills = sqliteTable(
  'fills',
  {
    venue: text('venue').notNull(),
    address: text('address').notNull(),
    /** The venue-unique dedupe key, e.g. "hl:12345". */
    id: text('id').notNull(),
    ts: integer('ts').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.venue, table.address, table.id] }),
    index('fills_account_ts_idx').on(table.venue, table.address, table.ts),
  ],
);

/**
 * How much of an account's history the cache actually holds.
 *
 * `lastSyncedTs` alone is not enough: a first sync that started at some later point
 * would leave a hole before it, and a later request for the full history would be
 * served from a cache that silently lacks the beginning.
 */
export const fillSyncs = sqliteTable(
  'fill_syncs',
  {
    venue: text('venue').notNull(),
    address: text('address').notNull(),
    syncedFromTs: integer('synced_from_ts').notNull(),
    lastSyncedTs: integer('last_synced_ts').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.venue, table.address] })],
);

/** SPEC §10: keyed by (venue, instrument, interval, bucketStart); immutable once closed. */
export const candles = sqliteTable(
  'candles',
  {
    venue: text('venue').notNull(),
    instrument: text('instrument').notNull(),
    interval: text('interval').notNull(),
    bucketStart: integer('bucket_start').notNull(),
    o: real('o').notNull(),
    h: real('h').notNull(),
    l: real('l').notNull(),
    c: real('c').notNull(),
    v: real('v').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.venue, table.instrument, table.interval, table.bucketStart],
    }),
  ],
);

/**
 * Which windows have been fetched, regardless of whether they produced bars.
 *
 * Without this, a span the venue has no trades for is indistinguishable from a span
 * never requested, and gets refetched on every load forever.
 */
export const candleCoverage = sqliteTable(
  'candle_coverage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    venue: text('venue').notNull(),
    instrument: text('instrument').notNull(),
    interval: text('interval').notNull(),
    fromTs: integer('from_ts').notNull(),
    toTs: integer('to_ts').notNull(),
  },
  (table) => [
    index('coverage_key_idx').on(table.venue, table.instrument, table.interval, table.fromTs),
  ],
);

/**
 * Uploaded CSVs. SPEC §4.6.
 *
 * The file is kept verbatim alongside the confirmed mapping, for the same reason
 * `fills.payload` is: applying the mapping on read means a fix to the parser corrects
 * every document already uploaded, not only the ones uploaded after it.
 *
 * `id` is a content hash of the file plus its mapping, so re-uploading the same file
 * with the same mapping is idempotent rather than accumulating copies.
 */
export const csvDocuments = sqliteTable('csv_documents', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  text: text('text').notNull(),
  mapping: text('mapping', { mode: 'json' }).notNull(),
  /** Normalized CSV symbol -> price source (Binance symbol, or a user OHLCV file). */
  symbols: text('symbols', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Render jobs. SPEC §9 Phase 2, §15 "Render jobs".
 *
 * `requestKey` is what makes a job idempotent: it is derived from the render request
 * itself, so a double-clicked button finds the existing row instead of starting a
 * second ffmpeg run for the same video.
 */
export const renderJobs = sqliteTable(
  'render_jobs',
  {
    id: text('id').primaryKey(),
    requestKey: text('request_key').notNull(),
    spec: text('spec', { mode: 'json' }).notNull(),
    /** queued | running | done | failed */
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    claimedBy: text('claimed_by'),
    /** Renewed on every progress report; a lapsed value means the worker died. */
    claimedAt: integer('claimed_at'),
    framesDone: integer('frames_done').notNull(),
    frameCount: integer('frame_count').notNull(),
    outputPath: text('output_path'),
    outputBytes: integer('output_bytes'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('render_jobs_request_idx').on(table.requestKey, table.status),
    index('render_jobs_status_idx').on(table.status, table.createdAt),
  ],
);
