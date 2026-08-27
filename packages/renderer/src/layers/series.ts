/**
 * SPEC §7.1 layer 4: candles (kind:'ohlcv') or a filled area line (kind:'line'),
 * clipped to visibleUpTo.
 */

import { drawCandleSeries } from '../candles.js';
import { indexToX, priceToY } from '../scale.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

export function drawSeries(ctx: Canvas2D, c: LayerContext): void {
  const { plot, unit } = c.metrics;

  ctx.save();
  // Clip so a bar at the domain edge cannot bleed over the axis.
  ctx.beginPath();
  ctx.rect(plot.x0, plot.y0, plot.width, plot.height);
  ctx.clip();

  if (c.series.kind === 'ohlcv') drawCandles(ctx, c, unit);
  else drawLine(ctx, c);

  ctx.restore();
}

/**
 * The bars themselves live in candles.ts, shared with the builder's chart.
 *
 * One implementation, so a click on the picker lands on the same bar the replay draws.
 */
function drawCandles(ctx: Canvas2D, c: LayerContext, unit: number): void {
  if (c.series.kind !== 'ohlcv') return;

  drawCandleSeries(ctx, c.series.candles, {
    upTo: c.frame.visibleUpTo,
    xDomain: c.xDomain,
    scale: c.scale,
    plot: c.metrics.plot,
    unit,
    style: { up: c.theme.candleUp, down: c.theme.candleDown },
  });
}

function drawLine(ctx: Canvas2D, c: LayerContext): void {
  if (c.series.kind !== 'line') return;
  const { plot, unit } = c.metrics;
  const last = Math.min(c.frame.visibleUpTo, c.series.points.length - 1);
  if (last < 0) return;

  const pointAt = (i: number): { x: number; y: number } => ({
    x: indexToX(i, c.xDomain, plot),
    y: priceToY(c.series.kind === 'line' ? c.series.points[i]!.p : 0, c.scale, plot),
  });

  ctx.beginPath();
  ctx.moveTo(plot.x0, plot.y1);
  for (let i = 0; i <= last; i++) {
    const p = pointAt(i);
    ctx.lineTo(p.x, p.y);
  }
  ctx.lineTo(pointAt(last).x, plot.y1);
  ctx.closePath();
  ctx.fillStyle = c.theme.lineFill;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i <= last; i++) {
    const p = pointAt(i);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = c.theme.lineStroke;
  ctx.lineWidth = Math.max(1, unit * 0.18);
  ctx.stroke();
}
