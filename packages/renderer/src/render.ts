/**
 * SPEC.md §7 — the architectural keystone.
 *
 *   renderFrame(ctx, frame, episode, series, scale, theme, layout): void
 *
 * Constraints, from SPEC §7 and CLAUDE.md, all enforced by the ESLint config on this
 * package and by the fact that M2 renders it under @napi-rs/canvas in plain Node:
 *
 *   - No DOM APIs. No `document`, no `window`, no CSS. Fonts are registered by the
 *     host (browser: `document.fonts.load`; node: `GlobalFonts.registerFromPath`).
 *   - No async. Everything needed is in the arguments.
 *   - Pure with respect to output: same args -> same pixels. `ScaleState` is the one
 *     mutable thing, passed in and stepped explicitly.
 *
 * Breaking any of these breaks M8, because the server render worker and the browser
 * preview stop being the same function.
 */

import type { Fill, Frame, PositionEpisode, PriceSeries } from '@trade-replay/core';
import { drawBackground } from './layers/background.js';
import { drawEntryLine } from './layers/entryLine.js';
import { drawGrid } from './layers/grid.js';
import { drawHud } from './layers/hud.js';
import { drawMarkers } from './layers/markers.js';
import { drawPulse } from './layers/pulse.js';
import { drawSeries } from './layers/series.js';
import { drawWatermark } from './layers/watermark.js';
import type { LayerContext, MarkerInfo } from './layers/context.js';
import { BOUNDS_PADDING, computeBounds, computeMetrics, stepScale, xDomainFor } from './scale.js';
import type { ScaleState } from './scale.js';
import type { Canvas2D, RenderLayout, Theme } from './types.js';

/** Bar open times, flattened across the two PriceSeries shapes. */
function timesOf(series: PriceSeries): number[] {
  return series.kind === 'ohlcv' ? series.candles.map((c) => c.t) : series.points.map((p) => p.t);
}

/** Total time the series covers, used only to choose axis label granularity. */
function spanMsOf(times: number[]): number {
  if (times.length < 2) return 60_000;
  return Math.max(1, times[times.length - 1]! - times[0]!);
}

/**
 * The series index each fill landed in.
 *
 * Recomputed per frame rather than cached: an episode has a handful of fills, and a
 * cache would be state that could disagree with the arguments — which is exactly the
 * purity guarantee this file exists to keep.
 */
function markersFor(episode: PositionEpisode, times: number[]): MarkerInfo[] {
  const markers: MarkerInfo[] = [];

  for (const step of episode.steps) {
    markers.push({ fill: step.fill, action: step.action, barIndex: barIndexFor(step.fill, times) });
  }

  return markers;
}

function barIndexFor(fill: Fill, times: number[]): number {
  if (times.length === 0) return 0;

  // Last bar whose open time is at or before the fill.
  let low = 0;
  let high = times.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= fill.ts) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export interface RenderOptions {
  /** SPEC §7.2 easing factor; exposed so the exporter can match the preview exactly. */
  easing?: number;
  /**
   * PnL-reactive effects (effects.ts). On by default.
   *
   * The switch exists so a caller can render the plain chart — a thumbnail, a
   * regression fixture — not so the export and the preview can differ. Turning it off
   * for one of them and not the other breaks SPEC §9's pixel identity.
   */
  effects?: boolean;
}

/**
 * Step the eased scale for one frame without drawing.
 *
 * The y-axis at frame N depends on every frame before it, so rendering frame N alone
 * requires replaying the easing up to it. Exported so a still render and a seek can
 * land on exactly the axis the animation would have shown — otherwise a jumped-to
 * frame is framed differently from the same frame reached by playing.
 */
export function advanceScale(
  scale: ScaleState,
  series: PriceSeries,
  frame: Frame,
  episode: PositionEpisode,
  easing?: number,
): void {
  stepScale(
    scale,
    computeBounds(
      series,
      frame.visibleUpTo,
      frame.avgEntry > 0 ? frame.avgEntry : null,
      BOUNDS_PADDING,
      visibleFillPrices(episode, frame),
    ),
    easing,
  );
}

/**
 * Prices of the fills that have already happened at this frame.
 *
 * Only the ones already drawn: widening the axis for a fill still in the future would
 * reveal where the position is about to go, which is the one thing a replay must not
 * do.
 */
function visibleFillPrices(episode: PositionEpisode, frame: Frame): number[] {
  const prices: number[] = [];
  for (const step of episode.steps) {
    if (step.fill.ts <= frame.t) prices.push(step.fill.price);
  }
  return prices;
}

export function renderFrame(
  ctx: Canvas2D,
  frame: Frame,
  episode: PositionEpisode,
  series: PriceSeries,
  scale: ScaleState,
  theme: Theme,
  layout: RenderLayout,
  options: RenderOptions = {},
): void {
  const metrics = computeMetrics(layout);
  const times = timesOf(series);
  const totalBars = times.length;

  // Step the scale before drawing so every layer shares one view of the axis.
  advanceScale(scale, series, frame, episode, options.easing);

  const context: LayerContext = {
    frame,
    episode,
    series,
    scale,
    theme,
    layout,
    metrics,
    xDomain: xDomainFor(layout.xMode, frame.visibleUpTo, totalBars),
    totalBars,
    times,
    spanMs: spanMsOf(times),
    markers: markersFor(episode, times),
  };

  // SPEC §7.1 draw order. Order is the layering.
  drawBackground(ctx, context);
  drawGrid(ctx, context);
  drawEntryLine(ctx, context);
  drawSeries(ctx, context);
  // Between the series and the markers: it reacts to the chart, and must not sit on
  // top of the fills, which are the thing being read.
  drawPulse(ctx, context);
  drawMarkers(ctx, context);
  drawHud(ctx, context);
  drawWatermark(ctx, context);
}
