/**
 * SPEC §7.1 layer 5: "a dot + label per fill (OPEN LONG $13.9M 5x). Fade-in over ~8
 * frames when new. Collision-avoid labels vertically."
 *
 * The reference label in SPEC carries a leverage suffix. Hyperliquid does not expose
 * historical leverage (§4.3), so it is appended only when the host supplies one — a
 * fabricated multiplier on an image people post as fact is exactly what CLAUDE.md
 * rules out.
 */

import { indexToX, priceToY } from '../scale.js';
import { compactUsd, font, text } from '../helpers.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext, MarkerInfo } from './context.js';

/** SPEC §7.1: "Fade-in over ~8 frames when new." */
export const FADE_FRAMES = 8;

interface Placed {
  marker: MarkerInfo;
  x: number;
  y: number;
  labelY: number;
  alpha: number;
  color: string;
  label: string;
}

function colorFor(action: string, theme: LayerContext['theme']): string {
  if (action === 'open' || action === 'scale_in') return theme.markerOpen;
  if (action === 'flip_out' || action === 'flip_in') return theme.markerFlip;
  return theme.markerClose;
}

function labelFor(marker: MarkerInfo, leverage: number | undefined): string {
  const verb =
    marker.action === 'open'
      ? 'OPEN'
      : marker.action === 'scale_in'
        ? 'ADD'
        : marker.action === 'reduce'
          ? 'TRIM'
          : marker.action === 'close'
            ? 'CLOSE'
            : 'FLIP';
  const side = marker.fill.side === 'buy' ? 'BUY' : 'SELL';
  const notional = compactUsd(marker.fill.price * marker.fill.size);
  const lev = leverage === undefined ? '' : ` ${leverage}x`;
  return `${verb} ${side} ${notional}${lev}`;
}

export function drawMarkers(ctx: Canvas2D, c: LayerContext): void {
  const { plot, unit } = c.metrics;
  const dotRadius = unit * 0.55;
  const labelFont = font(c.theme, unit * 1.7, 'bold');

  const placed: Placed[] = [];

  for (const marker of c.markers) {
    if (marker.barIndex > c.frame.visibleUpTo) continue;

    const age = c.frame.visibleUpTo - marker.barIndex;
    const alpha = Math.min(1, (age + 1) / FADE_FRAMES);

    const x = indexToX(marker.barIndex, c.xDomain, plot);
    const y = priceToY(marker.fill.price, c.scale, plot);
    if (x < plot.x0 - unit || x > plot.x1 + unit) continue;

    placed.push({
      marker,
      x,
      y,
      labelY: y,
      alpha,
      color: colorFor(marker.action, c.theme),
      label: labelFor(marker, c.layout.leverage),
    });
  }

  // Collision-avoid vertically: sort by y, then push each label below the previous one
  // if they would overlap. The dot stays on the true price; only the label moves.
  placed.sort((a, b) => a.y - b.y);
  const minGap = unit * 2.4;
  for (let i = 1; i < placed.length; i++) {
    const previous = placed[i - 1]!;
    const current = placed[i]!;
    if (current.labelY - previous.labelY < minGap) current.labelY = previous.labelY + minGap;
  }

  for (const p of placed) {
    ctx.save();
    ctx.globalAlpha = p.alpha;

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();

    // Flip the label to the left near the right edge so it never runs off-canvas.
    ctx.font = labelFont;
    const width = ctx.measureText(p.label).width;
    const toLeft = p.x + width + unit * 1.5 > plot.x1;
    // Clear the dot itself, not just its centre, or the glyphs sit under the marker.
    const gap = dotRadius + unit * 1.1;
    const labelX = toLeft ? p.x - gap : p.x + gap;

    // A leader line keeps a displaced label attached to its dot.
    if (Math.abs(p.labelY - p.y) > unit * 0.4) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1, unit * 0.07);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(labelX, p.labelY);
      ctx.stroke();
    }
    ctx.restore();

    // Flat backing plate: without it the candle wicks run straight through the text.
    const padX = unit * 0.5;
    const plateHeight = unit * 2.1;
    ctx.save();
    ctx.globalAlpha = p.alpha * 0.82;
    ctx.fillStyle = c.theme.background;
    ctx.fillRect(
      (toLeft ? labelX - width : labelX) - padX,
      p.labelY - plateHeight / 2,
      width + padX * 2,
      plateHeight,
    );
    ctx.restore();

    text(ctx, p.label, labelX, p.labelY, {
      color: p.color,
      font: labelFont,
      align: toLeft ? 'right' : 'left',
      baseline: 'middle',
      alpha: p.alpha,
    });
  }
}
