/**
 * Terminal formatting for the M1/M2 scripts.
 *
 * SPEC §7.3 asks for a terminal aesthetic, not a dashboard; the CLI follows the same
 * rule. Colour is applied only when stdout is a TTY so piped output stays clean.
 */

const useColor = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined;

const ESC = '\u001b';

const ansi = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const dim = ansi('2');
export const bold = ansi('1');
export const green = ansi('32');
export const red = ansi('31');
export const yellow = ansi('33');
export const cyan = ansi('36');

/** Colour a number by its sign — the one piece of signal worth colouring. */
export function signed(value: number, render: (n: number) => string = usd): string {
  const text = render(value);
  if (value > 0) return green(text);
  if (value < 0) return red(text);
  return text;
}

const usdFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function usd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${usdFormat.format(Math.abs(value))}`;
}

export function num(value: number, decimals = 4): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * A price, at whatever precision it actually has.
 *
 * A fixed decimal count prints a memecoin's 0.0000241 entry as "0", which reads as a
 * missing value rather than a small one — and CLAUDE.md is explicit that a number in
 * the output has to be the number. Significant figures scale instead: four decimals
 * for BTC, ten for SHIB.
 */
export function price(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0 || !Number.isFinite(magnitude)) return num(value);
  const decimals = magnitude >= 1 ? 4 : Math.min(12, Math.ceil(-Math.log10(magnitude)) + 4);
  return num(value, decimals);
}

export function date(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

export function duration(ms: number): string {
  if (ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export type Align = 'left' | 'right';

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Visible width, ignoring ANSI escapes so coloured cells still align. */
function width(s: string): number {
  return s.replace(ANSI_PATTERN, '').length;
}

function pad(s: string, to: number, align: Align): string {
  const gap = Math.max(0, to - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

export function table(headers: string[], rows: string[][], aligns: Align[] = []): string {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const alignOf = (i: number): Align => aligns[i] ?? 'left';

  const line = (cells: string[]) =>
    cells
      .map((c, i) => pad(c, widths[i]!, alignOf(i)))
      .join('  ')
      .trimEnd();

  const separator = widths.map((w) => '\u2500'.repeat(w)).join('\u2500\u2500');

  return [dim(line(headers)), dim(separator), ...rows.map(line)].join('\n');
}
