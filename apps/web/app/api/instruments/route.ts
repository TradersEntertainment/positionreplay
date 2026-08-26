/**
 * Markets a venue lists, for the position builder's picker.
 *
 * Read-only and unauthenticated, like everything else here (SPEC §15). It exists as a
 * route rather than as server-rendered props because the picker reloads when the venue
 * changes, and re-rendering the whole page for a dropdown is the wrong trade.
 */

import { loadInstrumentList } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const venue = new URL(request.url).searchParams.get('venue') ?? '';

  try {
    return Response.json({ venue, instruments: await loadInstrumentList(venue) });
  } catch (error) {
    // The venue being unreachable is not this app being broken, and the message says
    // which it is — the picker renders it verbatim.
    return Response.json(
      { error: error instanceof Error ? error.message : 'Could not reach the venue.' },
      { status: 502 },
    );
  }
}
