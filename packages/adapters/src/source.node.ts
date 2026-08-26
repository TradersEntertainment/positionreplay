/**
 * Resolves where an adapter's data comes from: the live venue, or a recorded fixture.
 *
 * Node-only (it reads the filesystem), and shared by the CLI and the web app's route
 * handlers — both need exactly this decision, and two copies would drift.
 *
 * The fixture path replays through the real adapter code, so the reconstruction being
 * exercised is the one that runs in production. Only the socket is swapped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { VenueId } from '@trade-replay/core';
import { createUnlimitedLimiter } from './limiter.js';
import type {
  AdapterContext,
  AdapterWarning,
  CandleCache,
  FetchLike,
  FillCache,
} from './types.js';
import type { CsvDocument, CsvDocumentStore } from './csv/document.js';
import { createFixtureFetch } from './hyperliquid/fixtureFetch.js';
import { loadFixtureStore } from './hyperliquid/fixtureStore.node.js';
import { createPerpsFixtureFetch } from './polymarket-perps/fixtureFetch.js';
import { loadPerpsFixtureStore } from './polymarket-perps/fixtureStore.node.js';
import { createBinanceFixtureFetch } from './csv/fixtureFetch.js';
import { loadCsvFixtureStore } from './csv/fixtureStore.node.js';

/**
 * Walk up for the workspace root.
 *
 * A relative climb from `import.meta.url` breaks the moment this file is imported from
 * a package at a different depth — which is exactly what happened when the CLI's copy
 * was shared with the web app.
 */
export function findWorkspaceRoot(startFrom: string = process.cwd()): string {
  let current = resolve(startFrom);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Not inside the monorepo (a standalone build, say): fall back to the start.
  return resolve(startFrom);
}

export function fixturesRoot(venue: VenueId = 'hyperliquid'): string {
  const override = process.env['TRADE_REPLAY_FIXTURES_DIR'];
  if (override) return join(override, venue);
  return join(findWorkspaceRoot(), 'fixtures', venue);
}

export function resolveFixtureDir(nameOrPath: string, venue: VenueId = 'hyperliquid'): string {
  if (isAbsolute(nameOrPath) || nameOrPath.includes(sep)) return nameOrPath;
  return join(fixturesRoot(venue), nameOrPath);
}

/**
 * Fixture replay differs per venue: Hyperliquid routes on a POST body, Perps on a GET
 * URL. Each adapter owns its own replay, so this only has to pick one.
 */
function fixtureFetchFor(
  venue: VenueId,
  dir: string,
): { fetch: FetchLike; warning?: string; csvStore?: CsvDocumentStore; defaultAccount?: string } {
  if (venue === 'polymarket-perps') {
    const store = loadPerpsFixtureStore(dir);
    return {
      fetch: createPerpsFixtureFetch(store),
      ...(store.meta.warning ? { warning: store.meta.warning } : {}),
    };
  }

  if (venue === 'csv') {
    // A CSV fixture carries its own uploaded document as well as the Binance
    // responses, so a fixture run needs no database and no prior upload step.
    const store = loadCsvFixtureStore(dir);
    return {
      fetch: createBinanceFixtureFetch(store),
      csvStore: readOnlyStore(store.document),
      defaultAccount: store.document.id,
      ...(store.meta.warning ? { warning: store.meta.warning } : {}),
    };
  }

  const store = loadFixtureStore(dir);
  return {
    fetch: createFixtureFetch(store),
    ...(store.meta.warning ? { warning: store.meta.warning } : {}),
  };
}

/** Serves exactly the fixture's document; `put` is a no-op, since a fixture is fixed. */
function readOnlyStore(document: CsvDocument): CsvDocumentStore {
  return {
    get: async (id) => (id === document.id ? document : null),
    put: async () => undefined,
  };
}

export interface DataSource {
  ctx: AdapterContext;
  /** Collected as the adapter runs; surface these, never swallow them. */
  warnings: AdapterWarning[];
  label: string;
  /** Set when the data is not real, so output can never be mistaken for fact. */
  provenanceWarning?: string;
  /**
   * The account this source is about, when it knows.
   *
   * Only CSV fixtures set it, and structurally so: a CSV's account identifier is a
   * content hash of the uploaded file, which nobody can type and which changes
   * whenever the fixture is regenerated. A wallet fixture has no such problem — the
   * address is typed by the caller — so those deliberately leave this unset rather
   * than quietly overriding what was asked for.
   */
  defaultAccount?: string;
  /** Release the cache connection, if one was opened. */
  close(): void;
}

