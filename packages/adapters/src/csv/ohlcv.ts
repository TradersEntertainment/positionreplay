/**
 * User-supplied OHLCV. SPEC §4.6:
 *
 *   "If mapping fails or the symbol is unknown, fall back to letting the user upload
 *    their own OHLCV CSV."
 *
 * This is the escape hatch for anything Binance does not list — a delisted pair, a
 * venue-specific perp, an equity. Same permissive parser as the trades file, and the
 * same refusal to guess: a bar it cannot read is reported, not interpolated.
 */

import type { CachedCandle } from '../types.js';
import { parseCsv, type CsvTable } from './parse.js';
import {
  parseNumber,
  parseTimestamp,
  sniffNumberFormat,
  sniffTimestampFormat,
  type NumberFormat,
  type TimestampFormat,
} from './mapping.js';

export class OhlcvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OhlcvError';
  }
}

const NAME_HINTS = {
  time: ['time', 'timestamp', 'date', 'datetime', 'opentime', 'ts', 'bucket'],
  open: ['open', 'o'],
  high: ['high', 'h', 'max'],
  low: ['low', 'l', 'min'],
  close: ['close', 'c', 'last', 'price'],
  volume: ['volume', 'vol', 'v', 'basevolume'],
} as const;

type OhlcvField = keyof typeof NAME_HINTS;

const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Locate the six columns.
 *
 * A header is matched by name; a headerless file falls back to positional order,
 * which for OHLCV is near-universal (time, open, high, low, close, volume) in a way
 * it is not for a trades export. Volume is optional — plenty of exports omit it, and
 * nothing in the renderer needs it.
 */
function locate(table: CsvTable): Record<OhlcvField, number | undefined> {
  const found: Partial<Record<OhlcvField, number>> = {};

  if (table.hasHeader) {
    const taken = new Set<number>();
    for (const field of Object.keys(NAME_HINTS) as OhlcvField[]) {
      const hints: readonly string[] = NAME_HINTS[field];
      const index = table.header.findIndex(
        (name, i) => !taken.has(i) && hints.includes(normalizeName(name)),
      );
      if (index !== -1) {
        found[field] = index;
        taken.add(index);
      }
    }
  }

  const positional: OhlcvField[] = ['time', 'open', 'high', 'low', 'close', 'volume'];
  positional.forEach((field, i) => {
    if (found[field] === undefined && i < table.header.length) found[field] = i;
  });

  return {
    time: found.time,
    open: found.open,
    high: found.high,
    low: found.low,
    close: found.close,
    volume: found.volume,
  };
}

export interface OhlcvResult {
  bars: CachedCandle[];
  timestampFormat: TimestampFormat;
  numberFormat: NumberFormat;
  /** 0-based row indices that could not be read. Reported, never interpolated. */
  skippedRows: number[];
}

export function parseOhlcvCsv(text: string): OhlcvResult {
  const table = parseCsv(text);
  const columns = locate(table);

  const missing = (['time', 'open', 'high', 'low', 'close'] as OhlcvField[]).filter(
    (f) => columns[f] === undefined,
  );
  if (missing.length > 0) {
    throw new OhlcvError(
      `This OHLCV file is missing ${missing.join(', ')}. Expected columns for time, ` +
        `open, high, low and close (volume is optional); found: ${table.header.join(', ')}.`,
    );
  }

  const at = (row: string[], field: OhlcvField): string => {
    const index = columns[field];
    return index === undefined ? '' : (row[index] ?? '');
  };

  const timeValues = table.rows.map((r) => at(r, 'time'));
  const timestampFormat = sniffTimestampFormat(timeValues);
  if (timestampFormat === null) {
    throw new OhlcvError(
      `The time column of this OHLCV file is not readable as ISO8601 or as an epoch ` +
        `in seconds or milliseconds. First value: "${timeValues[0] ?? ''}".`,
    );
  }

  const numberFormat = sniffNumberFormat(
    table.rows.flatMap((r) => [at(r, 'open'), at(r, 'high'), at(r, 'low'), at(r, 'close')]),
  );

  const bars: CachedCandle[] = [];
  const skippedRows: number[] = [];

  table.rows.forEach((row, index) => {
    const t = parseTimestamp(at(row, 'time'), timestampFormat);
    const o = parseNumber(at(row, 'open'), numberFormat);
    const h = parseNumber(at(row, 'high'), numberFormat);
    const l = parseNumber(at(row, 'low'), numberFormat);
    const c = parseNumber(at(row, 'close'), numberFormat);
    const v = parseNumber(at(row, 'volume'), numberFormat);

    if (t === null || o === null || h === null || l === null || c === null) {
      skippedRows.push(index);
      return;
    }
    // A bar whose high is below its low is a column-order mistake, not a market
    // event, and it would render as an inverted wick rather than as an error.
    if (h < l || h < o || h < c || l > o || l > c) {
      skippedRows.push(index);
      return;
    }

    bars.push({ t, o, h, l, c, v: v ?? 0 });
  });

  if (bars.length === 0) {
    throw new OhlcvError(
      `No row in this OHLCV file could be read (${skippedRows.length} rejected). Check ` +
        `that the columns are in time, open, high, low, close order.`,
    );
  }

  bars.sort((a, b) => a.t - b.t);
  return { bars, timestampFormat, numberFormat, skippedRows };
}
