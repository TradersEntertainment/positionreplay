/**
 * Candlesticks, drawn once.
 *
 * Pulled out of SPEC §7.1's series layer so the builder's chart — where you click to
 * place a trade — draws exactly the same bars the replay does. Two implementations would
 * drift, and a picker whose candles sat a pixel from the renderer's would place trades
 * slightly off the bar someone aimed at.
 *
 * Pure and host-agnostic like everything else here: no DOM, no theme object, just the
 * two colours and the geometry it is handed.
 */

import type { Candle } from '@trade-replay/core';
import type { Bounds, Plot } from './scale.js';
import { indexToX, priceToY } from './scale.js';
import type { Canvas2D } from './types.js';

export interface CandleStyle {
  up: string;
  down: string;
}

export interface CandleGeometry {
  /** Last bar to draw, inclusive. SPEC §7.1 clips the series to the current frame. */
  upTo: number;
  /** Bars the x-axis spans; see `xDomainFor`. */
  xDomain: number;
  scale: Bounds;
  plot: Plot;
  /** Base unit for sizing, so one bar looks right at 1080px and at 400px. */
  unit: number;
  style: CandleStyle;
}

export function drawCandleSeries(
  ctx: Canvas2D,
  candles: readonly Candle[],
  geometry: CandleGeometry,
): void {
  const { upTo, xDomain, scale, plot, unit, style } = geometry;
  const last = Math.min(upTo, candles.length - 1);

  const slot = plot.width / Math.max(1, xDomain);
  const bodyWidth = Math.max(1, slot * 0.68);
  const wickWidth = Math.max(1, Math.min(bodyWidth * 0.18, unit * 0.16));

  for (let i = 0; i <= last; i++) {
    const candle = candles[i]!;
    const x = indexToX(i, xDomain, plot);
    const up = candle.c >= candle.o;

    const yHigh = priceToY(candle.h, scale, plot);
    const yLow = priceToY(candle.l, scale, plot);
    const yOpen = priceToY(candle.o, scale, plot);
    const yClose = priceToY(candle.c, scale, plot);

    ctx.fillStyle = up ? style.up : style.down;
    ctx.fillRect(x - wickWidth / 2, yHigh, wickWidth, Math.max(wickWidth, yLow - yHigh));

    const top = Math.min(yOpen, yClose);
    // A doji still needs a visible mark, so floor the body height at the wick width.
    const height = Math.max(wickWidth, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
  }
}
