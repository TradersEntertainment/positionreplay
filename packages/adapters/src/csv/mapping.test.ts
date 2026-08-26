import { describe, expect, it } from 'vitest';
import { parseCsv } from './parse.js';
import {
  applyMapping,
  MappingError,
  missingRequired,
  normalizeSymbol,
  parseNumber,
  parseSide,
  parseTimestamp,
  sniffNumberFormat,
  sniffTimestampFormat,
  suggestMapping,
  type ColumnMapping,
} from './mapping.js';

const MS = (iso: string): number => Date.parse(iso);

describe('sniffTimestampFormat', () => {
  it('reads epoch milliseconds', () => {
    expect(sniffTimestampFormat(['1762387200000', '1762390800000'])).toBe('epoch_ms');
  });

  it('reads epoch seconds', () => {
    expect(sniffTimestampFormat(['1762387200', '1762390800'])).toBe('epoch_s');
  });

  it('reads ISO8601', () => {
    expect(sniffTimestampFormat(['2025-11-06T00:00:00Z', '2025-11-06T01:00:00Z'])).toBe('iso8601');
  });

  it('returns null rather than guessing at an implausible number', () => {
    // 42 is neither seconds nor milliseconds in any era these markets existed.
    expect(sniffTimestampFormat(['42', '43'])).toBeNull();
  });

  it('returns null on an unparseable column', () => {
    expect(sniffTimestampFormat(['yesterday', 'today'])).toBeNull();
  });
});

describe('sniffNumberFormat', () => {
  it('defaults to a decimal dot', () => {
    expect(sniffNumberFormat(['92000.5', '93000.25'])).toBe('dot');
  });

  it('detects a decimal comma', () => {
    expect(sniffNumberFormat(['92000,5', '93000,25'])).toBe('comma');
  });

  it('leaves thousands-grouped values alone', () => {
    // "1,234" is far more likely to be twelve hundred than one-point-two.
    expect(sniffNumberFormat(['1,234', '5,678'])).toBe('dot');
  });

  it('does not claim comma when dots are also present', () => {
    expect(sniffNumberFormat(['1,234.56', '92,000.10'])).toBe('dot');
  });
});

describe('parseNumber', () => {
  it('strips a currency symbol and thousands separators', () => {
    expect(parseNumber('$1,234.56', 'dot')).toBe(1234.56);
  });

  it('reads a parenthesised negative as negative', () => {
    expect(parseNumber('(18.40)', 'dot')).toBe(-18.4);
  });

  it('reads a decimal comma when told to', () => {
    expect(parseNumber('1.234,56', 'comma')).toBe(1234.56);
  });

  it('returns null for text rather than NaN', () => {
    expect(parseNumber('n/a', 'dot')).toBeNull();
  });

  it('returns null for a blank cell', () => {
    expect(parseNumber('   ', 'dot')).toBeNull();
  });
});

describe('parseSide', () => {
  it.each([
    ['buy', 'buy'],
    ['BUY', 'buy'],
    ['b', 'buy'],
    ['Long', 'buy'],
    ['Open Long', 'buy'],
    ['Close Short', 'buy'],
    ['sell', 'sell'],
    ['S', 'sell'],
    ['short', 'sell'],
    ['Close Long', 'sell'],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseSide(raw)).toBe(expected);
  });

  it('returns null for an unknown word instead of defaulting to buy', () => {
    expect(parseSide('flatten')).toBeNull();
  });
});

describe('normalizeSymbol', () => {
  it.each(['btc-perp', 'BTC_PERP', 'BTC/PERP', ' btc perp '])('folds %s', (raw) => {
    expect(normalizeSymbol(raw)).toBe('BTC-PERP');
  });
});

describe('parseTimestamp', () => {
  it('scales epoch seconds to milliseconds', () => {
    expect(parseTimestamp('1762387200', 'epoch_s')).toBe(1762387200000);
  });

  it('parses an ISO string with an offset', () => {
    expect(parseTimestamp('2025-11-06T01:00:00+01:00', 'iso8601')).toBe(MS('2025-11-06T00:00:00Z'));
  });

  it('returns null for a value in the wrong format', () => {
    expect(parseTimestamp('not a date', 'iso8601')).toBeNull();
  });
});

describe('suggestMapping', () => {
  it('maps a conventional header with no clicks', () => {
    const table = parseCsv(
      ['timestamp,symbol,side,price,size,fee', '1762387200000,BTC,buy,92000,0.5,18.4'].join('\n'),
    );
    const mapping = suggestMapping(table);
    expect(mapping.columns).toEqual({
      timestamp: 0,
      symbol: 1,
      side: 2,
      price: 3,
      size: 4,
      fee: 5,
    });
    expect(missingRequired(mapping)).toEqual([]);
  });

  it('matches decorated header names by substring', () => {
    const table = parseCsv(
      ['Filled At,Market,Order Side,Fill Price (USD),Quantity', '1762387200000,BTC,buy,92000,0.5'].join(
        '\n',
      ),
    );
    expect(missingRequired(suggestMapping(table))).toEqual([]);
  });

  it('never assigns one column to two fields', () => {
    // "Amount" hints at size; it must not also be taken as fee.
    const table = parseCsv(['time,coin,side,price,amount', '1762387200000,BTC,buy,92000,0.5'].join('\n'));
    const mapping = suggestMapping(table);
    const used = Object.values(mapping.columns);
    expect(new Set(used).size).toBe(used.length);
  });

  it('finds timestamp and side by value shape on a headerless file', () => {
    const table = parseCsv('1762387200000,BTC,buy,92000,0.5');
    const mapping = suggestMapping(table);
    expect(mapping.columns.timestamp).toBe(0);
    expect(mapping.columns.side).toBe(2);
    // Price and size are indistinguishable by shape; the user picks them.
    expect(missingRequired(mapping)).toEqual(expect.arrayContaining(['symbol', 'price', 'size']));
  });

  it('carries the sniffed timestamp format', () => {
    const table = parseCsv(['time,symbol,side,price,size', '2025-11-06T00:00:00Z,BTC,buy,92000,0.5'].join('\n'));
    expect(suggestMapping(table).timestampFormat).toBe('iso8601');
  });

  it('does not let a date column vote on the decimal separator', () => {
    const table = parseCsv(
      ['date,symbol,side,price,size', '2025-11-06T00:00:00Z,BTC,buy,92000.50,0.5'].join('\n'),
    );
    expect(suggestMapping(table).numberFormat).toBe('dot');
  });
});

