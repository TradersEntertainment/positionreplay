import { afterEach, describe, expect, it } from 'vitest';
import { RENDER_VERSION } from '@trade-replay/renderer';
import { createRenderJobStore, requestKeyFor } from './renderJobs.js';
import { openCache, type CacheHandle } from './db.js';

const handles: CacheHandle[] = [];

function store() {
  const handle = openCache({ url: ':memory:' });
  handles.push(handle);
  return createRenderJobStore(handle.db);
}

afterEach(() => {
  while (handles.length) handles.pop()?.close();
});

const SPEC = {
  replayId: 'aGVsbG8',
  width: 1080,
  height: 1080,
  fps: 30,
  theme: 'dark' as const,
  slowFinish: false,
};

const T0 = Date.UTC(2026, 7, 26, 12, 0, 0);
const MIN = 60_000;

describe('enqueue', () => {
  it('returns a job that is queued and unclaimed', async () => {
    const jobs = store();
    const job = await jobs.enqueue(SPEC, T0);
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keys on what the renderer draws, not only on what is being drawn', async () => {
    // Without the renderer's version in the key, a file encoded before a drawing
    // change answers every later request for that replay forever: the viewer watches
    // a preview with the new ending and downloads one with the old.
    expect(requestKeyFor(SPEC).startsWith(`v${RENDER_VERSION}|`)).toBe(true);
  });

  it('is idempotent for an identical request', async () => {
    // A double-clicked button must not queue two ffmpeg runs for the same video.
    const jobs = store();
    const first = await jobs.enqueue(SPEC, T0);
    const second = await jobs.enqueue(SPEC, T0 + 1000);
    expect(second.id).toBe(first.id);
    expect((await jobs.pending()).length).toBe(1);
  });

  it('treats a different size as a different job', async () => {
    const jobs = store();
    const square = await jobs.enqueue(SPEC, T0);
    const wide = await jobs.enqueue({ ...SPEC, width: 1920 }, T0);
    expect(wide.id).not.toBe(square.id);
  });

  it('re-queues rather than reusing a job that failed', async () => {
    // A failed render is not an answer; asking again must actually retry.
    const jobs = store();
    const first = await jobs.enqueue(SPEC, T0);
    const claimed = await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    await jobs.fail(claimed!.id, 'ffmpeg exited 1', T0 + 2 * MIN);

    const second = await jobs.enqueue(SPEC, T0 + 3 * MIN);
    expect(second.status).toBe('queued');
    expect(second.id).not.toBe(first.id);
  });

  it('reuses a finished job, so the file is served rather than re-encoded', async () => {
    const jobs = store();
    const first = await jobs.enqueue(SPEC, T0);
    const claimed = await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    await jobs.complete(claimed!.id, '/data/renders/x.mp4', 1234, T0 + 2 * MIN);

    const second = await jobs.enqueue(SPEC, T0 + 3 * MIN);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('done');
    expect(second.outputPath).toBe('/data/renders/x.mp4');
  });
});

describe('claim', () => {
  it('returns null when nothing is queued', async () => {
    expect(await store().claim('worker-1', T0, 5 * MIN)).toBeNull();
  });

  it('marks the job running and records who took it', async () => {
    const jobs = store();
    await jobs.enqueue(SPEC, T0);
    const claimed = await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    expect(claimed?.status).toBe('running');
    expect(claimed?.claimedBy).toBe('worker-1');
    expect(claimed?.attempts).toBe(1);
  });

  it('will not hand the same job to a second worker', async () => {
    const jobs = store();
    await jobs.enqueue(SPEC, T0);
    const first = await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    const second = await jobs.claim('worker-2', T0 + MIN, 5 * MIN);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('takes the oldest queued job first', async () => {
    const jobs = store();
    const first = await jobs.enqueue(SPEC, T0);
    await jobs.enqueue({ ...SPEC, width: 1920 }, T0 + MIN);
    expect((await jobs.claim('worker-1', T0 + 2 * MIN, 5 * MIN))?.id).toBe(first.id);
  });

  it('reclaims a job whose worker died mid-render', async () => {
    // Without this a crashed worker strands the job as "running" forever, and the
    // browser polls a status that will never change.
    const jobs = store();
    await jobs.enqueue(SPEC, T0);
    await jobs.claim('worker-1', T0 + MIN, 5 * MIN);

    expect(await jobs.claim('worker-2', T0 + 3 * MIN, 5 * MIN)).toBeNull();
    const reclaimed = await jobs.claim('worker-2', T0 + 10 * MIN, 5 * MIN);
    expect(reclaimed?.claimedBy).toBe('worker-2');
    expect(reclaimed?.attempts).toBe(2);
  });

  it('gives up on a job that keeps dying rather than looping forever', async () => {
    const jobs = store();
    await jobs.enqueue(SPEC, T0);
    for (let i = 1; i <= 3; i++) await jobs.claim(`worker-${i}`, T0 + i * 10 * MIN, 5 * MIN);

    const abandoned = await jobs.claim('worker-4', T0 + 40 * MIN, 5 * MIN);
    expect(abandoned).toBeNull();

    const job = await jobs.get((await jobs.all())[0]!.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/3 attempts/);
  });
});

describe('progress, completion and failure', () => {
  it('records progress so the UI can show something during a long render', async () => {
    const jobs = store();
    await jobs.enqueue(SPEC, T0);
    const claimed = await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    await jobs.progress(claimed!.id, 42, 200, T0 + 2 * MIN);

    const job = await jobs.get(claimed!.id);
    expect(job?.framesDone).toBe(42);
    expect(job?.frameCount).toBe(200);
  });

  it('a progress report renews the claim, so a slow render is not reclaimed', async () => {
    const jobs = store();
    await jobs.enqueue(SPEC, T0);
    const claimed = await jobs.claim('worker-1', T0 + MIN, 5 * MIN);

    // Still working at T0+10min, having reported at T0+9min.
    await jobs.progress(claimed!.id, 100, 200, T0 + 9 * MIN);
    expect(await jobs.claim('worker-2', T0 + 10 * MIN, 5 * MIN)).toBeNull();
  });

  it('completing stores the output and stops the job being pending', async () => {
    const jobs = store();
    const job = await jobs.enqueue(SPEC, T0);
    await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    await jobs.complete(job.id, '/data/renders/out.mp4', 9001, T0 + 2 * MIN);

    const done = await jobs.get(job.id);
    expect(done?.status).toBe('done');
    expect(done?.outputPath).toBe('/data/renders/out.mp4');
    expect(done?.outputBytes).toBe(9001);
    expect(await jobs.pending()).toEqual([]);
  });

  it('failing keeps the reason, because "it failed" is not debuggable', async () => {
    const jobs = store();
    const job = await jobs.enqueue(SPEC, T0);
    await jobs.claim('worker-1', T0 + MIN, 5 * MIN);
    await jobs.fail(job.id, 'ffmpeg: Unknown encoder libx264', T0 + 2 * MIN);

    const failed = await jobs.get(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('libx264');
  });

  it('returns null for an id that was never enqueued', async () => {
    expect(await store().get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
