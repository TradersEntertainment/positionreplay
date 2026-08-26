/**
 * A worker hands back the finished MP4. SPEC §15.1 step 5.
 *
 * The bytes travel in the request body, not a path: the volume is attached to `web`
 * only, so the worker's filesystem is not somewhere `web` can read from. This is the
 * "worker asks web over HTTP" shape §15 describes, carried through to the output.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { authorizeWorker, renderJobStore, renderOutputDir, RENDER_UNAVAILABLE } from '@/lib/render';

export const dynamic = 'force-dynamic';

/** Generous for a 1920x1080 replay, far short of anything that fills a 1 GB volume. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authorizeWorker(request);
  if (!auth.ok) return auth.response;

  const jobs = renderJobStore();
  if (!jobs) return NextResponse.json({ error: RENDER_UNAVAILABLE }, { status: 503 });

  const { id } = await params;
  const job = await jobs.get(id);
  // The job row is what makes an id legitimate; without this the filename below would
  // come from the request, which is how a path traversal starts.
  if (!job) return NextResponse.json({ error: 'No such render job.' }, { status: 404 });

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: 'The upload was empty.' }, { status: 400 });
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'That render is too large to store.' }, { status: 413 });
  }
  // MP4 files carry an "ftyp" box at offset 4. Checking it means a worker that somehow
  // sent the wrong bytes fails here rather than by serving an unplayable download.
  if (bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return NextResponse.json({ error: 'That upload is not an MP4.' }, { status: 400 });
  }

  const dir = renderOutputDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${job.id}.mp4`);
  writeFileSync(path, bytes);

  await jobs.complete(job.id, path, bytes.length, Date.now());
  return NextResponse.json({ id: job.id, bytes: bytes.length });
}
