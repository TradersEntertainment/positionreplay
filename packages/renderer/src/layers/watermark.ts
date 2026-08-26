/** SPEC §7.1 layer 7: "small centered domain string at the top of the chart area". */

import { font, text } from '../helpers.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

export function drawWatermark(ctx: Canvas2D, c: LayerContext): void {
  if (!c.layout.watermark) return;
  const { plot, unit } = c.metrics;

  text(ctx, c.layout.watermark, (plot.x0 + plot.x1) / 2, plot.y0 + unit * 1.6, {
    color: c.theme.watermark,
    font: font(c.theme, unit * 2.2, 'bold'),
    align: 'center',
    baseline: 'top',
  });
}
