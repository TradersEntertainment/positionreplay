/**
 * When the replay stops being a chart and becomes a card.
 *
 * The timing only — no drawing, no context. It sits beside effects.ts and follows the
 * same rule for the same reason: the shape of the ending is derived from the frame
 * list, never from wall time, so the exported MP4 ends exactly the way the preview did
 * (SPEC §9). layers/outro.ts draws what this decides, and score.ts sounds the note that
 * lands on it — three readings of one number rather than three things timed separately.
 *
 * The ending is exactly the frames `buildFrames` holds after the last bar
 * (`OUTRO_HOLD_FRAMES`), and that is the whole design. An ending measured as "the last
 * N frames" instead would land on the closing bars of the trade — which is where the
 * position actually closes, and where SPEC §6.3 slows to 0.3x so the viewer can watch
 * it happen. Dimming those would hide the one moment the replay builds to.
 */

import { OUTRO_HOLD_FRAMES } from '@trade-replay/core';

export { OUTRO_HOLD_FRAMES };

/** Below this the window cannot ease from 0 to 1, so there is no outro at all. */
const MIN_FRAMES = 2;

/**
 * Frames the outro occupies on a replay of `total` frames; 0 for none.
 *
 * `total` is the whole array, hold included. A replay shorter than the hold has not
 * come from `buildFrames` — a fixture, a trimmed clip — and gets no ending rather than
 * an ending drawn over its only frames.
 */
export function outroLength(total: number): number {
  if (!Number.isFinite(total) || total <= OUTRO_HOLD_FRAMES) return 0;
  return OUTRO_HOLD_FRAMES >= MIN_FRAMES ? OUTRO_HOLD_FRAMES : 0;
}

/** First frame of the outro, or -1 when this replay has none. */
export function outroStart(total: number): number {
  const length = outroLength(total);
  return length === 0 ? -1 : total - length;
}

/**
 * How far into the ending frame `index` is, 0..1 — or null if it is not in it.
 *
 * Null rather than 0 because 0 is a real value here: it is the first frame of the
 * outro, where the dim is already beginning. A caller that cannot tell those apart
 * would start the ending one frame early on every replay.
 */
export function outroProgressAt(index: number, total: number): number | null {
  const length = outroLength(total);
  if (length === 0) return null;

  const start = total - length;
  if (index < start) return null;
  // Past the end holds at the final frame. A still rendered at a clamped index must
  // land on the card, not somewhere beyond it.
  if (index >= total - 1) return 1;
  return (index - start) / (length - 1);
}

/**
 * Ease-out cubic.
 *
 * The pull-back should move most in its first frames and settle into the card, the way
 * a camera does. Linear reads as a machine sliding, which is the one thing a "final
 * shot" must not look like.
 */
export function easeOutCubic(p: number): number {
  const t = Math.min(1, Math.max(0, p));
  return 1 - (1 - t) ** 3;
}
