/**
 * Replay timeline. SPEC.md §6.
 *
 * Frames are precomputed in full: SPEC §6.2 requires that the export path can jump
 * to an arbitrary frame index deterministically, which rules out computing PnL
 * inside the render loop.
 */

import { totalPnl, unrealizedFor } from './pnl.js';
import type { Fill, Frame, FundingEvent, PositionEpisode, PriceSeries, TimeRange } from './types.js';

/**
 * One selectable candle interval.
 *
 * The table of them belongs to its venue, not here: interval vocabularies are
 * venue-specific, and `pickInterval` takes the table as an argument precisely so core
 * never has to know which venues exist (CLAUDE.md: "Adapters never leak").
 */
export interface IntervalSpec {
  /** Venue interval name, passed straight back to the adapter. */
  name: string;
  ms: number;
}

/** SPEC §6.1 tuning constants. */
export const PAD_BEFORE_RATIO = 0.15;
export const PAD_AFTER_RATIO = 0.05;
export const TARGET_FRAMES = 200;
/** Hyperliquid returns at most 5000 candles for an interval (SPEC §4.3). */
export const MAX_FRAMES = 5000;
/** Below this the replay "looks like a slideshow" (SPEC §6.1). */
export const MIN_FRAMES = 40;

export interface PickedInterval {
  interval: string;
  /** Bars this interval yields over the padded episode window. */
  count: number;
  /** True when no interval could reach MIN_FRAMES — the episode is simply too short. */
  belowMinimum: boolean;
  /** True when even the coarsest interval exceeds the venue cap. */
  aboveMaximum: boolean;
  /** Human-readable reason, present only when something must be surfaced in the UI. */
  warning?: string;
}

export interface PickIntervalOptions {
  /** UI override (SPEC §6.1: "Expose an interval override in the UI"). */
  override?: string;
  targetFrames?: number;
}

/**
 * Choose the venue interval whose bar count over the padded window sits closest to
 * `targetFrames`, subject to the venue cap and the readability floor. SPEC §6.1.
 */
export function pickInterval(
  durationMs: number,
  intervals: readonly IntervalSpec[],
  options: PickIntervalOptions = {},
): PickedInterval {
  const target = options.targetFrames ?? TARGET_FRAMES;
  const windowMs = Math.max(1, durationMs) * (1 + PAD_BEFORE_RATIO + PAD_AFTER_RATIO);
  const countFor = (iv: IntervalSpec): number => Math.max(1, Math.ceil(windowMs / iv.ms));

  if (options.override) {
    const chosen = intervals.find((iv) => iv.name === options.override);
    if (!chosen) {
      throw new Error(
        `Unknown interval "${options.override}". Available: ${intervals.map((i) => i.name).join(', ')}`,
      );
    }
    const count = countFor(chosen);
    return {
      interval: chosen.name,
      count,
      belowMinimum: count < MIN_FRAMES,
      aboveMaximum: count > MAX_FRAMES,
      ...(count > MAX_FRAMES
        ? { warning: `Interval override "${chosen.name}" yields ${count} bars, past the ${MAX_FRAMES}-bar venue limit.` }
        : {}),
    };
  }

  const candidates = intervals.map((iv) => ({ iv, count: countFor(iv) }));

  const eligible = candidates.filter((c) => c.count <= MAX_FRAMES && c.count >= MIN_FRAMES);
  if (eligible.length > 0) {
    const best = eligible.reduce((a, b) =>
      Math.abs(b.count - target) < Math.abs(a.count - target) ? b : a,
    );
    return { interval: best.iv.name, count: best.count, belowMinimum: false, aboveMaximum: false };
  }

  // Nothing satisfies both bounds. The venue cap is hard, the readability floor is not,
  // so honour the cap and take the finest interval that fits — then say so.
  const underCap = candidates.filter((c) => c.count <= MAX_FRAMES);
  if (underCap.length > 0) {
    const finest = underCap.reduce((a, b) => (b.count > a.count ? b : a));
    return {
      interval: finest.iv.name,
      count: finest.count,
      belowMinimum: true,
      aboveMaximum: false,
      warning:
        `Episode is too short for a smooth replay: only ${finest.count} bar(s) at ` +
        `${finest.iv.name}, the finest available resolution (fewer than ${MIN_FRAMES} frames).`,
    };
  }

  // Even the coarsest interval blows the cap — the series will be truncated by the venue.
  const coarsest = candidates.reduce((a, b) => (b.count < a.count ? b : a));
  return {
    interval: coarsest.iv.name,
    count: coarsest.count,
    belowMinimum: false,
    aboveMaximum: true,
    warning:
      `Episode spans ${coarsest.count} bars even at ${coarsest.iv.name}, past the ` +
      `${MAX_FRAMES}-bar venue limit. The series will be incomplete.`,
  };
}

