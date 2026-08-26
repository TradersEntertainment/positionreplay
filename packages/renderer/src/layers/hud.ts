/**
 * SPEC §7.1 layer 6.
 *
 * "top-left: instrument, address (truncated), direction + size. Top-right: total PnL,
 * huge, green/red. Bottom bar: BOUGHT / SOLD / FEES / REALIZED / UNREALIZED / HOLDING."
 *
 * CLAUDE.md: "No fabricated numbers in the HUD. If a value is unavailable (leverage)
 * or estimated (Perps funding), show it as unavailable or label it as an estimate.
 * These outputs get exported as images and posted as fact." So:
 *  - leverage is drawn only when the host supplied one; it is never derived;
 *  - a funding figure carries "(est)" when any contributing event is an estimate;
 *  - notices (truncated history, and so on) are drawn onto the image itself.
 */

import {
  compactSize,
  fitFontSize,
  font,
  hudDate,
  priceLabel,
  signedUsd,
  shortAddress,
  text,
  usd,
} from '../helpers.js';
import { blockMeter, flashStrength } from '../effects.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

/**
 * Green means gained, red means lost, and exactly zero means neither.
 * `>= 0` would paint a flat $0.00 the same green as a profit.
 */
function pnlColor(value: number, theme: LayerContext['theme']): string {
  if (value > 0) return theme.pnlUp;
  if (value < 0) return theme.pnlDown;
  return theme.hudText;
}

export function drawHud(ctx: Canvas2D, c: LayerContext): void {
  drawIdentity(ctx, c);
  drawTotalPnl(ctx, c);
  drawStatsBar(ctx, c);
  drawNotices(ctx, c);
}

