/**
 * Column mapping. SPEC §4.6:
 *
 *   "Accept a permissive CSV, map columns via a UI step (don't hard-require header
 *    names). Required: timestamp (ISO8601 or epoch s/ms — sniff it), symbol, side,
 *    price, size. Optional: fee, leverage, note."
 *
 * Two halves: `suggestMapping` guesses so the common export needs no clicks, and
 * `applyMapping` turns a confirmed mapping into `Fill[]`. The guess is never trusted
 * silently — the UI shows it, and every value it cannot read comes back as an issue
 * rather than as a zero.
 */

import type { Fill } from '@trade-replay/core';
import type { CsvTable } from './parse.js';

export const CSV_FIELDS = [
  'timestamp',
  'symbol',
  'side',
  'price',
  'size',
  'fee',
  'leverage',
  'note',
] as const;

export type CsvField = (typeof CSV_FIELDS)[number];

export const REQUIRED_FIELDS: readonly CsvField[] = ['timestamp', 'symbol', 'side', 'price', 'size'];

/**
 * How the timestamp column reads.
 *
 * Kept explicit rather than re-sniffed per row: a file whose first thousand rows are
 * epoch seconds and whose last is milliseconds is corrupt, and one decision per
 * column turns that into a visible error instead of a row silently landing in 1970.
 */
export type TimestampFormat = 'iso8601' | 'epoch_s' | 'epoch_ms';

/** Whether "1,5" means one-and-a-half or fifteen thousand. */
export type NumberFormat = 'dot' | 'comma';

export interface ColumnMapping {
  /** Field → 0-based column index. Absent means "not present in this file". */
  columns: Partial<Record<CsvField, number>>;
  timestampFormat: TimestampFormat;
  numberFormat: NumberFormat;
}

export interface MappingIssue {
  /** 0-based index into `table.rows`. */
  row: number;
  field: CsvField;
  value: string;
  reason: string;
}

