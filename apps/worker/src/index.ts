/**
 * The render worker. SPEC §9 Phase 2, §12 M8, §15.
 *
 *   pnpm worker
 *
 * A long-running process that polls the job table and turns queued renders into MP4s.
 * Not publicly exposed (§15) and it never accepts a request: its only input is a row
 * another process wrote, and its only outbound calls are to `web` and to the public
 * read paths the adapters already use. Nothing here can place an order or read a key.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type WorkerConfig } from './config.js';
import { createTransport, type ClaimedJob, type JobTransport } from './transport.js';
import { preflight, PreflightError } from './preflight.js';
import { fetchReplay } from './replay.js';
import { renderMp4 } from './render.js';

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

/** Run one job to completion, recording the outcome either way. */
export async function runJob(
  job: ClaimedJob,
  jobs: JobTransport,
  config: WorkerConfig,
): Promise<void> {
  const started = Date.now();
  log(`job ${job.id} ${job.spec.replayId} ${job.spec.width}x${job.spec.height} attempt ${job.attempts}`);

  try {
    const payload = await fetchReplay(config.webUrl, job.spec.replayId, job.spec.interval);
    const outputPath = join(config.outputDir, `${job.id}.mp4`);

    const output = await renderMp4({
      spec: job.spec,
      payload,
      workDir: join(config.outputDir, `.work-${job.id}`),
      outputPath,
      maxFrames: config.maxFrames,
      onProgress: (done, total) => {
        // Fire-and-forget: a progress report that fails must not abort a render that
        // is otherwise fine. The lease lapsing is the backstop.
        void jobs.progress(job.id, done, total).catch(() => undefined);
      },
    });

    await jobs.complete(job.id, output.outputPath);
    log(
      `job ${job.id} done — ${output.frameCount} frames, ` +
        `${output.durationSeconds.toFixed(1)}s, ${(output.bytes / 1024).toFixed(0)} KB, ` +
        `took ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await jobs.fail(job.id, message).catch(() => undefined);
    // Logged as well as stored: the job row is where a user's request ends up, and
    // the log is where an operator looks. Neither is a substitute for the other.
    log(`job ${job.id} FAILED — ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  let checks;
  try {
    checks = preflight();
  } catch (error) {
    // SPEC §15: "fail loudly … a render worker that silently can't render is worse
    // than one that won't boot."
    console.error(
      `\n[worker] PREFLIGHT FAILED\n${error instanceof PreflightError ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  log(checks.ffmpegVersion);
  if (!checks.fontsRegistered) {
    log('WARNING: JetBrains Mono not registered; text will use a system mono and will');
    log('         not match the browser preview exactly.');
  }

  mkdirSync(config.outputDir, { recursive: true });

  let jobs: JobTransport;
  try {
    jobs = createTransport(config);
  } catch (error) {
    console.error(`\n[worker] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  log(`queue via ${jobs.description}, polling every ${config.pollMs}ms as ${config.workerId}`);
  log(`output ${config.outputDir}, web ${config.webUrl}`);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received; finishing the current job then exiting`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    let job: ClaimedJob | null = null;
    try {
      job = await jobs.claim();
    } catch (error) {
      // A database blip or a web restart must not kill the process: the next poll
      // retries, and a worker that exits on a transient error is usually down.
      log(`claim failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (job) {
      await runJob(job, jobs, config);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }

  jobs.close();
  log('stopped');
}

main().catch((error: unknown) => {
  console.error(`[worker] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
