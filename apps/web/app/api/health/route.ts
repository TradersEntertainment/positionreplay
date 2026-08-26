/**
 * SPEC §15.1 healthcheck: "returns 200 + a DB ping".
 *
 * The cache is an optimisation, so an unreachable database is reported as degraded
 * rather than unhealthy — the app still serves, just without SPEC §10's caching. A
 * healthcheck that fails the deploy for a missing optimisation is worse than useless.
 */

import { cacheAvailable } from '@/lib/data';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const cache = cacheAvailable();
  return Response.json({ status: 'ok', cache: cache ? 'ready' : 'unavailable' }, { status: 200 });
}
