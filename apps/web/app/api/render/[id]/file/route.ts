/**
 * Serve a finished MP4.
 *
 * SPEC §9 Phase 2 ends at "-> presigned URL". There is no object store here yet
 * (SPEC §15: "store output to object storage (or a volume)"), so the volume is the
 * store and this route is the URL. The job row is the only way to name a file: the id
 * is a UUID we issued, and the path comes from the row rather than from the request,
 * so no input reaches the filesystem.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { renderJobStore, RENDER_UNAVAILABLE } from '@/lib/render';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const jobs = renderJobStore();
  if (!jobs) return NextResponse.json({ error: RENDER_UNAVAILABLE }, { status: 503 });

  const { id } = await params;
  const job = await jobs.get(id);

  if (!job) return NextResponse.json({ error: 'No such render job.' }, { status: 404 });
  if (job.status !== 'done' || !job.outputPath) {
    return NextResponse.json(
      { error: `That render is ${job.status}, not ready to download.` },
      { status: 409 },
    );
  }
  if (!existsSync(job.outputPath)) {
    // The volume was cleared, or `web` and `worker` do not share one. Saying so beats
    // a 404 that reads as "your job never existed".
    return NextResponse.json(
      {
        error:
          'The rendered file is gone from disk. If web and worker run on separate ' +
          'volumes they cannot share renders — see SPEC §15.',
      },
      { status: 410 },
    );
  }

  const size = statSync(job.outputPath).size;
  const stream = Readable.toWeb(createReadStream(job.outputPath)) as ReadableStream;

  return new Response(stream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="trade-replay-${job.id.slice(0, 8)}.mp4"`,
      // The file is immutable once written; the id changes when the render does.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
