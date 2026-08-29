/**
 * The last shot: the chart pulls back, dims, and a card states the result.
 *
 * This is the frame people screenshot, so it is held to the same standard as the HUD
 * and then some. CLAUDE.md: "No fabricated numbers in the HUD. These outputs get
 * exported as images and posted as fact." A card that prints a huge PnL with none of
 * the caveats the HUD carries would be a second, prettier place to state a number
 * without saying what is missing from it — so every caveat that applies is drawn here
 * too, underneath the number it qualifies.
 *
 * SPEC §7.3 still rules the look: the dim is one flat translucent fill, not a blur, and
 * the card is text on the background colour with no panel, no border radius and no
 * shadow. `ctx.filter` is deliberately absent from `Canvas2D` — its behaviour under
 * @napi-rs/canvas is not something to bet SPEC §9's pixel identity on.
 *
 * Two entry points, because the pull-back has to wrap the chart and the card has to sit
 * on top of it. `renderFrame` calls them either side of the existing draw order.
 */

import { fitFontSize, font, holdingTime, signedUsd, text } from '../helpers.js';
import { easeOutCubic } from '../outro.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

/** How far the chart shrinks by the end. Enough to read as a step back, not a zoom out. */
const PULLBACK = 0.86;

/** Opacity of the dim at full progress. Below this the huge PnL fights the candles. */
const DIM = 0.9;

/**
 * Fraction of the pull-back over which the dim reaches full strength.
 *
 * The dim leads the camera move on purpose: the card has to land on settled ground, and
 * a dim still deepening under a number that has already stopped moving reads as the
 * render catching up.
 */
const DIM_LEAD = 0.75;

/** Progress at which the card starts to appear, and at which it is fully opaque. */
const CARD_IN = 0.18;
const CARD_FULL = 0.62;

function progressOf(c: LayerContext): number | null {
  const raw = c.layout.outro;
  if (raw === undefined || !Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Shrink everything drawn after this call toward the centre of the canvas.
 *
 * Applied around the chart layers rather than inside them so no layer has to know the
 * ending exists — and so a layer added later is pulled back for free. The caller owns
 * the save/restore; this only sets the transform.
 */
export function outroPullback(ctx: Canvas2D, c: LayerContext): void {
  const p = progressOf(c);
  if (p === null) return;

  const factor = 1 - (1 - PULLBACK) * easeOutCubic(p);
  const cx = c.layout.width / 2;
  const cy = c.layout.height / 2;
  ctx.translate(cx, cy);
  ctx.scale(factor, factor);
  ctx.translate(-cx, -cy);
}

/**
 * The caveats that apply to the number on the card.
 *
 * Same rules as the stats bar, restated because the card restates the number: an
 * unavailable term is not zero, an estimate is not a measurement, and a typed position
 * is not a trade.
 */
function caveatsOf(c: LayerContext): string[] {
  const caveats: string[] = [];
  if (c.layout.constructed === true) caveats.push('CONSTRUCTED — NOT A REAL TRADE');
  if (c.layout.feesUnavailable === true) caveats.push('FEES UNAVAILABLE');
  if (c.layout.fundingUnavailable === true) caveats.push('FUNDING UNAVAILABLE');
  else if (c.episode.funding.some((f) => f.isEstimate)) caveats.push('FUNDING ESTIMATED');
  if (c.episode.closedAt === null) caveats.push('POSITION STILL OPEN');
  return caveats;
}

export function drawOutro(ctx: Canvas2D, c: LayerContext): void {
  const p = progressOf(c);
  if (p === null) return;

  const { theme, metrics, layout, frame, episode } = c;
  const { unit } = metrics;
  const eased = easeOutCubic(p);

  // One flat fill over everything, including the pulled-back edges, so the card sits on
  // an even ground rather than on a vignette.
  ctx.save();
  ctx.globalAlpha = DIM * Math.min(1, eased / DIM_LEAD);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.restore();

  const alpha = Math.min(1, Math.max(0, (p - CARD_IN) / (CARD_FULL - CARD_IN)));
  if (alpha <= 0) return;

  // An open position has been held right up to this frame; a closed one stopped when it
  // closed. Using the frame time for both would grow a finished trade's holding time
  // for as long as the outro runs.
  const heldMs = (episode.closedAt ?? frame.t) - episode.openedAt;
  const pnl = signedUsd(frame.totalPnl);
  const pnlColor =
    frame.totalPnl > 0 ? theme.pnlUp : frame.totalPnl < 0 ? theme.pnlDown : theme.hudText;

  const maxWidth = layout.width * 0.86;
  const pnlSize = fitFontSize(ctx, pnl, theme, unit * 12, maxWidth, 'bold', unit * 4);
  const caveats = caveatsOf(c);

  // Laid out as a stack measured from its own height, so the block stays centred
  // whatever it happens to contain.
  const rows: { gapBefore: number; height: number; draw: (y: number) => void }[] = [];

  rows.push({
    gapBefore: 0,
    height: unit * 2.4,
    draw: (y) =>
      text(ctx, `${episode.displayName}  ${episode.direction.toUpperCase()}`, layout.width / 2, y, {
        color: theme.hudDim,
        font: font(theme, unit * 2.4),
        align: 'center',
        baseline: 'top',
        alpha,
      }),
  });

  rows.push({
    gapBefore: unit * 4,
    height: unit * 2.2,
    draw: (y) =>
      text(ctx, 'TOTAL PNL', layout.width / 2, y, {
        color: theme.hudDim,
        font: font(theme, unit * 2.2),
        align: 'center',
        baseline: 'top',
        alpha,
      }),
  });

  rows.push({
    gapBefore: unit * 1.2,
    height: pnlSize,
    draw: (y) =>
      text(ctx, pnl, layout.width / 2, y, {
        color: pnlColor,
        font: font(theme, pnlSize, 'bold'),
        align: 'center',
        baseline: 'top',
        alpha,
      }),
  });

  rows.push({
    gapBefore: unit * 4,
    height: unit * 2.2,
    draw: (y) =>
      text(ctx, 'HOLDING TIME', layout.width / 2, y, {
        color: theme.hudDim,
        font: font(theme, unit * 2.2),
        align: 'center',
        baseline: 'top',
        alpha,
      }),
  });

  rows.push({
    gapBefore: unit * 1.2,
    height: unit * 5,
    draw: (y) =>
      text(ctx, holdingTime(heldMs), layout.width / 2, y, {
        color: theme.hudText,
        font: font(theme, unit * 5, 'bold'),
        align: 'center',
        baseline: 'top',
        alpha,
      }),
  });

  caveats.forEach((caveat, index) => {
    rows.push({
      gapBefore: index === 0 ? unit * 3.5 : unit * 0.8,
      height: unit * 2,
      draw: (y) =>
        text(ctx, caveat, layout.width / 2, y, {
          color: theme.notice,
          font: font(theme, unit * 2, 'bold'),
          align: 'center',
          baseline: 'top',
          alpha,
        }),
    });
  });

  const watermark = layout.watermark;
  if (watermark) {
    rows.push({
      gapBefore: unit * 5,
      height: unit * 3,
      draw: (y) =>
        text(ctx, watermark, layout.width / 2, y, {
          color: theme.hudDim,
          font: font(theme, unit * 3, 'bold'),
          align: 'center',
          baseline: 'top',
          alpha,
        }),
    });
  }

  const total = rows.reduce((sum, row) => sum + row.gapBefore + row.height, 0);
  let y = (layout.height - total) / 2;
  for (const row of rows) {
    y += row.gapBefore;
    row.draw(y);
    y += row.height;
  }
}
