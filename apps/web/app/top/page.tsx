/**
 * `/top` with no venue — send them to the first one that has a leaderboard.
 *
 * Exists so the header link can stay venue-agnostic: it says "top traders", not
 * "Hyperliquid's top traders", and a venue added later becomes the destination without
 * the header being edited.
 */

import { notFound, redirect } from 'next/navigation';
import { leaderboardVenues } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function TopIndex() {
  const first = leaderboardVenues()[0];
  if (!first) notFound();
  redirect(`/top/${first.id}`);
}
