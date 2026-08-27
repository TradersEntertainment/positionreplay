'use client';

/**
 * The chart you click to place a trade.
 *
 * "I bought here, I sold there" is how people describe a position, and pointing at the
 * bar is a truer version of that than typing a timestamp. The form stays — it is how you
 * correct a click, and how you enter a size — but this is the way in.
 *
 * The bars come from `drawCandleSeries`, the same function the replay renderer uses, so
 * what you click is exactly what plays back. A second implementation would drift, and a
 * picker whose candles sat a pixel from the renderer's would place trades slightly off
 * the bar someone aimed at.
 *
 * A click is snapped in both axes, for the same reason:
 *
 *  - **x to the nearest bar.** The data has bar granularity; pretending to minute
 *    precision inside an hourly candle would be inventing a timestamp.
 *  - **y into that bar's low–high range**, at the market's own scale. You cannot have
 *    filled at a price the market never reached in that hour. This is the same rule
 *    `estimateRows` uses when it works the other way round, and keeping them identical is
 *    what stops the two halves of the builder from disagreeing. The arithmetic is in
 *    lib/price.ts, where the order of rounding and clamping is the whole subtlety.
 */

import { drawCandleSeries, darkTheme, xToIndex, yToPrice, priceToY, indexToX } from '@trade-replay/renderer';
import type { Canvas2D } from '@trade-replay/renderer';
import type { Candle } from '@trade-replay/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { priceDigits, priceOnBar } from '@/lib/price';

export interface PickerLeg {
  ts: number;
  price: number;
  side: 'buy' | 'sell';
}

export interface CandlePickerProps {
  candles: readonly Candle[];
  legs: readonly PickerLeg[];
  onPick: (ts: number, price: number) => void;
  /** What the next click will place, so the crosshair can say so. */
  nextSide: 'buy' | 'sell';
}

/** Room on the right for price labels and at the bottom for dates. */
const AXIS_W = 62;
const AXIS_H = 20;
const PAD = 8;

/** Vertical breathing room above the high and below the low, as a fraction of range. */
const PADDING = 0.06;

