/**
 * The featured traders, summarised.
 *
 * One request for the whole panel rather than one per card: the response is a handful of
 * numbers, where hitting `/api/episodes` per address would ship every episode's
 * sparkline for a card that shows a count and a total.
 *
 * `allSettled`, not `all` — one address that has gone quiet, or a venue that refuses a
 * single account, must not blank the panel. A trader that fails or reconstructs to
 * nothing is left out of the response entirely, so the page never renders a dead link or
 * a `$0.00` standing in for "we could not ask" (SPEC §4.5).
 */

import { FEATURED_TRADERS, summarise, type FeaturedSummary } from '@/lib/featured';
import { loadEpisodes } from '@/lib/data';
import { isSupportedVenue } from '@trade-replay/adapters';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const settled = await Promise.allSettled(
    FEATURED_TRADERS.map(async (trader) => {
      if (!isSupportedVenue(trader.venue)) return null;
      return summarise(trader, await loadEpisodes(trader.venue, trader.address));
    }),
  );

  const traders: FeaturedSummary[] = [];
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value) traders.push(outcome.value);
      continue;
    }
    // Logged rather than surfaced: the panel is a convenience, and a venue having a bad
    // afternoon should not put an error on the front page. The server log is where
    // someone looking for the cause will be.
    console.warn(
      `[featured] ${FEATURED_TRADERS[index]?.address ?? 'unknown'} could not be summarised:`,
      outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
    );
  }

  return Response.json({ traders });
}
