/**
 * Candles for one market, for the position builder's estimation.
 *
 * The builder fetches this once when a market is picked and then resolves every blank
 * date and price locally, so editing a row costs nothing. A per-keystroke round trip
 * would be both slower and a much heavier load on the venue.
 *
 * Read-only and unauthenticated like every other route here (SPEC §15), and it goes
 * through the same adapter and SPEC §10 cache as a replay does — so the prices someone
 * builds against are the same ones the replay will draw.
 */

import { loadCandles } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const venue = params.get('venue') ?? '';
  const instrument = params.get('instrument') ?? '';

  if (!venue || !instrument) {
    return Response.json({ error: 'Missing ?venue and ?instrument' }, { status: 400 });
  }

  try {
    return Response.json(await loadCandles(venue, instrument));
  } catch (error) {
    // A venue that cannot be reached is not this app being broken, and the message says
    // which — the builder renders it verbatim rather than showing an empty picker.
    return Response.json(
      { error: error instanceof Error ? error.message : 'Could not reach the venue.' },
      { status: 502 },
    );
  }
}
