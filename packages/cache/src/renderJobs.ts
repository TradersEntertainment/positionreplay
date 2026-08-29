/**
 * Render-job queue. SPEC §9 Phase 2 and §15.
 *
 * §15: "Railway has no managed queue. For expected volume, a SQLite/Postgres-backed
 * job table polled by `worker` every few seconds is sufficient and far simpler than
 * adding a broker. Keep jobs idempotent and store output to object storage (or a
 * volume) rather than streaming from memory."
 *
 * Idempotency is by request key rather than by a caller-supplied id: two clicks on
 * Download MP4 must not become two ffmpeg runs, and a finished render must be handed
 * back rather than re-encoded.
 */

import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { RENDER_VERSION } from '@trade-replay/renderer';
import type { CacheDb } from './db.js';
import { renderJobs } from './schema.js';

export type RenderJobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * What to render.
 *
 * Deliberately not the whole replay: the worker re-derives frames from the replayId
 * through the same adapters and the same §5 fold the browser used, so a job cannot
 * carry a stale or hand-edited copy of the numbers.
 */
export interface RenderSpec {
  replayId: string;
  width: number;
  height: number;
  fps: number;
  theme: 'dark' | 'light';
  /** SPEC §6.3's "climax" easing, so the file matches what the preview played. */
  slowFinish: boolean;
  /** Interval override, when the viewer picked one. */
  interval?: string;
}

