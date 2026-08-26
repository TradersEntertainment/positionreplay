/**
 * @trade-replay/cache — SPEC §10's caching layer.
 *
 * Node-only (SQLite). It implements the `CandleCache` / `FillCache` interfaces declared
 * in @trade-replay/adapters; adapters never import this package, so the dependency runs
 * one way and the browser bundle never sees a native module.
 */

export * from './db.js';
export * from './schema.js';
export { createCandleCache, type CandleCacheHandle } from './candles.js';
export { createFillCache } from './fills.js';
export { createCsvDocumentStore } from './csvDocuments.js';
export * from './renderJobs.js';
export { createCachedSource, cacheUrlFor, type CachedSourceOptions } from './source.node.js';
