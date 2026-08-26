/**
 * How hard the replay is moving, as a number the layers can draw with.
 *
 * SPEC §7.3 rules the aesthetic: "no gradients, no rounded corners, no shadows. It
 * should look like a terminal, not a dashboard." So none of this produces a glow. What
 * it produces is *intensity* — discrete steps, inverse-video flashes, block characters,
 * a candle drawn heavier — the vocabulary a terminal actually has. That constraint is
 * why the effects read as the chart reacting rather than as chrome laid over it.
 *
 * Pure, and computed from the precomputed `Frame[]` rather than from wall time, so the
 * exported MP4 shows exactly the effects the preview did (SPEC §9). This is the reason
 * it lives here and not in the player.
 */

import type { Frame } from '@trade-replay/core';

export interface FrameEnergy {
  /**
   * Recent PnL direction and force, -1..1.
   *
   * Normalised against this replay's own biggest move rather than a dollar constant:
   * a $40 swing is enormous on a $500 position and noise on a $2M one, and a fixed
   * threshold would make the effects fire constantly on one and never on the other.
   */
  momentum: number;
  /** 0..1, where PnL sits between this replay's worst and best. */
  level: number;
  /** This frame set a new best. */
  newHigh: boolean;
  /** This frame set a new worst. */
  newLow: boolean;
  /** Frames since the last new extreme; drives how fast a flash decays. */
  sinceExtreme: number;
}

export const NEUTRAL_ENERGY: FrameEnergy = {
  momentum: 0,
  level: 0.5,
  newHigh: false,
  newLow: false,
  sinceExtreme: Number.POSITIVE_INFINITY,
};

/** Frames the momentum window looks back over. Half a second at SPEC §6.3's 24fps. */
export const MOMENTUM_WINDOW = 12;

/**
 * Energy for every frame, in one pass.
 *
 * Precomputed as an array because each frame's value depends on the whole history
 * before it — the running extremes — and recomputing that per frame would make
 * rendering quadratic in a replay that can be thousands of frames long.
 */
export function computeEnergyTrack(
  frames: readonly Frame[],
  window = MOMENTUM_WINDOW,
): FrameEnergy[] {
  if (frames.length === 0) return [];

  let best = Number.NEGATIVE_INFINITY;
  let worst = Number.POSITIVE_INFINITY;
  let lastExtreme = 0;

  // The largest single-window move in the replay, used to normalise. Found up front so
  // that momentum means the same thing at frame 5 and at frame 500 — scaling against a
  // running maximum would make early frames look violent and late ones dead.
  let largestMove = 0;
  for (let i = 0; i < frames.length; i++) {
    const before = frames[Math.max(0, i - window)]!.totalPnl;
    largestMove = Math.max(largestMove, Math.abs(frames[i]!.totalPnl - before));
  }

  return frames.map((frame, i) => {
    const before = frames[Math.max(0, i - window)]!.totalPnl;
    const move = frame.totalPnl - before;

    const newHigh = i > 0 && frame.totalPnl > best;
    const newLow = i > 0 && frame.totalPnl < worst;
    if (frame.totalPnl > best) best = frame.totalPnl;
    if (frame.totalPnl < worst) worst = frame.totalPnl;
    if (newHigh || newLow) lastExtreme = i;

    const span = best - worst;

    return {
      // A flat replay has largestMove 0; dividing would be NaN, and NaN reaches a
      // colour calculation and paints nothing at all.
      momentum: largestMove > 0 ? clamp(move / largestMove, -1, 1) : 0,
      level: span > 0 ? clamp((frame.totalPnl - worst) / span, 0, 1) : 0.5,
      newHigh,
      newLow,
      sinceExtreme: i - lastExtreme,
    };
  });
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(high, Math.max(low, value));
}

/** SPEC §7.3's vocabulary: eight block heights, the way a terminal draws a bar. */
export const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * A PnL meter as block characters.
 *
 * `level` fills the bar left to right; the partial cell at the boundary picks the block
 * height that represents the remainder, which is what makes it read as continuous
 * despite being text.
 */
export function blockMeter(level: number, width: number): string {
  if (width <= 0) return '';
  const filled = clamp(level, 0, 1) * width;
  const whole = Math.floor(filled);
  const remainder = filled - whole;

  let out = BLOCKS[BLOCKS.length - 1]!.repeat(Math.min(whole, width));
  if (whole < width) {
    // A remainder below one eighth would render as the shortest block rather than as
    // nothing, overstating an empty meter.
    out += remainder >= 1 / BLOCKS.length ? BLOCKS[Math.floor(remainder * BLOCKS.length)]! : ' ';
    out += ' '.repeat(Math.max(0, width - whole - 1));
  }
  return out;
}

/**
 * How strongly a flash still shows, 1 at the extreme and 0 once it has decayed.
 *
 * Stepped rather than smooth: SPEC §7.3 asks for a terminal, and a terminal's inverse
 * video is on or off. Four steps is enough to read as a decay and coarse enough that it
 * never looks like a fade.
 */
export function flashStrength(sinceExtreme: number, frames = 8): number {
  if (!Number.isFinite(sinceExtreme) || sinceExtreme < 0 || sinceExtreme >= frames) return 0;
  const steps = 4;
  return Math.ceil((1 - sinceExtreme / frames) * steps) / steps;
}