export interface RenderJob {
  id: string;
  spec: RenderSpec;
  status: RenderJobStatus;
  attempts: number;
  claimedBy: string | null;
  claimedAt: number | null;
  framesDone: number;
  frameCount: number;
  outputPath: string | null;
  outputBytes: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Attempts allowed before a job is declared dead.
 *
 * A render that crashes the worker would otherwise be picked up forever, and each
 * pass costs a full frame render before it dies.
 */
export const MAX_ATTEMPTS = 3;

export interface RenderJobStore {
  /** Queue a render, or return the existing job for an identical request. */
  enqueue(spec: RenderSpec, now: number): Promise<RenderJob>;
  get(id: string): Promise<RenderJob | null>;
  /** Jobs not yet finished, oldest first. */
  pending(): Promise<RenderJob[]>;
  all(): Promise<RenderJob[]>;
  /**
   * Take the oldest workable job, or null.
   *
   * `leaseMs` is how long a claim is honoured without progress: past that the job is
   * assumed abandoned and another worker may take it. A crashed worker otherwise
   * strands the job as "running" forever while the browser polls a status that will
   * never change.
   */
  claim(worker: string, now: number, leaseMs: number): Promise<RenderJob | null>;
  progress(id: string, framesDone: number, frameCount: number, now: number): Promise<void>;
  complete(id: string, outputPath: string, outputBytes: number, now: number): Promise<void>;
  fail(id: string, error: string, now: number): Promise<void>;
}

/** The identity of a request. Same key, same video — so the same job. */
export function requestKeyFor(spec: RenderSpec): string {
  return [
    // What the renderer draws is part of the request, not just what is being drawn.
    // Without this an MP4 encoded by an older version of the renderer answers every
    // later request for the same replay forever — the viewer watches a preview with
    // the new ending and downloads a file with the old one.
    `v${RENDER_VERSION}`,
    spec.replayId,
    spec.width,
    spec.height,
    spec.fps,
    spec.theme,
    spec.slowFinish ? 'slow' : 'even',
    spec.interval ?? 'auto',
  ].join('|');
}

interface Row {
  id: string;
  requestKey: string;
  spec: unknown;
  status: string;
  attempts: number;
  claimedBy: string | null;
  claimedAt: number | null;
  framesDone: number;
  frameCount: number;
  outputPath: string | null;
  outputBytes: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

function toJob(row: Row): RenderJob {
  return {
    id: row.id,
    // Written by `enqueue` from a typed value; a hand-edited row is not a threat
    // model worth a second schema.
    spec: row.spec as RenderSpec,
    status: row.status as RenderJobStatus,
    attempts: row.attempts,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    framesDone: row.framesDone,
    frameCount: row.frameCount,
    outputPath: row.outputPath,
    outputBytes: row.outputBytes,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createRenderJobStore(db: CacheDb): RenderJobStore {
  const rowById = (id: string): Row | undefined =>
    db.select().from(renderJobs).where(eq(renderJobs.id, id)).get() as Row | undefined;

  return {
    async enqueue(spec, now) {
      const requestKey = requestKeyFor(spec);

      // A queued, running or finished job answers the request. A failed one does not:
      // asking again after a failure has to mean "try again", or the button is dead.
      const existing = db
        .select()
        .from(renderJobs)
        .where(and(eq(renderJobs.requestKey, requestKey), sql`${renderJobs.status} != 'failed'`))
        .orderBy(asc(renderJobs.createdAt))
        .get() as Row | undefined;

      if (existing) return toJob(existing);

      const id = crypto.randomUUID();
      db.insert(renderJobs)
        .values({
          id,
          requestKey,
          spec,
          status: 'queued',
          attempts: 0,
          claimedBy: null,
          claimedAt: null,
          framesDone: 0,
          frameCount: 0,
          outputPath: null,
          outputBytes: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return toJob(rowById(id)!);
    },

    async get(id) {
      const row = rowById(id);
      return row ? toJob(row) : null;
    },

    async pending() {
      const rows = db
        .select()
        .from(renderJobs)
        .where(sql`${renderJobs.status} in ('queued', 'running')`)
        .orderBy(asc(renderJobs.createdAt))
        .all() as Row[];
      return rows.map(toJob);
    },

    async all() {
      const rows = db.select().from(renderJobs).orderBy(asc(renderJobs.createdAt)).all() as Row[];
      return rows.map(toJob);
    },

    async claim(worker, now, leaseMs) {
      const deadline = now - leaseMs;

      // Queued, or running under a lease that has lapsed.
      const candidate = db
        .select()
        .from(renderJobs)
        .where(
          or(
            eq(renderJobs.status, 'queued'),
            and(
              eq(renderJobs.status, 'running'),
              or(isNull(renderJobs.claimedAt), lt(renderJobs.claimedAt, deadline)),
            ),
          ),
        )
        .orderBy(asc(renderJobs.createdAt))
        .get() as Row | undefined;

      if (!candidate) return null;

      if (candidate.attempts >= MAX_ATTEMPTS) {
        // Retried to death. Recorded as failed so the browser stops polling and the
        // reason is visible, rather than the job silently cycling forever.
        db.update(renderJobs)
          .set({
            status: 'failed',
            error: `Gave up after ${MAX_ATTEMPTS} attempts. The last worker did not finish or report progress.`,
            claimedBy: null,
            claimedAt: null,
            updatedAt: now,
          })
          .where(eq(renderJobs.id, candidate.id))
          .run();
        return null;
      }

      // Conditional update: another worker that read the same row loses the race
      // because the claim only applies while the row still looks the way it did.
      const claimed = db
        .update(renderJobs)
        .set({
          status: 'running',
          attempts: candidate.attempts + 1,
          claimedBy: worker,
          claimedAt: now,
          updatedAt: now,
        })
        .where(and(eq(renderJobs.id, candidate.id), eq(renderJobs.attempts, candidate.attempts)))
        .returning()
        .get() as Row | undefined;

      return claimed ? toJob(claimed) : null;
    },

    async progress(id, framesDone, frameCount, now) {
      db.update(renderJobs)
        // `claimedAt` moves too: reporting progress is what renews the lease, so a
        // legitimately slow render is not reclaimed out from under itself.
        .set({ framesDone, frameCount, claimedAt: now, updatedAt: now })
        .where(eq(renderJobs.id, id))
        .run();
    },

    async complete(id, outputPath, outputBytes, now) {
      db.update(renderJobs)
        .set({
          status: 'done',
          outputPath,
          outputBytes,
          claimedBy: null,
          claimedAt: null,
          error: null,
          updatedAt: now,
        })
        .where(eq(renderJobs.id, id))
        .run();
    },

    async fail(id, error, now) {
      db.update(renderJobs)
        .set({
          status: 'failed',
          error: error.slice(0, 2000),
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(eq(renderJobs.id, id))
        .run();
    },
  };
}