export interface MappingResult {
  fills: Fill[];
  /** Rows dropped, and why. Never silently discarded — the UI lists these. */
  issues: MappingIssue[];
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

/* ------------------------------------------------------------------ guessing */

/** Header names seen in the wild, per field, matched case- and separator-insensitively. */
const NAME_HINTS: Record<CsvField, readonly string[]> = {
  timestamp: ['timestamp', 'time', 'date', 'datetime', 'ts', 'executedat', 'filledat', 'createdat'],
  symbol: ['symbol', 'market', 'instrument', 'pair', 'ticker', 'coin', 'asset', 'contract'],
  side: ['side', 'direction', 'type', 'action', 'buysell', 'orderside'],
  price: ['price', 'fillprice', 'executionprice', 'avgprice', 'averageprice', 'rate', 'px'],
  size: ['size', 'quantity', 'qty', 'amount', 'volume', 'filled', 'shares', 'contracts'],
  fee: ['fee', 'fees', 'commission', 'cost'],
  leverage: ['leverage', 'lev'],
  note: ['note', 'notes', 'comment', 'memo', 'tag'],
};

const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const SIDE_WORDS = new Set([
  'buy',
  'sell',
  'b',
  's',
  'long',
  'short',
  'bid',
  'ask',
  'openlong',
  'closelong',
  'openshort',
  'closeshort',
]);

const EPOCH_MS_MIN = Date.UTC(2000, 0, 1);
const EPOCH_MS_MAX = Date.UTC(2100, 0, 1);

/**
 * Which timestamp format a column is in.
 *
 * Range, not digit count: a 10-digit number is epoch seconds and a 13-digit one is
 * milliseconds, but the check that matters is that the result lands in a era when
 * these markets existed. A column that reads as neither returns null, and the caller
 * reports that rather than picking the closer of two wrong answers.
 */
export function sniffTimestampFormat(values: readonly string[]): TimestampFormat | null {
  const samples = values.filter((v) => v.trim() !== '').slice(0, 200);
  if (samples.length === 0) return null;

  const plausible = (ms: number): boolean => ms >= EPOCH_MS_MIN && ms <= EPOCH_MS_MAX;

  const numeric = samples.filter((v) => Number.isFinite(Number(v)));
  if (numeric.length === samples.length) {
    const asMs = numeric.map(Number);
    if (asMs.every(plausible)) return 'epoch_ms';
    if (asMs.every((n) => plausible(n * 1000))) return 'epoch_s';
    return null;
  }

  if (samples.every((v) => plausible(Date.parse(v)))) return 'iso8601';
  return null;
}

/**
 * Whether a numeric column uses a decimal comma.
 *
 * Only claimed when it is unambiguous: every sampled value must be digits, one
 * comma, then one to eight digits, and no dot anywhere. "1,234" is left as the
 * default, because thousands-grouping is at least as likely as a decimal comma and
 * guessing wrong scales every price by a thousand.
 */
export function sniffNumberFormat(values: readonly string[]): NumberFormat {
  const samples = values.filter((v) => v.trim() !== '').slice(0, 200);
  if (samples.length === 0) return 'dot';
  const decimalComma = /^-?\d+,\d{1,8}$/;
  const ambiguous = /^-?\d{1,3},\d{3}$/;
  const commaValues = samples.filter((v) => v.includes(','));
  if (commaValues.length === 0) return 'dot';
  if (samples.some((v) => v.includes('.'))) return 'dot';
  if (commaValues.every((v) => decimalComma.test(v.trim()) && !ambiguous.test(v.trim()))) {
    return 'comma';
  }
  return 'dot';
}

/** Digits with the punctuation a number may carry, and nothing else. */
const NUMBER_LIKE = /^[($+-]?\s*[\d.,\s ]+\s*\)?$/;

function isNumberLikeColumn(values: readonly string[]): boolean {
  const present = values.filter((v) => v.trim() !== '');
  return present.length > 0 && present.every((v) => NUMBER_LIKE.test(v.trim()));
}

export function suggestMapping(table: CsvTable): ColumnMapping {
  const columnValues = table.header.map((_, i) => table.rows.map((r) => r[i] ?? ''));
  const taken = new Set<number>();
  const columns: Partial<Record<CsvField, number>> = {};

  // Pass 1: exact header-name match, which is right whenever a header exists at all.
  if (table.hasHeader) {
    for (const field of CSV_FIELDS) {
      const hints = NAME_HINTS[field];
      const index = table.header.findIndex(
        (name, i) => !taken.has(i) && hints.includes(normalizeName(name)),
      );
      if (index !== -1) {
        columns[field] = index;
        taken.add(index);
      }
    }
    // Pass 2: substring, for "Fill Price (USD)" and friends.
    for (const field of CSV_FIELDS) {
      if (columns[field] !== undefined) continue;
      const hints = NAME_HINTS[field];
      const index = table.header.findIndex(
        (name, i) => !taken.has(i) && hints.some((h) => normalizeName(name).includes(h)),
      );
      if (index !== -1) {
        columns[field] = index;
        taken.add(index);
      }
    }
  }

  // Pass 3: by value shape, which is all there is on a headerless file.
  if (columns.timestamp === undefined) {
    const index = columnValues.findIndex(
      (values, i) => !taken.has(i) && sniffTimestampFormat(values) !== null,
    );
    if (index !== -1) {
      columns.timestamp = index;
      taken.add(index);
    }
  }
  if (columns.side === undefined) {
    const index = columnValues.findIndex(
      (values, i) =>
        !taken.has(i) &&
        values.length > 0 &&
        values.every((v) => v === '' || SIDE_WORDS.has(normalizeName(v))),
    );
    if (index !== -1) {
      columns.side = index;
      taken.add(index);
    }
  }

  const tsColumn = columns.timestamp;
  const timestampFormat =
    (tsColumn === undefined ? null : sniffTimestampFormat(columnValues[tsColumn] ?? [])) ??
    'epoch_ms';

  // Sniff the decimal separator across every column that holds only number-like
  // values. Deliberately not "the columns we mapped": the header names may be in a
  // language the hint list does not cover — which is precisely the file most likely
  // to use a decimal comma — and the separator still has to be right when the user
  // maps those columns by hand. Prose and ISO dates are excluded by the shape test,
  // so neither a note full of full stops nor a date can vote.
  const numericValues = columnValues.filter(isNumberLikeColumn).flat();

  return { columns, timestampFormat, numberFormat: sniffNumberFormat(numericValues) };
}

/* ------------------------------------------------------------------ applying */

export function parseTimestamp(raw: string, format: TimestampFormat): number | null {
  const value = raw.trim();
  if (value === '') return null;

  if (format === 'iso8601') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = format === 'epoch_s' ? n * 1000 : n;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

/**
 * A number as a spreadsheet wrote it.
 *
 * Currency symbols, thousands separators and a parenthesised negative all appear in
 * real exports. Anything left over after stripping those is a value we cannot read,
 * and it returns null rather than becoming NaN and then, one arithmetic step later,
 * a plausible-looking wrong total.
 */
export function parseNumber(raw: string, format: NumberFormat): number | null {
  let value = raw.trim();
  if (value === '') return null;

  let sign = 1;
  if (/^\(.*\)$/.test(value)) {
    sign = -1;
    value = value.slice(1, -1).trim();
  }

  // `\s` already matches U+00A0 and U+202F — the space characters European
  // exports use for thousands grouping — so no literal one belongs in the class.
  value = value.replace(/[$€£¥\s]/g, '');
  value = format === 'comma' ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '');

  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? sign * n : null;
}

const SIDE_MAP: Record<string, 'buy' | 'sell'> = {
  buy: 'buy',
  b: 'buy',
  long: 'buy',
  bid: 'buy',
  openlong: 'buy',
  closeshort: 'buy',
  sell: 'sell',
  s: 'sell',
  short: 'sell',
  ask: 'sell',
  openshort: 'sell',
  closelong: 'sell',
};

export function parseSide(raw: string): 'buy' | 'sell' | null {
  return SIDE_MAP[normalizeName(raw)] ?? null;
}

/**
 * Normalized instrument key for a CSV symbol.
 *
 * Upper-cased and stripped of the separators exports disagree about, so "btc-perp",
 * "BTC_PERP" and "BTC/PERP" are one instrument rather than three one-fill positions.
 */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s_/]+/g, '-');
}

