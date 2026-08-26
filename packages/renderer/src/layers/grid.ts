/** SPEC §7.1 layer 2: horizontal price gridlines + right-side axis, x-axis date ticks. */

import { indexToX, priceToY } from '../scale.js';
import { axisDate, font, niceTicks, priceLabel, strokeLine, text } from '../helpers.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

export function drawGrid(ctx: Canvas2D, c: LayerContext): void {
  const { metrics, theme, scale } = c;
  const { plot, unit } = metrics;

  for (const value of niceTicks(scale.min, scale.max, 5)) {
    const y = priceToY(value, scale, plot);
    if (y < plot.y0 || y > plot.y1) continue;

    strokeLine(ctx, plot.x0, y, plot.x1, y, theme.grid, Math.max(1, unit * 0.08));
    text(ctx, priceLabel(value), plot.x1 + unit * 1.2, y, {
      color: theme.axisText,
      font: font(theme, unit * 1.9),
      baseline: 'middle',
    });
  }

  // Roughly one date tick per 18 units of width, so the axis never crowds.
  const tickCount = Math.max(2, Math.floor(plot.width / (unit * 18)));
  const step = Math.max(1, Math.floor(c.xDomain / tickCount));

  for (let i = 0; i <= c.xDomain; i += step) {
    const t = c.times[Math.min(i, c.times.length - 1)];
    if (t === undefined) continue;
    const x = indexToX(i, c.xDomain, plot);
    if (x > plot.x1) break;

    strokeLine(ctx, x, plot.y1, x, plot.y1 + unit * 0.8, theme.grid, Math.max(1, unit * 0.08));

    // A centred label at the first or last tick overhangs the canvas and gets clipped
    // ("31 Oct 10:00" rendering as "Oct 10:00"). Pin those two to the edges instead.
    const label = axisDate(t, c.spanMs);
    const labelFont = font(theme, unit * 1.8);
    ctx.save();
    ctx.font = labelFont;
    const half = ctx.measureText(label).width / 2;
    ctx.restore();

    const align = x - half < 0 ? 'left' : x + half > c.layout.width ? 'right' : 'center';
    const labelX = align === 'left' ? plot.x0 : align === 'right' ? c.layout.width - unit : x;

    text(ctx, label, labelX, plot.y1 + unit * 2.6, {
      color: theme.axisText,
      font: labelFont,
      align,
      baseline: 'top',
    });
  }
}
