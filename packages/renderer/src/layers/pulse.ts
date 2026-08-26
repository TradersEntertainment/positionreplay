/**
 * The chart's own reaction to PnL. SPEC §7.1 has no layer for this; it sits between
 * the series and the markers, and draws nothing at all unless the host supplies energy.
 *
 * SPEC §7.3 is the whole design brief: "no gradients, no rounded corners, no shadows.
 * It should look like a terminal, not a dashboard." So there is no glow and no bloom.
 * What there is: a bracket that snaps onto the plot edge at a new extreme, and tick
 * marks whose count follows momentum — the things a terminal can actually draw.
 *
 * Pure like every other layer, and driven by the frame's energy rather than by wall
 * time, so the exported MP4 shows the same reaction the preview did.
 */

import { flashStrength } from '../effects.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

export function drawPulse(ctx: Canvas2D, c: LayerContext): void {
  const energy = c.layout.energy;
  if (!energy) return;

  const { plot, unit } = c.metrics;
  const strength = flashStrength(energy.sinceExtreme);

  // Corner brackets on a new extreme. They mark the moment without covering the chart,
  // and they are four straight lines — nothing §7.3 rules out.
  if (strength > 0) {
    const color = energy.level >= 0.5 ? c.theme.pnlUp : c.theme.pnlDown;
    const arm = unit * 4;
    const inset = unit * 0.6;

    ctx.save();
    ctx.globalAlpha = strength;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, unit * 0.25);
    ctx.setLineDash([]);

    for (const [cx, cy, dx, dy] of [
      [plot.x0 + inset, plot.y0 + inset, 1, 1],
      [plot.x1 - inset, plot.y0 + inset, -1, 1],
      [plot.x0 + inset, plot.y1 - inset, 1, -1],
      [plot.x1 - inset, plot.y1 - inset, -1, -1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * arm);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * arm, cy);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawMomentumTicks(ctx, c, energy.momentum);
}

/**
 * A column of ticks up the right edge of the plot, counted by momentum.
 *
 * Counted, not scaled: the number of marks is the reading, which is legible at a
 * glance and at any resolution. A bar whose length varied would be a dashboard gauge,
 * which is the thing §7.3 says not to build.
 */
function drawMomentumTicks(ctx: Canvas2D, c: LayerContext, momentum: number): void {
  const { plot, unit } = c.metrics;
  const magnitude = Math.abs(momentum);
  const count = Math.round(magnitude * 6);
  if (count === 0) return;

  const rising = momentum > 0;
  const color = rising ? c.theme.pnlUp : c.theme.pnlDown;
  const x = plot.x1 - unit * 1.2;
  const mid = (plot.y0 + plot.y1) / 2;
  const step = unit * 1.5;

  ctx.save();
  // Held below full opacity on purpose: this is peripheral, and the candles are the
  // thing being read. At full strength it competes with them.
  ctx.globalAlpha = 0.35 + magnitude * 0.45;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, unit * 0.22);
  ctx.setLineDash([]);

  for (let i = 0; i < count; i++) {
    // Rising stacks upward from the middle, falling downward, so direction is legible
    // without colour — which matters for the ~8% of viewers who cannot rely on it.
    const y = mid + (rising ? -1 : 1) * (i + 1) * step;
    if (y < plot.y0 || y > plot.y1) break;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + unit * 0.9, y);
    ctx.stroke();
  }
  ctx.restore();
}
