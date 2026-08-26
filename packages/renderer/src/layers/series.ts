/**
 * SPEC §7.1 layer 4: candles (kind:'ohlcv') or a filled area line (kind:'line'),
 * clipped to visibleUpTo.
 */

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

function drawCandles(ctx: Canvas2D, c: LayerContext, unit: number): void {
  if (c.series.kind !== 'ohlcv') return;
  const { plot } = c.metrics;
  const last = Math.min(c.frame.visibleUpTo, c.series.candles.length - 1);

  const slot = plot.width / Math.max(1, c.xDomain);
  const bodyWidth = Math.max(1, slot * 0.68);
  const wickWidth = Math.max(1, Math.min(bodyWidth * 0.18, unit * 0.16));

  for (let i = 0; i <= last; i++) {
    const candle = c.series.candles[i]!;
    const x = indexToX(i, c.xDomain, plot);
    const up = candle.c >= candle.o;
    const color = up ? c.theme.candleUp : c.theme.candleDown;

    const yHigh = priceToY(candle.h, c.scale, plot);
    const yLow = priceToY(candle.l, c.scale, plot);
    const yOpen = priceToY(candle.o, c.scale, plot);
    const yClose = priceToY(candle.c, c.scale, plot);

    ctx.fillStyle = color;
    ctx.fillRect(x - wickWidth / 2, yHigh, wickWidth, Math.max(wickWidth, yLow - yHigh));

    const top = Math.min(yOpen, yClose);
    // A doji still needs a visible mark, so floor the body height at the wick width.
    const height = Math.max(wickWidth, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
  }
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