/** SPEC §6.1: 15% context before the entry, 5% tail after the exit. */
export function seriesRangeFor(
  episode: Pick<PositionEpisode, 'openedAt' | 'closedAt'>,
  now: number,
): TimeRange {
  const end = episode.closedAt ?? now;
  const duration = Math.max(1, end - episode.openedAt);
  return {
    from: Math.floor(episode.openedAt - duration * PAD_BEFORE_RATIO),
    to: Math.ceil(end + duration * PAD_AFTER_RATIO),
  };
}

/** Bar open times and closing marks, flattened across the two PriceSeries shapes. */
function readSeries(series: PriceSeries): { times: number[]; marks: number[] } {
  if (series.kind === 'ohlcv') {
    return { times: series.candles.map((c) => c.t), marks: series.candles.map((c) => c.c) };
  }
  return { times: series.points.map((p) => p.t), marks: series.points.map((p) => p.p) };
}

/**
 * Build the full frame array for an episode. SPEC §6.2.
 *
 * Each frame `i` is the position state as of `series[i]`. The state is replayed from
 * `episode.steps` rather than re-folding the fills, so the frames cannot drift from
 * the reconstruction in episodes.ts.
 */
export function buildFrames(episode: PositionEpisode, series: PriceSeries): Frame[] {
  const { times, marks } = readSeries(series);
  if (times.length === 0) return [];

  const steps = episode.steps;
  const fundingEvents: readonly FundingEvent[] = [...episode.funding].sort((a, b) => a.ts - b.ts);

  let stepPtr = 0;
  let fundPtr = 0;

  let netSize = 0;
  let avgEntry = 0;
  let realized = 0;
  let fees = 0;
  let funding = 0;
  let bought = 0;
  let sold = 0;

  const frames: Frame[] = [];

  for (let i = 0; i < times.length; i++) {
    // The final bar absorbs everything still pending: a series that ends before the
    // episode does must still show the true end state, not a stale open position.
    const isFinal = i === times.length - 1;
    const barEnd = isFinal ? Number.POSITIVE_INFINITY : times[i + 1]!;

    const newFills: Fill[] = [];
    while (stepPtr < steps.length && steps[stepPtr]!.fill.ts < barEnd) {
      const step = steps[stepPtr]!;
      realized += step.realizedDelta;
      fees += step.feeDelta;
      netSize = step.netSizeAfter;
      avgEntry = step.avgEntryAfter;

      const notional = step.fill.price * step.sizeDelta;
      if (step.fill.side === 'buy') bought += notional;
      else sold += notional;

      if (newFills[newFills.length - 1]?.id !== step.fill.id) newFills.push(step.fill);
      stepPtr++;
    }

    while (fundPtr < fundingEvents.length && fundingEvents[fundPtr]!.ts < barEnd) {
      funding += fundingEvents[fundPtr]!.amount;
      fundPtr++;
    }

    const markPrice = marks[i]!;
    const unrealized = unrealizedFor(markPrice, avgEntry, netSize);

    frames.push({
      t: times[i]!,
      visibleUpTo: i,
      markPrice,
      netSize,
      avgEntry,
      realized,
      unrealized,
      fees,
      funding,
      totalPnl: totalPnl({ realized, unrealized, fees, funding }),
      holdingValue: Math.abs(netSize) * markPrice,
      bought,
      sold,
      newFills,
      isFinal,
    });
  }

  return frames;
}
