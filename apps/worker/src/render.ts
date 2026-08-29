/**
 * SPEC §9 Phase 2:
 *
 *   worker: for i in 0..frames.length:
 *             renderFrame(nodeCanvasCtx, frames[i], ...)
 *             write frame-%05d.png
 *           ffmpeg -r 30 -i frame-%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4
 *
 * Two deliberate departures from that command line, both so the file matches the
 * preview rather than merely resembling it:
 *
 *   - Frames go through an ffconcat playlist instead of `-r 30 -i frame-%05d.png`.
 *     A fixed input rate cannot express SPEC §6.3's climax, where the last 10% of
 *     frames play at 0.3x. See schedule.ts.
 *   - The renderer is `createSequenceRenderer`, the same one the player and the
 *     client-side exporter use, so §7.2's eased axis is replayed identically. Rendering
 *     each frame from a fresh scale would produce a different chart at frame N.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { OUTRO_HOLD_FRAMES, buildFrames } from '@trade-replay/core';
import type { Frame } from '@trade-replay/core';
import { createSequenceRenderer, darkTheme, lightTheme } from '@trade-replay/renderer';
import type { Canvas2D } from '@trade-replay/renderer';
import type { RenderSpec } from '@trade-replay/cache';
import type { ReplayPayload } from './replay.js';
import { buildSchedule, ffconcatFor } from './schedule.js';

const execFileAsync = promisify(execFile);

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface RenderOptions {
  spec: RenderSpec;
  payload: ReplayPayload;
  /** A scratch directory for this job's PNGs; removed afterwards. */
  workDir: string;
  outputPath: string;
  ffmpegBinary?: string;
  maxFrames?: number;
  onProgress?: (framesDone: number, frameCount: number) => void;
  signal?: AbortSignal;
}

export interface RenderOutput {
  outputPath: string;
  bytes: number;
  frameCount: number;
  durationSeconds: number;
}

export async function renderMp4(options: RenderOptions): Promise<RenderOutput> {
  const { spec, payload, workDir, outputPath } = options;
  const ffmpeg = options.ffmpegBinary ?? process.env['FFMPEG_PATH'] ?? 'ffmpeg';

  // Frames are rebuilt rather than shipped in the payload: they are a pure function of
  // (episode, series), and recomputing keeps the request small and the numbers derived
  // from the same §5 fold rather than from something a caller could hand-edit.
  const frames: Frame[] = buildFrames(payload.episode, payload.series);
  if (frames.length === 0) {
    throw new RenderError(`${spec.replayId} has no frames; there is nothing to render.`);
  }

  const maxFrames = options.maxFrames ?? 3000;
  if (frames.length > maxFrames) {
    throw new RenderError(
      `${spec.replayId} is ${frames.length} frames, over the ${maxFrames}-frame cap. ` +
        `Pick a coarser interval, or raise RENDER_MAX_FRAMES if the disk can take it.`,
    );
  }

  mkdirSync(workDir, { recursive: true });

  const theme = spec.theme === 'light' ? lightTheme : darkTheme;
  const renderer = createSequenceRenderer(payload.episode, payload.series, frames, theme);
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext('2d');

  const layout = {
    width: spec.width,
    height: spec.height,
    dpr: 1,
    address: payload.address,
    watermark: 'trade-replay',
    interval: payload.interval,
    ...(payload.fundingUnavailable ? { fundingUnavailable: true } : {}),
    ...(payload.notices.length > 0 ? { notices: payload.notices } : {}),
  };

  const files: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (options.signal?.aborted) throw new RenderError('Render cancelled.');

    renderer.render(ctx as unknown as Canvas2D, i, layout);
    const file = `frame-${String(i).padStart(5, '0')}.png`;
    writeFileSync(join(workDir, file), canvas.toBuffer('image/png'));
    files.push(file);

    // Every 24 frames is roughly once per second of replay: often enough that the
    // browser's progress bar moves, rare enough that the write is not the bottleneck.
    if (i % 24 === 0 || i === frames.length - 1) options.onProgress?.(i + 1, frames.length);
  }

  const schedule = buildSchedule({
    frameCount: frames.length,
    fps: spec.fps,
    slowFinish: spec.slowFinish,
    // buildFrames appended these for the closing card; they are not part of the trade
    // and so not part of the climax. Same rule as the player's clock.
    holdFrames: OUTRO_HOLD_FRAMES,
  });
  const playlist = join(workDir, 'frames.txt');
  writeFileSync(playlist, ffconcatFor(files, schedule.durations));

  try {
    await execFileAsync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        // -safe 0 because the playlist names files relative to its own directory.
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        playlist,
        // Variable input timing resampled onto a constant output rate: the durations
        // carry the climax, `fps` makes the result a normal constant-rate MP4.
        '-vsync',
        'vfr',
        '-vf',
        `fps=${spec.fps},format=yuv420p`,
        '-c:v',
        'libx264',
        // SPEC §9 Phase 2's own settings. yuv420p is not optional: X will not play
        // 4:4:4 H.264, and the failure is a silent black frame in the timeline.
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        // Moves the index to the front so the file plays while still downloading.
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    throw new RenderError(
      `ffmpeg failed for ${spec.replayId}: ${
        error instanceof Error ? error.message : String(error)
      }${stderr ? `\n  ${stderr.trim().slice(0, 500)}` : ''}`,
    );
  } finally {
    // The PNGs are large and worthless once encoded; leaving them fills the volume
    // after a few dozen jobs.
    rmSync(workDir, { recursive: true, force: true });
  }

  const bytes = statSync(outputPath).size;
  if (bytes === 0) throw new RenderError(`ffmpeg produced an empty file for ${spec.replayId}.`);

  return {
    outputPath,
    bytes,
    frameCount: frames.length,
    durationSeconds: schedule.durationSeconds,
  };
}