const BASIC = parseCsv(
  [
    'timestamp,symbol,side,price,size,fee',
    '1762387200000,BTC,buy,92000,0.5,18.4',
    '1762390800000,BTC,sell,93000,0.5,18.6',
  ].join('\n'),
);

describe('applyMapping', () => {
  it('produces core Fills', () => {
    const { fills, issues } = applyMapping(BASIC, suggestMapping(BASIC));
    expect(issues).toEqual([]);
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      id: 'csv:0',
      ts: 1762387200000,
      instrument: 'BTC',
      side: 'buy',
      price: 92000,
      size: 0.5,
      fee: 18.4,
    });
  });

  it('keeps the original row in `raw` for debugging', () => {
    const { fills } = applyMapping(BASIC, suggestMapping(BASIC));
    expect(fills[0]?.raw).toMatchObject({ symbol: 'BTC', price: '92000' });
  });

  it('defaults fee to zero when no fee column was mapped', () => {
    const table = parseCsv(['timestamp,symbol,side,price,size', '1762387200000,BTC,buy,92000,0.5'].join('\n'));
    const { fills } = applyMapping(table, suggestMapping(table));
    expect(fills[0]?.fee).toBe(0);
  });

  it('takes the absolute value of a signed size, since side carries direction', () => {
    const table = parseCsv(
      ['timestamp,symbol,side,price,size', '1762387200000,BTC,sell,92000,-0.5'].join('\n'),
    );
    const { fills } = applyMapping(table, suggestMapping(table));
    expect(fills[0]?.size).toBe(0.5);
    expect(fills[0]?.side).toBe('sell');
  });

  it('rejects a bad row and reports it rather than dropping it silently', () => {
    const table = parseCsv(
      [
        'timestamp,symbol,side,price,size',
        '1762387200000,BTC,buy,92000,0.5',
        '1762390800000,BTC,flatten,93000,0.5',
      ].join('\n'),
    );
    const { fills, issues } = applyMapping(table, suggestMapping(table));
    expect(fills).toHaveLength(1);
    expect(issues).toEqual([
      { row: 1, field: 'side', value: 'flatten', reason: 'not a recognised buy/sell value' },
    ]);
  });

  it('rejects a zero price rather than reconstructing against it', () => {
    const table = parseCsv(['timestamp,symbol,side,price,size', '1762387200000,BTC,buy,0,0.5'].join('\n'));
    expect(() => applyMapping(table, suggestMapping(table))).toThrow(/must be positive/);
  });

  it('names the unmapped fields instead of guessing', () => {
    const mapping: ColumnMapping = {
      columns: { timestamp: 0, symbol: 1 },
      timestampFormat: 'epoch_ms',
      numberFormat: 'dot',
    };
    expect(() => applyMapping(BASIC, mapping)).toThrow(MappingError);
    expect(() => applyMapping(BASIC, mapping)).toThrow(/side, price, size/);
  });

  it('explains the first failure when no row survives', () => {
    const table = parseCsv(
      ['timestamp,symbol,side,price,size', 'yesterday,BTC,buy,92000,0.5'].join('\n'),
    );
    const mapping: ColumnMapping = {
      columns: { timestamp: 0, symbol: 1, side: 2, price: 3, size: 4 },
      timestampFormat: 'epoch_ms',
      numberFormat: 'dot',
    };
    expect(() => applyMapping(table, mapping)).toThrow(/timestamp "yesterday"/);
  });

  it('reads a European export the header hints do not cover', () => {
    // German names match nothing in NAME_HINTS, which is the file most likely to use
    // a decimal comma — so the separator must be sniffed without a mapping, and the
    // three unnamed columns are the UI step SPEC §4.6 asks for.
    const table = parseCsv(
      ['Zeit;Markt;Seite;Preis;Menge', '1762387200000;BTC;Long;92000,50;0,5'].join('\n'),
    );
    const suggested = suggestMapping(table);
    expect(suggested.numberFormat).toBe('comma');
    expect(suggested.columns.timestamp).toBe(0);
    expect(suggested.columns.side).toBe(2);
    expect(missingRequired(suggested)).toEqual(['symbol', 'price', 'size']);

    const mapping: ColumnMapping = {
      ...suggested,
      columns: { ...suggested.columns, symbol: 1, price: 3, size: 4 },
    };
    const { fills } = applyMapping(table, mapping);
    expect(fills[0]).toMatchObject({ side: 'buy', price: 92000.5, size: 0.5 });
  });
});
