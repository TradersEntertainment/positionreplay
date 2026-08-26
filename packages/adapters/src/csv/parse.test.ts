import { describe, expect, it } from 'vitest';
import { CsvParseError, looksLikeHeader, parseCsv, sniffDelimiter } from './parse.js';

describe('sniffDelimiter', () => {
  it('finds a comma', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('finds a semicolon', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('finds a tab', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('is not fooled by commas inside a prose column', () => {
    // Every line has more commas than semicolons, but only ";" splits consistently.
    const text = [
      'ts;note',
      '1;bought, then waited, then sold',
      '2;scaled in, again',
      '3;closed, finally',
    ].join('\n');
    expect(sniffDelimiter(text)).toBe(';');
  });

  it('falls back to a comma on a single-column file', () => {
    expect(sniffDelimiter('one\ntwo\nthree')).toBe(',');
  });
});

describe('looksLikeHeader', () => {
  it('accepts an all-text first row over a numeric second', () => {
    expect(looksLikeHeader(['time', 'price'], ['1700000000', '92000'])).toBe(true);
  });

  it('rejects a first row that already holds numbers', () => {
    expect(looksLikeHeader(['1700000000', '92000'], ['1700000060', '92100'])).toBe(false);
  });

  it('accepts a lone text row as a header', () => {
    expect(looksLikeHeader(['time', 'price'], undefined)).toBe(true);
  });
});

describe('parseCsv', () => {
  it('parses a plain file', () => {
    const table = parseCsv('ts,side,price\n1700000000,buy,92000\n1700000060,sell,93000');
    expect(table.hasHeader).toBe(true);
    expect(table.header).toEqual(['ts', 'side', 'price']);
    expect(table.rows).toEqual([
      ['1700000000', 'buy', '92000'],
      ['1700000060', 'sell', '93000'],
    ]);
  });

  it('strips a UTF-8 BOM so the first column name still matches', () => {
    const table = parseCsv('﻿timestamp,price\n1700000000,92000');
    expect(table.header[0]).toBe('timestamp');
  });

  it('handles CRLF endings', () => {
    const table = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(table.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps a delimiter that appears inside a quoted field', () => {
    const table = parseCsv('note,price\n"sold, at last",92000');
    expect(table.rows[0]).toEqual(['sold, at last', '92000']);
  });

  it('unescapes a doubled quote', () => {
    const table = parseCsv('note,price\n"he said ""go""",92000');
    expect(table.rows[0]?.[0]).toBe('he said "go"');
  });

  it('keeps a newline inside a quoted field', () => {
    const table = parseCsv('note,price\n"line one\nline two",92000');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[0]).toBe('line one\nline two');
  });

  it('ignores a trailing newline rather than emitting an empty row', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toHaveLength(1);
  });

  it('synthesises column names when there is no header', () => {
    const table = parseCsv('1700000000,buy,92000\n1700000060,sell,93000');
    expect(table.hasHeader).toBe(false);
    expect(table.header).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(table.rows).toHaveLength(2);
  });

  it('names an empty header cell rather than leaving it blank', () => {
    // An unnamed column is unpickable in a dropdown that shows its name.
    expect(parseCsv('ts,,price\n1,x,2').header[1]).toBe('Column 2');
  });

  it('pads a short row and reports it as ragged', () => {
    const table = parseCsv('a,b,c\n1,2,3\n4,5');
    expect(table.rows[1]).toEqual(['4', '5', '']);
    expect(table.raggedRows).toEqual([1]);
  });

  it('truncates a long row and reports it as ragged', () => {
    const table = parseCsv('a,b\n1,2\n3,4,5');
    expect(table.rows[1]).toEqual(['3', '4']);
    expect(table.raggedRows).toEqual([1]);
  });

  it('rejects an empty file with a readable message', () => {
    expect(() => parseCsv('   ')).toThrow(CsvParseError);
  });

  it('rejects a header with no data rows', () => {
    expect(() => parseCsv('ts,price')).toThrow(/no data rows/);
  });

  it('rejects an unclosed quote instead of silently truncating', () => {
    expect(() => parseCsv('a,b\n"oops,2')).toThrow(/unclosed quoted field/);
  });

  it('honours a forced delimiter over the sniffed one', () => {
    const table = parseCsv('a;b\n1;2', ';');
    expect(table.header).toEqual(['a', 'b']);
  });
});
