/**
 * Server-side access to the render queue. SPEC §9 Phase 2, §15.
 *
 * Separate from lib/data.ts because the failure modes differ: a missing cache degrades
 * to uncached reads, while a missing queue means MP4 export is simply unavailable and
 * the UI has to say so rather than spin.
 */

import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { createRenderJobStore, type RenderJobStore } from '@trade-replay/cache';
import { cacheHandle } from './data';

export const RENDER_UNAVAILABLE =
  'MP4 export needs the database, and it could not be opened. The other export formats ' +
  'are rendered in the browser and still work.';

let store: RenderJobStore | null | undefined;

export function renderJobStore(): RenderJobStore | undefined {
  if (store === undefined) {
    const handle = cacheHandle();
    store = handle ? createRenderJobStore(handle.db) : null;
  }
  return store ?? undefined;
}

/* ------------------------------------------- the worker's side, SPEC §15.1 step 5 */

/**
 * Why the worker talks to `web` at all.
 *
 * SPEC §15.1: "Attach a volume to `web` only … Volumes cannot be shared between
 * services on Railway, and sharing SQLite across processes over a mount corrupts it —
 * this is the constraint that forces the 'worker asks web over HTTP' shape in §15, or
 * Postgres."
 *
 * So the queue is reachable two ways: directly, when both processes are on one host
 * (local development, a single container), and over these endpoints, when they are
 * not. The worker picks; nothing here assumes which.
 */
export const WORKER_TOKEN_ENV = 'RENDER_WORKER_TOKEN';

/** Where finished MP4s are written. On Railway this is the mounted volume. */
export function renderOutputDir(): string {
  return process.env['RENDER_OUTPUT_DIR'] ?? join(process.cwd(), '.data', 'renders');
}

/**
 * Authorise a worker request, or explain why not.
 *
 * `web` is public and these endpoints claim jobs and write files, so they are closed
 * unless a token is configured. Defaulting to open would mean a deployment that forgot
 * the variable is one request away from anyone filling its volume.
 */
export function authorizeWorker(request: Request): { ok: true } | { ok: false; response: Response } {
  const expected = process.env[WORKER_TOKEN_ENV];
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            `The worker API is disabled: ${WORKER_TOKEN_ENV} is not set. Set the same value ` +
            `on web and on worker (SPEC §15: "use Railway shared variables so they cannot drift").`,
        },
        { status: 503 },
      ),
    };
  }

  const presented = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
  // Length-first, then a constant-time compare: a plain === leaks the token one
  // character at a time to anyone willing to measure.
  if (presented.length !== expected.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return { ok: false, response: NextResponse.json({ error: 'Not authorised.' }, { status: 401 }) };
  }

  return { ok: true };
}
