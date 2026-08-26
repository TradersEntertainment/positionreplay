/**
 * Render job status. The browser polls this while the worker encodes.
 *
 * The output path is never returned: it is a server filesystem path, and the file is
 * served by the sibling /file route instead. A client that knew the path would be one
 * step from asking for a different one.
 */

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

  return NextResponse.json({
    id: job.id,
    status: job.status,
    framesDone: job.framesDone,
    frameCount: job.frameCount,
    bytes: job.outputBytes,
    error: job.error,
    ...(job.status === 'done' ? { url: `/api/render/${job.id}/file` } : {}),
  });
}