function drawIdentity(ctx: Canvas2D, c: LayerContext): void {
  const { theme, metrics, episode, frame, layout } = c;
  const { unit, hud } = metrics;
  const x = metrics.plot.x0;

  text(ctx, episode.displayName, x, hud.top, {
    color: theme.hudText,
    font: font(theme, unit * 3.2, 'bold'),
    baseline: 'top',
  });

  const identity = [
    layout.address ? shortAddress(layout.address) : null,
    layout.interval ? `${layout.interval} bars` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('   ');

  if (identity) {
    text(ctx, identity, x, hud.top + hud.lineHeight, {
      color: theme.hudDim,
      font: font(theme, unit * 1.9),
      baseline: 'top',
    });
  }

  // Direction + size. Leverage appears only if the host supplied it.
  const direction = episode.direction === 'long' ? 'LONG' : 'SHORT';
  const isFlat = Math.abs(frame.netSize) < 1e-9;
  // "LONG 0.0000" is not a smaller position — it is no position, and it reads as a
  // rendering fault. The replay is flat at two very different moments, so they are
  // named differently: the lead-in before the entry, and after the exit.
  const closed = isFlat && episode.closedAt !== null && frame.t >= episode.closedAt;
  const pending = isFlat && frame.t < episode.openedAt;

  const parts = closed
    ? [`${direction} CLOSED`, `PEAK ${compactSize(episode.peakSize)}`, `@ ${priceLabel(episode.avgEntry)}`]
    : pending
      ? [`${direction} PENDING`]
      : [
          `${direction} ${compactSize(Math.abs(frame.netSize))}`,
          frame.avgEntry > 0 ? `@ ${priceLabel(frame.avgEntry)}` : null,
        ].filter((part): part is string => part !== null);

  if (layout.leverage !== undefined) parts.push(`${layout.leverage}x`);

  text(ctx, parts.join('  '), x, hud.top + hud.lineHeight * 2, {
    color: episode.direction === 'long' ? theme.pnlUp : theme.pnlDown,
    font: font(theme, unit * 2.2, 'bold'),
    baseline: 'top',
  });
}

function drawTotalPnl(ctx: Canvas2D, c: LayerContext): void {
  const { theme, metrics, frame, layout } = c;
  const { unit, hud } = metrics;
  const x = metrics.plot.x1 + metrics.axisWidth * 0.6;
  const energy = layout.energy;

  text(ctx, 'TOTAL PNL', x, hud.top, {
    color: theme.hudDim,
    font: font(theme, unit * 1.8),
    align: 'right',
    baseline: 'top',
  });

  const color = pnlColor(frame.totalPnl, theme);
  const value = signedUsd(frame.totalPnl);
  const valueY = hud.top + hud.lineHeight * 0.75;
  const valueFont = font(theme, unit * 5.2, 'bold');

  // A new extreme inverts the number: dark text on a solid block of its own colour.
  // SPEC §7.3 rules out a glow, and inverse video is what a terminal does instead —
  // it is also far more legible in a 3-second clip than a fade would be.
  const flash = energy ? flashStrength(energy.sinceExtreme) : 0;
  if (flash > 0 && energy && (energy.newHigh || energy.newLow || energy.sinceExtreme < 8)) {
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.font = valueFont;
    const width = ctx.measureText(value).width;
    const padX = unit * 0.6;
    ctx.fillStyle = color;
    ctx.fillRect(x - width - padX, valueY - unit * 0.5, width + padX * 2, unit * 6.2);
    ctx.restore();
  }

  text(ctx, value, x, valueY, {
    // Inverted while the flash is at full strength; the background block is the colour,
    // so the glyphs have to become the background to stay readable.
    color: flash >= 1 ? theme.background : color,
    font: valueFont,
    align: 'right',
    baseline: 'top',
  });

  // The meter under the number: where this PnL sits between the replay's own worst and
  // best. Block characters rather than a drawn bar, because §7.3 asks for a terminal
  // and because it then survives being scaled to any export size as text.
  if (energy) {
    text(ctx, blockMeter(energy.level, 12), x, hud.top + hud.lineHeight * 2.35, {
      color,
      font: font(theme, unit * 1.9, 'bold'),
      align: 'right',
      baseline: 'top',
    });
  }

  text(ctx, hudDate(frame.t), x, hud.top + hud.lineHeight * (energy ? 3.3 : 2.4), {
    color: theme.hudDim,
    font: font(theme, unit * 1.7),
    align: 'right',
    baseline: 'top',
  });
}

function drawStatsBar(ctx: Canvas2D, c: LayerContext): void {
  const { theme, metrics, frame, episode } = c;
  const { unit, bottomBar, plot } = metrics;

  // SPEC lists six cells; funding is added because it is a term of totalPnl, and a
  // bar whose numbers do not add up is worse than a longer bar.
  const fundingEstimated = episode.funding.some((f) => f.isEstimate);

  // Unknown is not zero. Polymarket Perps serves per-account funding only to an
  // authenticated session (SPEC §4.4.2); printing $0.00 would assert none was paid.
  const fundingUnavailable = c.layout.fundingUnavailable === true;

  const cells: [string, string, string][] = [
    ['BOUGHT', usd(frame.bought), theme.hudText],
    ['SOLD', usd(frame.sold), theme.hudText],
    ['FEES', usd(frame.fees), theme.hudText],
    fundingUnavailable
      ? ['FUNDING', '—', theme.hudDim]
      : [
          fundingEstimated ? 'FUNDING (EST)' : 'FUNDING',
          signedUsd(frame.funding),
          fundingEstimated ? theme.notice : pnlColor(frame.funding, theme),
        ],
    ['REALIZED', signedUsd(frame.realized), pnlColor(frame.realized, theme)],
    ['UNREALIZED', signedUsd(frame.unrealized), pnlColor(frame.unrealized, theme)],
    ['HOLDING', usd(frame.holdingValue), theme.hudText],
  ];

  const slot = plot.width / cells.length;
  const inner = slot - unit * 1.2;

  // One shared size across all cells, driven by the widest value. Fitting each cell
  // independently would render FEES larger than BOUGHT, which reads as emphasis.
  const valueSize = cells.reduce(
    (size, [, value]) => Math.min(size, fitFontSize(ctx, value, theme, unit * 2.3, inner, 'bold')),
    unit * 2.3,
  );
  const labelSize = cells.reduce(
    (size, [label]) => Math.min(size, fitFontSize(ctx, label, theme, unit * 1.6, inner)),
    unit * 1.6,
  );
  const valueFont = font(theme, valueSize, 'bold');
  const labelFont = font(theme, labelSize);

  cells.forEach(([label, value, color], index) => {
    const x = plot.x0 + slot * index;
    text(ctx, label, x, bottomBar.y0, {
      color: theme.hudDim,
      font: labelFont,
      baseline: 'top',
    });
    text(ctx, value, x, bottomBar.y0 + unit * 2.6, {
      color,
      font: valueFont,
      baseline: 'top',
    });
  });
}

/**
 * Warnings drawn onto the image itself. An export leaves this process and gets posted
 * as fact; a caveat that lived only in the web UI would not travel with it.
 *
 * Which is exactly why they have to stay readable: a notice that overruns the canvas or
 * overprints the stats row is barely better than no notice, and it corrupts the numbers
 * underneath it as well.
 */
function drawNotices(ctx: Canvas2D, c: LayerContext): void {
  const notices = c.layout.notices ?? [];
  if (notices.length === 0) return;

  const { unit, plot, bottomBar } = c.metrics;
  const lineHeight = unit * 1.9;
  const noticeFont = font(c.theme, unit * 1.5);

  // The band below the stats values, never into them.
  const top = bottomBar.y0 + unit * 6;
  const available = Math.max(lineHeight, c.layout.height - top);
  const capacity = Math.max(1, Math.floor(available / lineHeight));

  const shown = notices.slice(0, capacity);
  const hidden = notices.length - shown.length;
  // Never silently drop a caveat: say how many are not being shown.
  if (hidden > 0 && shown.length > 0) {
    shown[shown.length - 1] = `${shown[shown.length - 1]!} (+${hidden} more)`;
  }

  ctx.save();
  ctx.font = noticeFont;
  const lines = shown.map((notice) => ellipsize(ctx, `! ${notice}`, plot.width));
  ctx.restore();

  lines.forEach((line, index) => {
    text(ctx, line, plot.x0, top + lineHeight * index, {
      color: c.theme.notice,
      font: noticeFont,
      baseline: 'top',
    });
  });
}

/** Shorten to fit, with a binary search rather than a character-at-a-time walk. */
function ellipsize(ctx: Canvas2D, content: string, maxWidth: number): string {
  if (ctx.measureText(content).width <= maxWidth) return content;

  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${content.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${content.slice(0, low).trimEnd()}…`;
}
