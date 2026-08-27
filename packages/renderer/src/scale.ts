/**
 * Axis scaling and projection. SPEC.md §7.2 — "this is what makes it feel good".
 *
 * "Naive re-fit every frame = jittery garbage." The y-axis eases toward its target
 * instead of snapping, so a new high slides the chart rather than jolting it.
 */

import type { PriceSeries } from '@trade-replay/core';
import type { Metrics, RenderLayout } from './types.js';

export interface Bounds {
  min: number;
  max: number;
}

/**
 * The one mutable thing renderFrame touches. Passed in and stepped explicitly so the
 * function stays pure with respect to its output: same args, same pixels (SPEC §7).
 */
export interface ScaleState extends Bounds {
  /** False until the first step, which snaps rather than eases. */
  initialized: boolean;
}

/** SPEC §7.2: 8% padding around the visible data. */
export const BOUNDS_PADDING = 0.08;
/** SPEC §7.2: `scale.min += (target.min - scale.min) * 0.12`. */
export const EASING = 0.12;
/** Below this the first frames would render as one enormous bar. */
export const MIN_X_BARS = 24;

export function createScale(): ScaleState {
  return { min: 0, max: 0, initialized: false };
}

/**
 * High/low across the visible bars, widened by padding, the entry line and the fills.
 *
 * Fill prices are included for the same reason the entry line is, and it is not
 * hypothetical: a CSV's symbol maps to a Binance spot pair whose range need not
 * contain the prices the user actually traded at, and a marker outside the y-domain
 * is drawn outside the plot — over the HUD.
 */
export function computeBounds(
  series: PriceSeries,
  visibleUpTo: number,
  avgEntry: number | null,
  padding = BOUNDS_PADDING,
  fillPrices: readonly number[] = [],
): Bounds {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const last = Math.min(visibleUpTo, (series.kind === 'ohlcv' ? series.candles : series.points).length - 1);

  if (series.kind === 'ohlcv') {
    for (let i = 0; i <= last; i++) {
      const c = series.candles[i]!;
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
    }
  } else {
    for (let i = 0; i <= last; i++) {
      const p = series.points[i]!.p;
      if (p < min) min = p;
      if (p > max) max = p;
    }
  }

  // The entry line is the reference the whole replay is read against; letting it fall
  // off-screen on a big move would hide the most important number on the chart.
  if (avgEntry !== null && Number.isFinite(avgEntry)) {
    if (avgEntry < min) min = avgEntry;
    if (avgEntry > max) max = avgEntry;
  }

  for (const price of fillPrices) {
    if (!Number.isFinite(price)) continue;
    if (price < min) min = price;
    if (price > max) max = price;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };

  const span = max - min;
  // A flat series has zero span; pad relative to the price so it still renders.
  const pad = span > 0 ? span * padding : Math.max(Math.abs(max) * 0.01, 1e-6);
  return { min: min - pad, max: max + pad };
}

/** SPEC §7.2: exponential smoothing toward the target. */
export function stepScale(scale: ScaleState, target: Bounds, alpha = EASING): void {
  if (!scale.initialized) {
    // Easing up from zero would swing the entire chart on the first frame.
    scale.min = target.min;
    scale.max = target.max;
    scale.initialized = true;
    return;
  }
  scale.min += (target.min - scale.min) * alpha;
  scale.max += (target.max - scale.max) * alpha;
}

export interface Plot {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

export function priceToY(price: number, scale: Bounds, plot: Plot): number {
  const span = scale.max - scale.min;
  if (span <= 0) return plot.y0 + plot.height / 2;
  return plot.y1 - ((price - scale.min) / span) * plot.height;
}

export function indexToX(index: number, domainEnd: number, plot: Plot): number {
  if (domainEnd <= 0) return plot.x0;
  return plot.x0 + (index / domainEnd) * plot.width;
}

/**
 * `priceToY` backwards: what price is under this pixel.
 *
 * For the builder's chart, where a click has to become a price. Kept beside its forward
 * twin so the two cannot drift — a picker that disagreed with the renderer by a few
 * pixels would place trades slightly off the candle a person aimed at.
 *
 * A zero span means every price maps to the same row, so there is nothing to invert;
 * the midpoint is returned, matching what `priceToY` drew.
 */
export function yToPrice(y: number, scale: Bounds, plot: Plot): number {
  const span = scale.max - scale.min;
  if (span <= 0 || plot.height <= 0) return scale.min;
  return scale.min + ((plot.y1 - y) / plot.height) * span;
}

/**
 * `indexToX` backwards, as a fractional bar index.
 *
 * Fractional rather than rounded: the caller decides whether a click between two bars
 * belongs to the earlier or the nearer one, and rounding here would hide that choice.
 */
export function xToIndex(x: number, domainEnd: number, plot: Plot): number {
  if (domainEnd <= 0 || plot.width <= 0) return 0;
  return ((x - plot.x0) / plot.width) * domainEnd;
}

/**
 * SPEC §7.2: "(a) fixed full-episode x-domain from frame 0 (bars appear left→right
 * into empty space), or (b) growing domain (bars compress as they accumulate). Ship
 * (b) as default, (a) as an option."
 */
export function xDomainFor(
  mode: 'growing' | 'fixed' | undefined,
  visibleUpTo: number,
  totalBars: number,
): number {
  if (mode === 'fixed') return Math.max(1, totalBars);
  return Math.min(Math.max(visibleUpTo, MIN_X_BARS), Math.max(1, totalBars));
}

/**
 * All geometry as fractions of the canvas. SPEC §9: "Layout must be
 * resolution-independent — no hardcoded pixel positions, derive from
 * layout.width/height."
 */
export function computeMetrics(layout: RenderLayout): Metrics {
  const { width, height } = layout;
  const unit = Math.min(width, height) / 100;

  const axisWidth = unit * 8.5;
  const hudTop = unit * 4;
  const hudLineHeight = unit * 3.4;
  // Room for the instrument/address/direction block above the chart.
  const plotTop = hudTop + hudLineHeight * 3.2;
  const bottomBarHeight = unit * 9;
  const bottomBarY0 = height - bottomBarHeight - unit * 3;
  // Room for the x-axis date ticks between the plot and the stats bar. At unit*4.5 the
  // tick labels sat directly on the stats-bar headings.
  const plotBottom = bottomBarY0 - unit * 7;

  const x0 = unit * 4;
  const x1 = width - axisWidth - unit * 2;

  return {
    plot: {
      x0,
      y0: plotTop,
      x1,
      y1: plotBottom,
      width: x1 - x0,
      height: plotBottom - plotTop,
    },
    unit,
    hud: { top: hudTop, lineHeight: hudLineHeight },
    bottomBar: { y0: bottomBarY0, height: bottomBarHeight },
    axisWidth,
  };
}
