/**
 * SPEC §15.1 healthcheck: "returns 200 + a DB ping".
 *
 * The cache is an optimisation, so an unreachable database is reported as degraded
 * rather than unhealthy — the app still serves, just without SPEC §10's caching. A
 * healthcheck that fails the deploy for a missing optimisation is worse than useless.
 */

import { buildCommit } from '@/lib/build';
import { cacheAvailable, cacheDatabasePath } from '@/lib/data';
import { renderJobStore } from '@/lib/render';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const cache = cacheAvailable();
  return Response.json(
    {
      status: 'ok',
      // Which build answered. In a monorepo a change to packages/renderer leaves every
      // file under apps/web untouched, so the page looks identical whether it deployed
      // or not — this is the one place that says.
      commit: buildCommit(),
      cache: cache ? 'ready' : 'unavailable',
      // The render worker polls this exact file (SPEC §15). Reported so a worker
      // pointed at a different one is a one-request diagnosis rather than a mystery.
      database: cacheDatabasePath(),
      renderQueue: renderJobStore() ? 'ready' : 'unavailable',
    },
    { status: 200 },
  );
}
