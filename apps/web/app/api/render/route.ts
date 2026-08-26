/**
 * SPEC §9 Phase 2: `POST /render { replaySpec } -> jobId`.
 *
 * The request carries a replayId and a size, never frames or numbers: the worker
 * re-fetches the replay through this app's own /api/replay, so a job cannot be made to
 * render figures the server never computed.
 */

import { NextResponse } from 'next/server';
import { EXPORT_PRESETS } from '@/lib/export';
import { renderJobStore, RENDER_UNAVAILABLE } from '@/lib/render';
import { decodeReplayId } from '@trade-replay/core';
import type { RenderSpec } from '@trade-replay/cache';

export const dynamic = 'force-dynamic';

/** Frame rates worth offering. Anything else is a typo or someone probing. */
const ALLOWED_FPS = [24, 30, 60];

export async function POST(request: Request): Promise<Response> {
  const jobs = renderJobStore();
  if (!jobs) return NextResponse.json({ error: RENDER_UNAVAILABLE }, { status: 503 });

  let body: Partial<RenderSpec>;
  try {
    body = (await request.json()) as Partial<RenderSpec>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const replayId = typeof body.replayId === 'string' ? body.replayId : '';
  // Validated here rather than left to the worker: a bad id would otherwise queue a
  // job that exists only to fail, and the user would wait for it to do so.
  if (!decodeReplayId(replayId)) {
    return NextResponse.json({ error: 'That replay link is not valid.' }, { status: 400 });
  }

  // Only the presets SPEC §9 names. An arbitrary width is a way to ask one worker for
  // a 16000×16000 render and take the queue down with it.
  const preset = EXPORT_PRESETS.find((p) => p.width === body.width && p.height === body.height);
  if (!preset) {
    return NextResponse.json(
      {
        error: `Size must be one of ${EXPORT_PRESETS.map((p) => `${p.width}x${p.height}`).join(', ')}.`,
      },
      { status: 400 },
    );
  }

  const fps = Number(body.fps ?? 30);
  if (!ALLOWED_FPS.includes(fps)) {
    return NextResponse.json({ error: `fps must be one of ${ALLOWED_FPS.join(', ')}.` }, { status: 400 });
  }

  const spec: RenderSpec = {
    replayId,
    width: preset.width,
    height: preset.height,
    fps,
    theme: body.theme === 'light' ? 'light' : 'dark',
    slowFinish: body.slowFinish === true,
    ...(typeof body.interval === 'string' && body.interval !== '' ? { interval: body.interval } : {}),
  };

  const job = await jobs.enqueue(spec, Date.now());
  return NextResponse.json(
    { id: job.id, status: job.status, framesDone: job.framesDone, frameCount: job.frameCount },
    // 202 for a fresh job, 200 when an identical one already exists — the difference
    // between "queued now" and "you already asked".
    { status: job.status === 'queued' && job.attempts === 0 ? 202 : 200 },
  );
}
