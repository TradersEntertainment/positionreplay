/**
 * SPEC §8: adapter proxy for a single replay.
 *
 * The player calls this when the interval override changes — the only case where the
 * client needs data the server component did not already hand it.
 */

import { ReplayNotFoundError, loadReplay } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const replayId = params.get('replayId');
  if (!replayId) {
    return Response.json({ error: 'Missing ?replayId' }, { status: 400 });
  }

  try {
    return Response.json(await loadReplay(replayId, params.get('interval') ?? undefined));
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
