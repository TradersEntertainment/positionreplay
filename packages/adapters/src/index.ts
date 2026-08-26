/**
 * @trade-replay/adapters — venue connectors.
 *
 * Everything venue-specific lives behind this boundary. `@trade-replay/core` and
 * `@trade-replay/renderer` must never import from here (CLAUDE.md).
 */

export * from './types.js';
export * from './limiter.js';
export * from './withRetry.js';
export * from './cacheHelpers.js';
export { hyperliquidAdapter } from './hyperliquid/index.js';
export { polymarketPerpsAdapter } from './polymarket-perps/index.js';
export { csvAdapter, instrumentKeyFor as csvInstrumentKeyFor, splitInstrumentKey as splitCsvInstrumentKey } from './csv/index.js';
export * from './csv/parse.js';
export * from './csv/mapping.js';
export * from './csv/ohlcv.js';
export * from './csv/document.js';
export { createBinanceFixtureFetch, type BinanceFixtureStore } from './csv/fixtureFetch.js';
export { BINANCE_INTERVALS, UnknownSymbolError, symbolCandidates, createBinanceClient } from './csv/binance.js';
export * from './registry.js';
