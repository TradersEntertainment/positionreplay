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

function clamp(value: number, low: number, high: number): number {
  // A plot shorter than the margins would invert the bounds; centre rather than flip.
  if (high < low) return (low + high) / 2;
  return Math.min(high, Math.max(low, value));
}

interface Placed {
  marker: MarkerInfo;
  x: number;
  y: number;
  labelY: number;
  alpha: number;
  color: string;
  label: string;
  /** Forced exits are drawn larger, with a ring — colour alone is too subtle. */
  forced: boolean;
}

function colorFor(marker: MarkerInfo, theme: LayerContext['theme']): string {
  // A forced exit is not an ordinary close. SPEC §4.4.3 forbids collapsing the two,
  // and it is the frame a viewer is looking for.
  if (marker.fill.liquidation || marker.fill.adl) return theme.markerLiquidation;
  if (marker.action === 'open' || marker.action === 'scale_in') return theme.markerOpen;
  if (marker.action === 'flip_out' || marker.action === 'flip_in') return theme.markerFlip;
  return theme.markerClose;
}

function labelFor(marker: MarkerInfo, leverage: number | undefined): string {
  const verb = marker.fill.liquidation
    ? 'LIQUIDATED'
    : marker.fill.adl
      ? 'ADL'
      : marker.action === 'open'
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
      // The scale eases toward its target rather than snapping (SPEC §7.2), so for a
      // few frames after a fill lands outside the current range its label would be
      // drawn past the plot — over the HUD's stats bar or the PnL block. Clamping the
      // label (not the dot, which stays on the true price) keeps the chrome readable.
      labelY: clamp(y, plot.y0 + unit * 1.4, plot.y1 - unit * 1.4),
      alpha,
      color: colorFor(marker, c.theme),
      label: labelFor(marker, c.layout.leverage),
      forced: Boolean(marker.fill.liquidation || marker.fill.adl),
    });
  }

  // Collision-avoid vertically: sort by y, then push each label below the previous one
  // if they would overlap. The dot stays on the true price; only the label moves.
  placed.sort((a, b) => a.y - b.y);
  const minGap = unit * 2.4;
  const labelFloor = plot.y1 - unit * 1.4;
  for (let i = 1; i < placed.length; i++) {
    const previous = placed[i - 1]!;
    const current = placed[i]!;
    if (current.labelY - previous.labelY < minGap) current.labelY = previous.labelY + minGap;
  }
  // Pushing down can walk the last labels off the bottom; walk back up from there.
  for (let i = placed.length - 1; i >= 0; i--) {
    const current = placed[i]!;
    if (current.labelY > labelFloor) current.labelY = labelFloor;
    const next = placed[i + 1];
    if (next && next.labelY - current.labelY < minGap) current.labelY = next.labelY - minGap;
  }

  for (const p of placed) {
    ctx.save();
    ctx.globalAlpha = p.alpha;

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.forced ? dotRadius * 1.8 : dotRadius, 0, Math.PI * 2);
    ctx.fill();

    if (p.forced) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1, unit * 0.12);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotRadius * 3.2, 0, Math.PI * 2);
      ctx.stroke();
    }

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