export function missingRequired(mapping: ColumnMapping): CsvField[] {
  return REQUIRED_FIELDS.filter((f) => mapping.columns[f] === undefined);
}

export function applyMapping(table: CsvTable, mapping: ColumnMapping): MappingResult {
  const missing = missingRequired(mapping);
  if (missing.length > 0) {
    throw new MappingError(
      `These columns still need to be mapped: ${missing.join(', ')}. ` +
        `SPEC §4.6 requires timestamp, symbol, side, price and size.`,
    );
  }

  const at = (row: string[], field: CsvField): string => {
    const index = mapping.columns[field];
    return index === undefined ? '' : (row[index] ?? '');
  };

  const fills: Fill[] = [];
  const issues: MappingIssue[] = [];

  table.rows.forEach((row, index) => {
    const fail = (field: CsvField, value: string, reason: string): void => {
      issues.push({ row: index, field, value, reason });
    };

    const ts = parseTimestamp(at(row, 'timestamp'), mapping.timestampFormat);
    if (ts === null) {
      fail('timestamp', at(row, 'timestamp'), `not readable as ${mapping.timestampFormat}`);
      return;
    }

    const symbol = normalizeSymbol(at(row, 'symbol'));
    if (symbol === '') {
      fail('symbol', at(row, 'symbol'), 'empty');
      return;
    }

    const side = parseSide(at(row, 'side'));
    if (side === null) {
      fail('side', at(row, 'side'), 'not a recognised buy/sell value');
      return;
    }

    const price = parseNumber(at(row, 'price'), mapping.numberFormat);
    if (price === null || price <= 0) {
      fail('price', at(row, 'price'), price === null ? 'not a number' : 'must be positive');
      return;
    }

    const rawSize = parseNumber(at(row, 'size'), mapping.numberFormat);
    if (rawSize === null || rawSize === 0) {
      fail('size', at(row, 'size'), rawSize === null ? 'not a number' : 'must be non-zero');
      return;
    }
    // SPEC §4.2: size is absolute; the side column carries the direction. An export
    // that signs its size would otherwise double-count the direction.
    const size = Math.abs(rawSize);

    let fee = 0;
    if (mapping.columns.fee !== undefined) {
      const parsed = parseNumber(at(row, 'fee'), mapping.numberFormat);
      if (parsed === null && at(row, 'fee').trim() !== '') {
        fail('fee', at(row, 'fee'), 'not a number');
        return;
      }
      fee = parsed ?? 0;
    }

    const note = at(row, 'note').trim();

    fills.push({
      // Stable for a given document: the row index is what identifies this fill,
      // and a document is immutable once uploaded.
      id: `csv:${index}`,
      ts,
      instrument: symbol,
      displayName: symbol,
      side,
      price,
      size,
      fee,
      ...(note === '' ? {} : { dir: note }),
      raw: Object.fromEntries(table.header.map((name, i) => [name, row[i] ?? ''])),
    });
  });

  if (fills.length === 0) {
    throw new MappingError(
      `No row in this file could be read with that mapping (${issues.length} rejected). ` +
        `The first problem was: ${issues[0]?.field} "${issues[0]?.value}" — ${issues[0]?.reason}.`,
    );
  }

  return { fills, issues };
}
