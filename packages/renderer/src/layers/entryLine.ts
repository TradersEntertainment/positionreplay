/**
 * SPEC §7.1 layer 3: dashed horizontal at avgEntry, with a pill label on the right
 * edge showing the price. "Redraws position as avg entry moves on scale-in."
 */

import { priceToY } from '../scale.js';
import { fillRect, font, priceLabel, strokeLine, text } from '../helpers.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

export function drawEntryLine(ctx: Canvas2D, c: LayerContext): void {
  const { frame, metrics, theme, scale } = c;
  // Before the position opens there is no entry to draw — and drawing one at 0 would
  // wrench the whole y-axis to the bottom of the chart.
  if (frame.avgEntry <= 0) return;

  const { plot, unit } = metrics;
  const y = priceToY(frame.avgEntry, scale, plot);
  if (y < plot.y0 - unit || y > plot.y1 + unit) return;

  strokeLine(ctx, plot.x0, y, plot.x1, y, theme.entryLine, Math.max(1, unit * 0.12), [
    unit * 0.9,
    unit * 0.9,
  ]);

  const label = priceLabel(frame.avgEntry);
  const fontSpec = font(theme, unit * 1.9);
  ctx.save();
  ctx.font = fontSpec;
  const textWidth = ctx.measureText(label).width;
  ctx.restore();

  const padX = unit * 0.8;
  const pillHeight = unit * 3;
  const pillWidth = textWidth + padX * 2;

  fillRect(ctx, plot.x1 + unit * 0.4, y - pillHeight / 2, pillWidth, pillHeight, theme.entryPill);
  text(ctx, label, plot.x1 + unit * 0.4 + padX, y, {
    color: theme.entryPillText,
    font: fontSpec,
    baseline: 'middle',
  });
}
