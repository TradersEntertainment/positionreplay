/**
 * Pure formatting and drawing helpers shared by the layers.
 *
 * Every date here is formatted in UTC on purpose. SPEC §9's payoff is that server
 * output is pixel-identical to the browser preview; local-time labels would break
 * that the moment the render worker and the viewer sit in different zones.
 */

import type { Canvas2D, Theme } from './types.js';

export function font(theme: Theme, sizePx: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight === 'bold' ? 'bold ' : ''}${sizePx.toFixed(2)}px ${theme.fontFamily}`;
}

const usdFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function usd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${usdFormat.format(Math.abs(value))}`;
}

/** Signed, with an explicit + so a gain never reads as a bare number. */
export function signedUsd(value: number): string {
  return `${value > 0 ? '+' : ''}${usd(value)}`;
}

/** "$13.9M" / "$1.2K" — for markers, where the full number would not fit. */
export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Price labels adapt their precision to the magnitude: BTC needs 0dp, HYPE needs 3. */
export function priceLabel(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 0 : abs >= 10 ? 2 : abs >= 1 ? 3 : 5;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function compactSize(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return abs.toFixed(2);
  return abs.toFixed(4);
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Axis tick label, in UTC.
 *
 * Granularity follows the span on screen, not the bar interval: 30m bars across five
 * days still need a date, or every tick reads "14:30" and none of them says which day.
 */
export function axisDate(ts: number, spanMs: number): string {
  const d = new Date(ts);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const clock = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;

  if (spanMs >= 5 * DAY_MS) return day;
  if (spanMs >= 12 * HOUR_MS) return `${day} ${clock}`;
  return clock;
}

/**
 * How long a position was held, at the coarsest granularity that still says something.
 *
 * Two units, never three: "2D 03H" and "1H 05M" are read at a glance on a card, and
 * "2D 03H 41M 12S" is read by nobody. Uppercase for the same reason everything else
 * here is — SPEC §7.3 wants a terminal.
 */
export function holdingTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${days}D ${pad2(hours)}H`;
  if (hours > 0) return `${hours}H ${pad2(minutes)}M`;
  if (minutes > 0) return `${minutes}M ${pad2(seconds)}S`;
  return `${seconds}S`;
}

/** Full timestamp for the HUD, UTC so an exported image is unambiguous. */
export function hudDate(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
  );
}

/**
 * "Nice" gridline values (1/2/5 x 10^n) covering [min, max].
 * Round numbers on the axis are the difference between a chart and a readout.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];

  const rough = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  // Standard 1/2/5/10 thresholds. Rounding 1.08 up to 2 (rather than down to 1) is
  // what left a 5-unit price range with only two gridlines.
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;

  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

/** SPEC §7.3: no rounded corners, no shadows — a rect is a rect. */
export function fillRect(
  ctx: Canvas2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

export function strokeLine(
  ctx: Canvas2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  lineWidth: number,
  dash: number[] = [],
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

/**
 * Largest font size at or below `basePx` whose rendered text fits `maxWidth`.
 *
 * The stats bar divides the plot into equal slots; a wide value like $124,240.00 in a
 * narrow slot silently overprints its neighbour, which reads as a rendering bug and
 * misstates the numbers.
 */
export function fitFontSize(
  ctx: Canvas2D,
  content: string,
  theme: Theme,
  basePx: number,
  maxWidth: number,
  weight: 'normal' | 'bold' = 'normal',
  minPx = basePx * 0.5,
): number {
  ctx.save();
  ctx.font = font(theme, basePx, weight);
  const width = ctx.measureText(content).width;
  ctx.restore();

  if (width <= maxWidth || width <= 0) return basePx;
  return Math.max(minPx, (basePx * maxWidth) / width);
}

export function text(
  ctx: Canvas2D,
  content: string,
  x: number,
  y: number,
  options: {
    color: string;
    font: string;
    align?: 'left' | 'right' | 'center';
    baseline?: 'top' | 'middle' | 'alphabetic' | 'bottom';
    alpha?: number;
  },
): void {
  ctx.save();
  ctx.fillStyle = options.color;
  ctx.font = options.font;
  ctx.textAlign = options.align ?? 'left';
  ctx.textBaseline = options.baseline ?? 'alphabetic';
  if (options.alpha !== undefined) ctx.globalAlpha = options.alpha;
  ctx.fillText(content, x, y);
  ctx.restore();
}
