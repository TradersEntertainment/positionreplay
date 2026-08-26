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
export * from './registry.js';
