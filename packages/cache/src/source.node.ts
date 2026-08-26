/**
 * Wires SPEC §10's cache into the shared data source.
 *
 * This lives here, not in `packages/adapters`, because the dependency runs
 * cache -> adapters. Inverting it would make the graph circular and would drag a
 * native SQLite binding into every bundle that touches an adapter.
 */

import { createSource, findWorkspaceRoot } from '@trade-replay/adapters/source';
import type { CreateSourceOptions, DataSource } from '@trade-replay/adapters/source';
import { createCandleCache } from './candles.js';
import { createFillCache } from './fills.js';
import { openCache } from './db.js';

/**
 * Where a source's cache lives. SPEC §10 and §15.
 *
 * Fixture runs get their own file. M1 and M2 established that synthetic numbers are
 * stamped everywhere they surface; letting them share a database with live data would
 * quietly undo that, since the two are indistinguishable once they are rows.
 */
export function cacheUrlFor(fixture?: string, venue = 'hyperliquid'): string {
  if (fixture === undefined) return process.env['DATABASE_URL'] ?? 'file:.data/cache.db';
  const slug = `${venue}-${fixture}`.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `file:.data/cache-fixture-${slug || 'fixture'}.db`;
}

export interface CachedSourceOptions extends Omit<CreateSourceOptions, 'cache'> {
  /** Set false to bypass the cache — one-shot scripts, or a deliberate cold read. */
  cache?: boolean;
  /** Overrides DATABASE_URL / the fixture-derived default. */
  databaseUrl?: string;
}

/**
 * A data source with SPEC §10's cache attached.
 *
 * A cache is an optimisation: if the database cannot be opened — a read-only volume, a
 * native binding that would not build — the source still works, uncached, rather than
 * taking the app down with it.
 */
export function createCachedSource(fixture?: string, options: CachedSourceOptions = {}): DataSource {
  if (options.cache === false) return createSource(fixture);

  try {
    const handle = openCache({
      url: options.databaseUrl ?? cacheUrlFor(fixture, options.venue),
      cwd: findWorkspaceRoot(),
    });
    return createSource(fixture, {
      ...(options.venue ? { venue: options.venue } : {}),
      cache: {
        candleCache: createCandleCache(handle.db),
        fillCache: createFillCache(handle.db),
        close: () => handle.close(),
      },
    });
  } catch {
    return createSource(fixture);
  }
}
