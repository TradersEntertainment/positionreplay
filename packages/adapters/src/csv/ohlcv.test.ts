import { describe, expect, it } from 'vitest';
import { OhlcvError, parseOhlcvCsv } from './ohlcv.js';

const T0 = Date.UTC(2025, 10, 6);
const HOUR = 3_600_000;

describe('parseOhlcvCsv', () => {
  it('reads a named header', () => {
    const { bars } = parseOhlcvCsv(
      [
        'time,open,high,low,close,volume',
        `${T0},91990,92020,91970,92000,12.5`,
        `${T0 + HOUR},92000,92500,91900,92400,9`,
      ].join('\n'),
    );
    expect(bars).toEqual([
      { t: T0, o: 91990, h: 92020, l: 91970, c: 92000, v: 12.5 },
      { t: T0 + HOUR, o: 92000, h: 92500, l: 91900, c: 92400, v: 9 },
    ]);
  });

  it('reads a headerless file positionally', () => {
    const { bars } = parseOhlcvCsv(`${T0},91990,92020,91970,92000,12.5`);
    expect(bars[0]?.c).toBe(92000);
  });

  it('accepts ISO timestamps', () => {
    const { bars, timestampFormat } = parseOhlcvCsv(
      ['time,open,high,low,close', '2025-11-06T00:00:00Z,91990,92020,91970,92000'].join('\n'),
    );
    expect(timestampFormat).toBe('iso8601');
    expect(bars[0]?.t).toBe(T0);
  });

  it('accepts epoch seconds', () => {
    const { bars } = parseOhlcvCsv(
      ['time,open,high,low,close', `${T0 / 1000},91990,92020,91970,92000`].join('\n'),
    );
    expect(bars[0]?.t).toBe(T0);
  });

  it('treats volume as optional', () => {
    const { bars } = parseOhlcvCsv(
      ['time,open,high,low,close', `${T0},91990,92020,91970,92000`].join('\n'),
    );
    expect(bars[0]?.v).toBe(0);
  });

  it('sorts bars by time', () => {
    const { bars } = parseOhlcvCsv(
      [
        'time,open,high,low,close',
        `${T0 + HOUR},92000,92500,91900,92400`,
        `${T0},91990,92020,91970,92000`,
      ].join('\n'),
    );
    expect(bars.map((b) => b.t)).toEqual([T0, T0 + HOUR]);
  });

  it('rejects a bar whose high is below its low rather than drawing it inverted', () => {
    const { bars, skippedRows } = parseOhlcvCsv(
      [
        'time,open,high,low,close',
        `${T0},91990,92020,91970,92000`,
        `${T0 + HOUR},92000,91000,92500,92400`,
      ].join('\n'),
    );
    expect(bars).toHaveLength(1);
    expect(skippedRows).toEqual([1]);
  });

  it('names the missing columns', () => {
    expect(() => parseOhlcvCsv('a\n1')).toThrow(OhlcvError);
  });

  it('refuses an unreadable time column instead of landing every bar in 1970', () => {
    expect(() =>
      parseOhlcvCsv(['time,open,high,low,close', 'yesterday,1,2,0.5,1.5'].join('\n')),
    ).toThrow(/not readable as ISO8601/);
  });

  it('explains when no row survives', () => {
    expect(() =>
      parseOhlcvCsv(['time,open,high,low,close', `${T0},x,y,z,w`].join('\n')),
    ).toThrow(/No row in this OHLCV file could be read/);
  });
});
