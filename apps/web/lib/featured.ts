/**
 * Two accounts to start from, so the front door is not an empty box.
 *
 * Every other way into this app begins with something you must already have: an address,
 * a market and a memory of the trade, or a CSV. A first-time visitor has none of them.
 * This is a hand-picked list — ours, editorial, not a ranking read from a venue — and
 * that distinction decides everything about how it is allowed to be presented.
 *
 * **The note is a reason, not a measurement.** "Picked for return on capital", never
 * "highest ROI". A superlative would be a claim about a leaderboard we are not reading,
 * and it would rot: an account that led on return in August can be 80% down by October
 * while a hardcoded label still says otherwise.
 *
 * **The figures are ours and recomputed on every load.** `summarise` folds the same
 * per-position reconstruction the address page shows, so a card can go out of date only
 * by being wrong about the trade, never by being a stale number someone typed here. It
 * is not the venue's account PnL and will not match it.
 *
 * The rules live in this file rather than in the component because `vitest.config.ts`
 * collects `apps/web/lib/**` only, and each of them is one that would put a wrong number
 * on the landing page if it were wrong.
 */

import type { EpisodesResult } from './data';
import { formatSignedUsd } from './format';

export interface FeaturedTrader {
  venue: string;
  address: string;
  /** Why this one is here. Editorial, and phrased so it cannot read as a measurement. */
  note: string;
}

/**
 * Lowercased on purpose: `parseInput` lowercases, and the fill cache and replay ids are
 * keyed on that form. A checksummed address here would miss the cache on every load and
 * produce a URL that disagrees with the one the address page normalises to.
 */
export const FEATURED_TRADERS: readonly FeaturedTrader[] = [
  {
    venue: 'hyperliquid',
    address: '0x58e1b0e63c905d5982324fcd9108582623b8132e',
    note: 'picked for return on capital',
  },
  {
    venue: 'hyperliquid',
    address: '0x393d0b87ed38fc779fd9611144ae649ba6082109',
    note: 'picked for size of profit',
  },
];

export interface FeaturedSummary {
  venue: string;
  address: string;
  note: string;
  /** Positions this app reconstructed. Ours, not a count the venue published. */
  positions: number;
  /** Net across those positions, in USD. Ours too. */
  net: number;
  /**
   * The venue could not serve this account's whole history (SPEC §4.3: only the most
   * recent ~10,000 fills), so `net` is folded from an incomplete record.
   *
   * Featured accounts are busy ones, which makes this the likely case rather than the
   * rare one — and SPEC §11 case 9 requires saying so wherever the number is read.
   */
  truncated: boolean;
}

/**
 * A card's worth of numbers, or **null** when there is nothing to show.
 *
 * Null rather than a row of zeroes. An account we could not reconstruct is not an
 * account that broke even, and `$0.00` standing in for "we could not ask" is the exact
 * failure SPEC §4.5 warns about — "do not ship a resolver that silently returns 'no
 * positions' for a valid trader". The caller drops the card instead, so a featured
 * address that has gone quiet is absent rather than a dead link.
 */
export function summarise(
  trader: FeaturedTrader,
  result: Pick<EpisodesResult, 'episodes' | 'warnings'>,
): FeaturedSummary | null {
  if (result.episodes.length === 0) return null;

  return {
    venue: trader.venue,
    address: trader.address,
    note: trader.note,
    positions: result.episodes.length,
    // The same fold the address page does, so the card and the page it links to cannot
    // disagree about the same account.
    net: result.episodes.reduce((sum, episode) => sum + episode.net, 0),
    truncated: result.warnings.some((warning) => warning.kind === 'fill_history_truncated'),
  };
}

/** "3 positions · +$4,320.22" — the count first, because it says what the net is over. */
export function formatFeaturedStat(summary: FeaturedSummary): string {
  const positions = `${summary.positions} position${summary.positions === 1 ? '' : 's'}`;
  return `${positions} · ${formatSignedUsd(summary.net)}`;
}
