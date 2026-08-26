/** SPEC §8: adapter proxy. Keeps rate limiting and Zod validation server-side. */

import { InvalidInputError, isSupportedVenue } from '@trade-replay/adapters';
import { loadEpisodes } from '@/lib/data';

// Venue data changes; never serve a build-time snapshot of it.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const address = params.get('address');
  const venue = params.get('venue') ?? 'hyperliquid';

  if (!address) {
    return Response.json({ error: 'Missing ?address' }, { status: 400 });
  }
  if (!isSupportedVenue(venue)) {
    return Response.json({ error: `Unsupported venue "${venue}"` }, { status: 400 });
  }

  try {
    return Response.json(await loadEpisodes(venue, address));
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 },
    );
  }
}
