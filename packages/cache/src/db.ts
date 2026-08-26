/**
 * SQLite connection. SPEC.md §2 and §15.
 *
 * SPEC §15: the database lives on a Railway persistent volume, and `web` runs at
 * replica count 1 while SQLite is the store — two replicas mean two files diverging
 * silently. That constraint is a deployment setting, but it is the reason this module
 * opens one connection per process and shares it.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type CacheDb = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenOptions {
  /** `file:/data/cache.db`, a bare path, or `:memory:`. */
  url?: string;
  /** Where a relative path is resolved from. */
  cwd?: string;
}

/** SPEC §15: `DATABASE_URL=file:/data/cache.db`. */
export function resolveDatabasePath(url: string, cwd: string = process.cwd()): string {
  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (raw === ':memory:') return raw;
  return isAbsolute(raw) ? raw : join(cwd, raw);
}

/**
 * Absolute path to better-sqlite3's compiled addon.
 *
 * Its `bindings` lookup searches relative to the *calling* module's directory. Inside
 * a bundler's server output that directory is the bundle, not the package, so the
 * addon is never found and the cache silently disables itself. Passing the path
 * explicitly sidesteps the search entirely.
 */
function resolveNativeBinding(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('better-sqlite3');
    const candidate = join(dirname(entry), '..', 'build', 'Release', 'better_sqlite3.node');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export interface CacheHandle {
  db: CacheDb;
  /** Closes the underlying file handle. */
  close(): void;
  path: string;
}

/**
 * Open a database and bring its schema up to date.
 *
 * The schema is applied with `CREATE TABLE IF NOT EXISTS` rather than a migration
 * runner because it is a pure cache: there is no user data to preserve, and a cache
 * that refuses to open because a migration is pending is worse than one that rebuilds.
 * Drizzle still owns every query, which is what SPEC §15.3 requires for the Postgres
 * move to stay a dialect swap.
 */
export function openCache(options: OpenOptions = {}): CacheHandle {
  const url = options.url ?? process.env['DATABASE_URL'] ?? 'file:.data/cache.db';
  const path = resolveDatabasePath(url, options.cwd);

  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const nativeBinding = resolveNativeBinding();
  const sqlite = new Database(path, nativeBinding ? { nativeBinding } : {});
  // WAL survives a crash mid-write and lets a reader run alongside the writer.
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  applySchema(db);

  return {
    db,
    path,
    close: () => sqlite.close(),
  };
}

function applySchema(db: CacheDb): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS fills (
      venue TEXT NOT NULL,
      address TEXT NOT NULL,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (venue, address, id)
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS fills_account_ts_idx ON fills (venue, address, ts)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS fill_syncs (
      venue TEXT NOT NULL,
      address TEXT NOT NULL,
      synced_from_ts INTEGER NOT NULL,
      last_synced_ts INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (venue, address)
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS candles (
      venue TEXT NOT NULL,
      instrument TEXT NOT NULL,
      interval TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      o REAL NOT NULL,
      h REAL NOT NULL,
      l REAL NOT NULL,
      c REAL NOT NULL,
      v REAL NOT NULL,
      PRIMARY KEY (venue, instrument, interval, bucket_start)
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS candle_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue TEXT NOT NULL,
      instrument TEXT NOT NULL,
      interval TEXT NOT NULL,
      from_ts INTEGER NOT NULL,
      to_ts INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS coverage_key_idx
      ON candle_coverage (venue, instrument, interval, from_ts)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS csv_documents (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      text TEXT NOT NULL,
      mapping TEXT NOT NULL,
      symbols TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}