function plotOf(width: number, height: number) {
  const x0 = PAD;
  const x1 = Math.max(x0 + 1, width - AXIS_W);
  const y0 = PAD;
  const y1 = Math.max(y0 + 1, height - AXIS_H);
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

function boundsOf(candles: readonly Candle[]): { min: number; max: number } {
  if (candles.length === 0) return { min: 0, max: 1 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (candle.l < min) min = candle.l;
    if (candle.h > max) max = candle.h;
  }
  // A market that never moved would give a zero span, which every scale helper treats as
  // "draw everything at the midpoint" — legible, but not clickable. Widen it.
  if (max - min < 1e-9) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * PADDING;
  return { min: min - pad, max: max + pad };
}

function fmtPrice(value: number): string {
  const digits = priceDigits(value);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtTime(ts: number): string {
  return `${new Date(ts).toISOString().slice(5, 16).replace('T', ' ')}`;
}

export function CandlePicker({ candles, legs, onPick, nextSide }: CandlePickerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ ts: number; price: number; x: number; y: number } | null>(
    null,
  );

  /**
   * A pointer position to the bar and price it means.
   *
   * Null outside the plot or with no candles, so every caller handles "nothing here"
   * once rather than each guessing.
   */
  const resolve = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas || candles.length === 0) return null;

      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const plot = plotOf(rect.width, rect.height);
      if (x < plot.x0 || x > plot.x1 || y < plot.y0 || y > plot.y1) return null;

      const domain = Math.max(1, candles.length - 1);
      const index = Math.max(
        0,
        Math.min(candles.length - 1, Math.round(xToIndex(x, domain, plot))),
      );
      const candle = candles[index]!;

      // Inside the bar and at the market's own scale — the order matters, see
      // lib/price.ts.
      const price = priceOnBar(yToPrice(y, boundsOf(candles), plot), candle.l, candle.h);

      return { ts: candle.t, price, x: indexToX(index, domain, plot), y };
    },
    [candles],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = context as unknown as Canvas2D;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const plot = plotOf(rect.width, rect.height);
    const scale = boundsOf(candles);
    const domain = Math.max(1, candles.length - 1);
    const unit = Math.min(rect.width, rect.height) / 100;

    ctx.fillStyle = darkTheme.background;
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (candles.length === 0) {
      ctx.fillStyle = darkTheme.hudDim;
      ctx.font = `12px ${darkTheme.fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No candles for this market', rect.width / 2, rect.height / 2);
      return;
    }

    // Four gridlines with their prices, enough to read a level off without competing
    // with the candles (SPEC §7.3: a terminal, not a dashboard).
    ctx.font = `11px ${darkTheme.fontFamily}`;
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const price = scale.min + ((scale.max - scale.min) * i) / 4;
      const y = priceToY(price, scale, plot);
      ctx.fillStyle = darkTheme.grid;
      ctx.fillRect(plot.x0, y, plot.width, 1);
      ctx.fillStyle = darkTheme.hudDim;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(price), plot.x1 + 6, y);
    }

    // Dates along the bottom, at the ends and the middle.
    ctx.textBaseline = 'top';
    for (const at of [0, Math.floor(domain / 2), domain]) {
      const candle = candles[at];
      if (!candle) continue;
      ctx.fillStyle = darkTheme.hudDim;
      ctx.textAlign = at === 0 ? 'left' : at === domain ? 'right' : 'center';
      ctx.fillText(fmtTime(candle.t), indexToX(at, domain, plot), plot.y1 + 4);
    }

    drawCandleSeries(ctx, candles, {
      upTo: candles.length - 1,
      xDomain: domain,
      scale,
      plot,
      unit,
      style: { up: darkTheme.candleUp, down: darkTheme.candleDown },
    });

    // Placed legs, on top of the bars they sit on.
    for (const leg of legs) {
      const index = candles.findIndex((candle) => candle.t >= leg.ts);
      const x = indexToX(index < 0 ? domain : index, domain, plot);
      const y = priceToY(leg.price, scale, plot);
      const colour = leg.side === 'buy' ? darkTheme.markerOpen : darkTheme.markerClose;

      ctx.fillStyle = colour;
      // A full-height hairline, so a marker is findable even where bars are dense.
      ctx.fillRect(x, plot.y0, 1, plot.height);
      ctx.fillRect(x - 4, y - 4, 8, 8);

      ctx.font = `bold 10px ${darkTheme.fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(leg.side === 'buy' ? 'BUY' : 'SELL', x + 6, y - 4);
    }

    // Crosshair, and what a click would place.
    if (hover) {
      ctx.fillStyle = darkTheme.hudDim;
      ctx.fillRect(hover.x, plot.y0, 1, plot.height);
      ctx.fillRect(plot.x0, hover.y, plot.width, 1);

      const label = `${nextSide.toUpperCase()} @ ${fmtPrice(hover.price)}  ${fmtTime(hover.ts)}`;
      ctx.font = `11px ${darkTheme.fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const w = ctx.measureText(label).width;
      const lx = Math.min(hover.x + 8, plot.x1 - w - 4);
      ctx.fillStyle = darkTheme.background;
      ctx.fillRect(lx - 3, plot.y0 + 2, w + 6, 16);
      ctx.fillStyle = nextSide === 'buy' ? darkTheme.markerOpen : darkTheme.markerClose;
      ctx.fillText(label, lx, plot.y0 + 4);
    }
  }, [candles, legs, hover, nextSide]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div className="space-y-1">
      <canvas
        ref={canvasRef}
        data-testid="candle-picker"
        data-candles={candles.length}
        className="block h-64 w-full cursor-crosshair border border-tr-line"
        onMouseMove={(e) => setHover(resolve(e.clientX, e.clientY))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const hit = resolve(e.clientX, e.clientY);
          if (hit) onPick(hit.ts, hit.price);
        }}
      />
      <p className="text-xs text-tr-dim">
        Click the chart to place a {nextSide === 'buy' ? 'buy' : 'sell'}. The time snaps to
        the bar and the price to that bar&apos;s range — you cannot fill where the market
        never traded.
      </p>
    </div>
  );
}