/**
 * Where this source's cache lives. SPEC §10 and §15.
 *
 * Fixture runs get their own file. M1 and M2 established that synthetic numbers are
 * stamped everywhere they surface; letting them share a database with live data would
 * quietly undo that, and the two are indistinguishable once they are rows.
 */
export function cacheUrlFor(fixture?: string): string {
  const configured = process.env['DATABASE_URL'];
  if (fixture === undefined) return configured ?? 'file:.data/cache.db';

  const slug = fixture.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'fixture';
  return `file:.data/cache-fixture-${slug}.db`;
}

export interface SourceCache {
  candleCache: CandleCache;
  fillCache: FillCache;
  close(): void;
}

export interface CreateSourceOptions {
  /** Which venue this source serves. Defaults to Hyperliquid. */
  venue?: VenueId;
  /**
   * SPEC §10's cache, injected.
   *
   * It is not imported here: `packages/cache` depends on this package, so importing it
   * back would make the graph circular and would drag a native SQLite binding into
   * anything that touches an adapter. `@trade-replay/cache` exports `createCachedSource`,
   * which wires the two together from the correct side.
   */
  cache?: SourceCache | undefined;
  /**
   * SPEC §4.6: where uploaded CSVs are read from.
   *
   * Live runs pass the SQLite-backed store from `@trade-replay/cache`; a CSV fixture
   * supplies its own and this is ignored.
   */
  csvStore?: CsvDocumentStore | undefined;
}

/**
 * @param fixture Fixture name or path. Undefined means the live venue.
 */
export function createSource(fixture?: string, options: CreateSourceOptions = {}): DataSource {
  const venue = options.venue ?? 'hyperliquid';
  const warnings: AdapterWarning[] = [];
  const onWarning = (w: AdapterWarning): void => {
    warnings.push(w);
  };

  const cache = options.cache;
  const cacheCtx: AdapterContext = {
    ...(cache ? { candleCache: cache.candleCache, fillCache: cache.fillCache } : {}),
    ...(options.csvStore ? { csvStore: options.csvStore } : {}),
  };

  if (fixture === undefined) {
    return {
      ctx: { onWarning, ...cacheCtx },
      warnings,
      label: `live ${venue} API`,
      close: () => cache?.close(),
    };
  }

  const dir = resolveFixtureDir(fixture, venue);
  if (!existsSync(dir)) {
    const root = fixturesRoot(venue);
    const available = existsSync(root) ? readdirSync(root).join(', ') : 'none';
    throw new Error(
      `No ${venue} fixture at ${dir}.\n` +
        `  Available: ${available}\n` +
        `  Generate a synthetic one:  pnpm tsx scripts/make-synthetic-fixture.ts (hyperliquid)\n` +
        `                             pnpm tsx scripts/make-perps-fixture.ts (polymarket-perps)\n` +
        `                             pnpm tsx scripts/make-csv-fixture.ts (csv)`,
    );
  }

  const replay = fixtureFetchFor(venue, dir);

  return {
    ctx: {
      fetch: replay.fetch,
      limiter: createUnlimitedLimiter(),
      sleep: async () => undefined,
      onWarning,
      ...cacheCtx,
      ...(replay.csvStore ? { csvStore: replay.csvStore } : {}),
    },
    warnings,
    label: `fixture ${dir.replace(findWorkspaceRoot(), '').replace(/^[/\\]/, '')}`,
    ...(replay.warning ? { provenanceWarning: replay.warning } : {}),
    ...(replay.defaultAccount ? { defaultAccount: replay.defaultAccount } : {}),
    close: () => cache?.close(),
  };
}

/**
 * The fixture the environment selects, if any.
 *
 * Lets the web app run entirely offline (`TRADE_REPLAY_FIXTURE=synthetic`) without a
 * separate code path from the live deployment.
 */
export function fixtureFromEnv(): string | undefined {
  const value = process.env['TRADE_REPLAY_FIXTURE'];
  return value === undefined || value === '' ? undefined : value;
}
