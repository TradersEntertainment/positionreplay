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
  const { theme, metrics, frame } = c;
  const { unit, hud } = metrics;
  const x = metrics.plot.x1 + metrics.axisWidth * 0.6;

  text(ctx, 'TOTAL PNL', x, hud.top, {
    color: theme.hudDim,
    font: font(theme, unit * 1.8),
    align: 'right',
    baseline: 'top',
  });

  text(ctx, signedUsd(frame.totalPnl), x, hud.top + hud.lineHeight * 0.75, {
    color: pnlColor(frame.totalPnl, theme),
    font: font(theme, unit * 5.2, 'bold'),
    align: 'right',
    baseline: 'top',
  });

  text(ctx, hudDate(frame.t), x, hud.top + hud.lineHeight * 2.4, {
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
 */
function drawNotices(ctx: Canvas2D, c: LayerContext): void {
  const notices = c.layout.notices ?? [];
  if (notices.length === 0) return;

  const { unit, plot, bottomBar } = c.metrics;
  const lineHeight = unit * 2;
  const top = bottomBar.y0 + bottomBar.height - lineHeight * notices.length;

  notices.forEach((notice, index) => {
    text(ctx, `! ${notice}`, plot.x0, top + lineHeight * index, {
      color: c.theme.notice,
      font: font(c.theme, unit * 1.5),
      baseline: 'top',
    });
  });
}
