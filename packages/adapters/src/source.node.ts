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
import { createUnlimitedLimiter } from './limiter.js';
import type { AdapterContext, AdapterWarning, CandleCache, FillCache } from './types.js';
import { createFixtureFetch } from './hyperliquid/fixtureFetch.js';
import { loadFixtureStore } from './hyperliquid/fixtureStore.node.js';

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

export function fixturesRoot(): string {
  const override = process.env['TRADE_REPLAY_FIXTURES_DIR'];
  if (override) return override;
  return join(findWorkspaceRoot(), 'fixtures', 'hyperliquid');
}

export function resolveFixtureDir(nameOrPath: string): string {
  if (isAbsolute(nameOrPath) || nameOrPath.includes(sep)) return nameOrPath;
  return join(fixturesRoot(), nameOrPath);
}

export interface DataSource {
  ctx: AdapterContext;
  /** Collected as the adapter runs; surface these, never swallow them. */
  warnings: AdapterWarning[];
  label: string;
  /** Set when the data is not real, so output can never be mistaken for fact. */
  provenanceWarning?: string;
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
  /**
   * SPEC §10's cache, injected.
   *
   * It is not imported here: `packages/cache` depends on this package, so importing it
   * back would make the graph circular and would drag a native SQLite binding into
   * anything that touches an adapter. `@trade-replay/cache` exports `createCachedSource`,
   * which wires the two together from the correct side.
   */
  cache?: SourceCache | undefined;
}

/**
 * @param fixture Fixture name or path. Undefined means the live venue.
 */
export function createSource(fixture?: string, options: CreateSourceOptions = {}): DataSource {
  const warnings: AdapterWarning[] = [];
  const onWarning = (w: AdapterWarning): void => {
    warnings.push(w);
  };

  const cache = options.cache;
  const cacheCtx: AdapterContext = cache
    ? { candleCache: cache.candleCache, fillCache: cache.fillCache }
    : {};

  if (fixture === undefined) {
    return {
      ctx: { onWarning, ...cacheCtx },
      warnings,
      label: 'live Hyperliquid API',
      close: () => cache?.close(),
    };
  }

  const dir = resolveFixtureDir(fixture);
  if (!existsSync(dir)) {
    const available = existsSync(fixturesRoot()) ? readdirSync(fixturesRoot()).join(', ') : 'none';
    throw new Error(
      `No fixture at ${dir}.\n` +
        `  Available: ${available}\n` +
        `  Generate the synthetic one:  pnpm tsx scripts/make-synthetic-fixture.ts\n` +
        `  Or record a real one:        pnpm capture:hl <address>`,
    );
  }

  const store = loadFixtureStore(dir);

  return {
    ctx: {
      fetch: createFixtureFetch(store),
      limiter: createUnlimitedLimiter(),
      sleep: async () => undefined,
      onWarning,
      ...cacheCtx,
    },
    warnings,
    label: `fixture ${dir.replace(findWorkspaceRoot(), '').replace(/^[/\\]/, '')}`,
    ...(store.meta.warning ? { provenanceWarning: store.meta.warning } : {}),
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
