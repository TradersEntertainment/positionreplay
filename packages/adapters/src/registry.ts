/**
 * Venue lookup.
 *
 * One place that knows which adapters exist, so callers route by `VenueId` instead of
 * importing a specific venue — which is how `apps/web` ended up Hyperliquid-shaped
 * before this milestone.
 */

import type { VenueId } from '@trade-replay/core';
import type { Adapter } from './types.js';
import { hyperliquidAdapter } from './hyperliquid/index.js';
import { polymarketPerpsAdapter } from './polymarket-perps/index.js';
import { csvAdapter } from './csv/index.js';

/** Every venue with a working adapter. */
export const ADAPTERS: Partial<Record<VenueId, Adapter>> = {
  hyperliquid: hyperliquidAdapter,
  'polymarket-perps': polymarketPerpsAdapter,
  csv: csvAdapter,
};

export const SUPPORTED_VENUES = Object.keys(ADAPTERS) as VenueId[];

export class UnsupportedVenueError extends Error {
  constructor(readonly venue: string) {
    super(`No adapter for venue "${venue}". Available: ${SUPPORTED_VENUES.join(', ')}.`);
    this.name = 'UnsupportedVenueError';
  }
}

export function adapterFor(venue: string): Adapter {
  const adapter = ADAPTERS[venue as VenueId];
  if (!adapter) throw new UnsupportedVenueError(venue);
  return adapter;
}

export function isSupportedVenue(venue: string): venue is VenueId {
  return venue in ADAPTERS;
}

/** How each venue is described where a user has to choose one. */
export const VENUE_LABELS: Record<string, string> = {
  hyperliquid: 'Hyperliquid',
  'polymarket-perps': 'Polymarket Perps',
  csv: 'CSV upload',
};

/**
 * A limitation the user must see before reading any numbers, or null.
 *
 * SPEC §4.4.1 option A: "Label it in the UI." This is that label, kept next to the
 * adapter list so a new venue cannot quietly ship without one.
 */
export const VENUE_LIMITATIONS: Record<string, string | null> = {
  hyperliquid: null,
  'polymarket-perps':
    'Only positions that are open right now can be replayed. Polymarket Perps serves ' +
    'just the current open cycle publicly, so a position that has already closed is ' +
    'unreachable and cannot be replayed at all.',
  csv:
    'Prices come from Binance public klines, which are spot prices for a mapped ' +
    'symbol — not the venue you actually traded on. Funding is unavailable, and fees ' +
    'are only as complete as the file. Upload your own OHLCV file for a symbol ' +
    'Binance does not list.',
};
