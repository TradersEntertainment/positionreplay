/**
 * How long each timeline frame is held in the exported video.
 *
 * SPEC §9 Phase 2 writes `ffmpeg -r 30 -i frame-%05d.png`, which holds every frame for
 * the same time. That is right only when playback is even — and SPEC §6.3 offers a
 * "climax": "slow down to 0.3x for the last ~10% of frames … a small touch that makes
 * exports much more watchable."
 *
 * So the schedule is computed here rather than assumed by ffmpeg, from the same
 * constants the player's clock uses. A video that ignored the climax would not be the
 * replay the viewer previewed, and §9's whole claim is that the two match.
 */

import { BASE_FPS, CLIMAX_SPEED, CLIMAX_TAIL_RATIO } from '@trade-replay/core';

export interface ScheduleOptions {
  frameCount: number;
  /** Video frame rate. SPEC §9 Phase 2 uses 30. */
  fps: number;
  /** SPEC §6.3's climax easing, matching the player's toggle. */
  slowFinish: boolean;
  /** Playback speed the preview ran at. SPEC §6.3: framesPerSecond = 24 * speed. */
  speed?: number;
  /**
   * Trailing frames that are the closing card rather than the trade
   * (core's `OUTRO_HOLD_FRAMES`). They sit outside the climax, exactly as in the
   * player's clock: the slow-down belongs to the exit, and the card is a fixed length.
   */
  holdFrames?: number;
}

export interface Schedule {
  /** Seconds each timeline frame is shown, in order. */
  durations: number[];
  /** Total video length in seconds. */
  durationSeconds: number;
}

/**
 * The first frame index that plays at climax speed, or `frameCount` when it is off.
 *
 * Exported because the same boundary decides the player's readout, and two
 * implementations of "the last ~10%" would eventually disagree by a frame.
 */
export function climaxStart(frameCount: number, slowFinish: boolean, holdFrames = 0): number {
  const traded = Math.max(0, frameCount - Math.max(0, holdFrames));
  if (!slowFinish || traded === 0) return traded;
  return Math.max(0, traded - Math.max(1, Math.round(traded * CLIMAX_TAIL_RATIO)));
}

export function buildSchedule(options: ScheduleOptions): Schedule {
  const { frameCount, fps, slowFinish } = options;
  const speed = options.speed ?? 1;

  if (frameCount <= 0) return { durations: [], durationSeconds: 0 };
  if (fps <= 0) throw new Error(`fps must be positive, got ${fps}`);
  if (speed <= 0) throw new Error(`speed must be positive, got ${speed}`);

  const hold = Math.max(0, options.holdFrames ?? 0);
  const traded = Math.max(0, frameCount - hold);
  const start = climaxStart(frameCount, slowFinish, hold);

  const durations = Array.from({ length: frameCount }, (_, i) => {
    // `i < traded` keeps the held frames out of it: the card is a fixed second and a
    // half, and at 0.3x it would run for five.
    const effectiveSpeed = i >= start && i < traded ? speed * CLIMAX_SPEED : speed;
    // One timeline frame lasts 1 / (24 * speed) seconds, exactly as in the player.
    const seconds = 1 / (BASE_FPS * effectiveSpeed);
    // Not rounded to the video's frame grid: rounding each frame independently
    // accumulates — at 60fps every 1/24s frame rounds up to 3/60 and a ten-second
    // replay exports as twelve. The concat demuxer takes arbitrary durations, so the
    // only floor needed is one video frame, below which `fps=` would drop the frame
    // and lose part of the replay outright.
    return Math.max(seconds, 1 / fps);
  });

  return {
    durations,
    durationSeconds: durations.reduce((sum, d) => sum + d, 0),
  };
}

/**
 * An ffconcat playlist. See `render.ts` for why this rather than `-r 30`.
 *
 * The final entry is repeated with no duration: the concat demuxer ignores the
 * duration of the last file, so without the repeat the real last frame is shown for
 * one frame time and the video ends a beat early.
 */
export function ffconcatFor(files: readonly string[], durations: readonly number[]): string {
  if (files.length === 0) throw new Error('No frames to write.');

  const lines = ['ffconcat version 1.0'];
  files.forEach((file, i) => {
    lines.push(`file '${file}'`);
    lines.push(`duration ${(durations[i] ?? durations[durations.length - 1] ?? 1 / 30).toFixed(6)}`);
  });
  lines.push(`file '${files[files.length - 1]!}'`);
  return `${lines.join('\n')}\n`;
}
