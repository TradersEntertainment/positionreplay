/**
 * A venue's public leaderboard, for the landing page's panel.
 *
 * Read-only and unauthenticated, like everything else here (SPEC §15). It is a route
 * rather than server-rendered props because the landing page must paint instantly: a
 * cold leaderboard fetch is megabytes from a third-party host, and putting it in front
 * of the first paint would mean a venue having a bad afternoon turns our front door
 * into a spinner.
 */

import { LEADERBOARD_MAX, loadLeaderboard } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const venue = params.get('venue') ?? '';
  if (!venue) return Response.json({ error: 'Missing ?venue' }, { status: 400 });

  // Clamped here rather than trusted: an unbounded limit turns one request into a
  // several-megabyte response, and the parse of a hostile value must not become NaN.
  const asked = Number(params.get('limit') ?? LEADERBOARD_MAX);
  const limit = Number.isFinite(asked) ? Math.max(1, Math.min(asked, LEADERBOARD_MAX)) : LEADERBOARD_MAX;

  try {
    return Response.json(await loadLeaderboard(venue, limit));
  } catch (error) {
    // A leaderboard is an editorial endpoint, not a documented API — it can be
    // rate-limited or withdrawn without notice. The message says which it is, and the
    // panel renders it verbatim rather than showing an empty table that would read as
    // "nobody is trading".
    return Response.json(
      { error: error instanceof Error ? error.message : 'Could not reach the venue.' },
      { status: 502 },
    );
  }
}
