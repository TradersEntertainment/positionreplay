/**
 * A worker asks for the next job. SPEC §15.1 step 5.
 *
 * POST rather than GET because it mutates: claiming marks the job running and takes it
 * out of everyone else's reach.
 */

import { NextResponse } from 'next/server';
import { authorizeWorker, renderJobStore, RENDER_UNAVAILABLE } from '@/lib/render';

export const dynamic = 'force-dynamic';

/** Matches the worker's default; overridable per request so the two cannot drift. */
const DEFAULT_LEASE_MS = 120_000;

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeWorker(request);
  if (!auth.ok) return auth.response;

  const jobs = renderJobStore();
  if (!jobs) return NextResponse.json({ error: RENDER_UNAVAILABLE }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as { worker?: string; leaseMs?: number };
  const worker = typeof body.worker === 'string' && body.worker ? body.worker.slice(0, 200) : 'unknown';
  const leaseMs = Number.isFinite(body.leaseMs) ? Number(body.leaseMs) : DEFAULT_LEASE_MS;

  const job = await jobs.claim(worker, Date.now(), leaseMs);
  // 204, not an empty 200: "nothing to do" is a different answer from "here is a job",
  // and the worker should not have to inspect a body to tell them apart.
  if (!job) return new Response(null, { status: 204 });

  return NextResponse.json({ id: job.id, spec: job.spec, attempts: job.attempts });
}
