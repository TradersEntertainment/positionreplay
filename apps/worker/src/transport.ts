/**
 * How the worker reaches the job queue.
 *
 * Two ways, because the deployment shape decides which is possible:
 *
 *   - `sqlite` — open the job table directly. Correct when both processes are on one
 *     host and one filesystem: local development, a single container, one VM.
 *   - `http` — ask `web` for work and hand the file back over the wire. SPEC §15.1
 *     step 5: "Attach a volume to `web` only. Volumes cannot be shared between
 *     services on Railway, and sharing SQLite across processes over a mount corrupts
 *     it — this is the constraint that forces the 'worker asks web over HTTP' shape."
 *
 * Both satisfy the same interface, so `index.ts` does not know which it has, and the
 * one thing that must never happen — two workers rendering one job — is decided by
 * the same `claim` either way.
 */

import { readFileSync } from 'node:fs';
import { openCache, createRenderJobStore } from '@trade-replay/cache';
import type { RenderSpec } from '@trade-replay/cache';
import type { WorkerConfig } from './config.js';

export interface ClaimedJob {
  id: string;
  spec: RenderSpec;
  attempts: number;
}

export interface JobTransport {
  /** A job to render, or null. */
  claim(): Promise<ClaimedJob | null>;
  progress(id: string, framesDone: number, frameCount: number): Promise<void>;
  /** Hand back the finished file. The path is local to the worker. */
  complete(id: string, path: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  /** Human-readable, for the boot log. */
  readonly description: string;
  close(): void;
}

export function createSqliteTransport(config: WorkerConfig): JobTransport {
  const handle = openCache({ url: config.databaseUrl });
  const jobs = createRenderJobStore(handle.db);

  return {
    description: `sqlite ${config.databaseUrl}`,
    async claim() {
      const job = await jobs.claim(config.workerId, Date.now(), config.leaseMs);
      return job ? { id: job.id, spec: job.spec, attempts: job.attempts } : null;
    },
    progress: (id, framesDone, frameCount) =>
      jobs.progress(id, framesDone, frameCount, Date.now()),
    complete: async (id, path) => {
      // Same filesystem, so the path is the handover; nothing is copied.
      const bytes = readFileSync(path).length;
      await jobs.complete(id, path, bytes, Date.now());
    },
    fail: (id, error) => jobs.fail(id, error, Date.now()),
    close: () => handle.close(),
  };
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export function createHttpTransport(config: WorkerConfig): JobTransport {
  if (!config.workerToken) {
    throw new TransportError(
      'RENDER_TRANSPORT=http needs RENDER_WORKER_TOKEN, and the same value must be set on ' +
        'web. SPEC §15: "use Railway shared variables so they cannot drift."',
    );
  }

  const headers = { Authorization: `Bearer ${config.workerToken}` };
  const url = (path: string): string => `${config.webUrl}/api/render/worker${path}`;

  async function expectOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => '');
    throw new TransportError(`${what} returned ${response.status}: ${body.slice(0, 300)}`);
  }

  return {
    description: `http ${config.webUrl}/api/render/worker`,

    async claim() {
      const response = await fetch(url('/claim'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker: config.workerId, leaseMs: config.leaseMs }),
      });
      if (response.status === 204) return null;
      await expectOk(response, 'claim');
      return (await response.json()) as ClaimedJob;
    },

    async progress(id, framesDone, frameCount) {
      const response = await fetch(url(`/${id}/progress`), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ framesDone, frameCount }),
      });
      await expectOk(response, 'progress');
    },

    async complete(id, path) {
      // The whole file in one request. Streaming would be kinder to memory, but a
      // resumable upload needs a protocol on both ends, and a render that has to be
      // redone is cheaper than one that half-uploads and is recorded as done.
      const response = await fetch(url(`/${id}/complete`), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'video/mp4' },
        body: new Uint8Array(readFileSync(path)),
      });
      await expectOk(response, 'complete');
    },

    async fail(id, error) {
      const response = await fetch(url(`/${id}/fail`), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error }),
      });
      await expectOk(response, 'fail');
    },

    close: () => undefined,
  };
}

export function createTransport(config: WorkerConfig): JobTransport {
  return config.transport === 'http' ? createHttpTransport(config) : createSqliteTransport(config);
}
