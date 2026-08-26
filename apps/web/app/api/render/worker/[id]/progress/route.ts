/** A worker reports frames done, which also renews its lease. SPEC §15.1 step 5. */

import { NextResponse } from 'next/server';
import { authorizeWorker, renderJobStore, RENDER_UNAVAILABLE } from '@/lib/render';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authorizeWorker(request);
  if (!auth.ok) return auth.response;

  const jobs = renderJobStore();
  if (!jobs) return NextResponse.json({ error: RENDER_UNAVAILABLE }, { status: 503 });

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { framesDone?: number; frameCount?: number };

  await jobs.progress(id, Number(body.framesDone ?? 0), Number(body.frameCount ?? 0), Date.now());
  return new Response(null, { status: 204 });
}
