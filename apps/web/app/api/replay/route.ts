/**
 * SPEC §8: adapter proxy for a single replay.
 *
 * The player calls this when the interval override changes — the only case where the
 * client needs data the server component did not already hand it.
 */

import { ReplayNotFoundError, loadManualReplay, loadReplay } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const interval = params.get('interval') ?? undefined;
  // A constructed position has no account to look fills up from, so it is addressed by
  // its own spec rather than by a replay id.
  const manual = params.get('manual');
  const replayId = params.get('replayId');
  if (!manual && !replayId) {
    return Response.json({ error: 'Missing ?replayId or ?manual' }, { status: 400 });
  }

  try {
    return Response.json(
      manual ? await loadManualReplay(manual, interval) : await loadReplay(replayId!, interval),
    );
  } catch (error) {
    if (error instanceof ReplayNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 },
    );
  }
}
