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
 * SPEC §4.4.1: "Label it in the UI." This is that label, kept next to the
 * adapter list so a new venue cannot quietly ship without one.
 *
 * The title travels with the detail rather than being written at each call site: the
 * banner used to hard-code "Open positions only", which is true of Perps and false of
 * every other venue that will ever have a limitation.
 */
export interface VenueLimitation {
  /** A few words naming the limitation, for the bold lead-in. */
  title: string;
  detail: string;
}

export const VENUE_LIMITATIONS: Record<string, VenueLimitation | null> = {
  hyperliquid: null,
  'polymarket-perps': {
    title: 'Funding is not included',
    detail:
      "Polymarket Perps serves funding rates publicly but not this account's own funding " +
      'charges, so the HUD shows funding as unavailable rather than as zero. Note also ' +
      'that Perps uses a different address from the one a Polymarket profile page shows: ' +
      'a profile URL carries the proxy wallet, which this API rejects outright.',
  },
  csv: {
    title: 'Prices are not from your venue',
    detail:
      'Candles come from Binance public klines, which are spot prices for a mapped ' +
      'symbol — not the venue you actually traded on. Funding is unavailable, and fees ' +
      'are only as complete as the file. Upload your own OHLCV file for a symbol ' +
      'Binance does not list.',
  },
};

/** The one-line form, for a CLI or a canvas notice where there is no bold lead-in. */
export function limitationText(venue: string): string | null {
  const limitation = VENUE_LIMITATIONS[venue];
  return limitation ? `${limitation.title} — ${limitation.detail}` : null;
}
