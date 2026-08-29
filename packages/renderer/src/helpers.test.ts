import { describe, expect, it } from 'vitest';
import { axisDate, compactSize, compactUsd, holdingTime, hudDate, niceTicks, priceLabel, shortAddress, signedUsd, usd } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('niceTicks', () => {
  it('produces round values, not raw fractions of the range', () => {
    expect(niceTicks(12.2, 17.6, 5)).toEqual([13, 14, 15, 16, 17]);
  });

  it('gives a usable number of gridlines across magnitudes', () => {
    for (const [min, max] of [
      [0, 1],
      [12.2, 17.6],
      [0.0001, 0.0009],
      [90_000, 98_000],
      [-50, 50],
    ] as const) {
      const ticks = niceTicks(min, max, 5);
      expect(ticks.length, `range ${min}..${max}`).toBeGreaterThanOrEqual(3);
      expect(ticks.length, `range ${min}..${max}`).toBeLessThanOrEqual(11);
    }
  });

  it('keeps every tick inside the range', () => {
    for (const t of niceTicks(12.2, 17.6, 5)) {
      expect(t).toBeGreaterThanOrEqual(12.2);
      expect(t).toBeLessThanOrEqual(17.6);
    }
  });

  it('does not hang or divide by zero on a collapsed range', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(5, 4)).toEqual([5]);
  });
});

describe('axisDate — granularity follows the span, not the bar', () => {
  const ts = Date.UTC(2025, 10, 3, 14, 30);

  it('shows only the date across a long span', () => {
    expect(axisDate(ts, 30 * DAY)).toBe('3 Nov');
  });

  it('shows date and clock across a multi-day span', () => {
    // 30m bars over 4 days: "14:30" alone would not say which day.
    expect(axisDate(ts, 4 * DAY)).toBe('3 Nov 14:30');
  });

  it('shows only the clock inside a single session', () => {
    expect(axisDate(ts, 2 * HOUR)).toBe('14:30');
  });

  it('is UTC, so a server render matches a browser render (SPEC §9)', () => {
    // A local-time label would differ between the export worker and the viewer,
    // breaking the pixel-identity that §7's purity rule exists to buy.
    expect(axisDate(Date.UTC(2025, 0, 1, 0, 0), HOUR)).toBe('00:00');
    expect(hudDate(Date.UTC(2025, 0, 1, 0, 0))).toBe('1 Jan 2025 00:00 UTC');
  });
});

describe('number formatting', () => {
  it('formats usd with a sign outside the currency symbol', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(-1234.5)).toBe('-$1,234.50');
  });

  it('makes a gain explicit', () => {
    expect(signedUsd(10)).toBe('+$10.00');
    expect(signedUsd(-10)).toBe('-$10.00');
    expect(signedUsd(0)).toBe('$0.00');
  });

  it('compacts large notionals for markers', () => {
    expect(compactUsd(13_900_000)).toBe('$13.90M');
    expect(compactUsd(13_500)).toBe('$13.5K');
    expect(compactUsd(-2_400_000_000)).toBe('-$2.40B');
    expect(compactUsd(430.5)).toBe('$430.50');
  });

  it('adapts price precision to magnitude', () => {
    expect(priceLabel(92_000)).toBe('92,000');
    expect(priceLabel(13.2667)).toBe('13.27');
    expect(priceLabel(1.5)).toBe('1.500');
    expect(priceLabel(0.00012345)).toBe('0.00012');
  });

  it('compacts sizes without a currency symbol', () => {
    expect(compactSize(1500)).toBe('1.5K');
    expect(compactSize(2_500_000)).toBe('2.50M');
    expect(compactSize(0.5)).toBe('0.5000');
  });
});

describe('shortAddress', () => {
  it('truncates a wallet to head and tail', () => {
    expect(shortAddress('0x393d0b87ed38fc779fd9611144ae649ba6082109')).toBe('0x393d…2109');
  });

  it('leaves an already-short label alone', () => {
    expect(shortAddress('trader.eth')).toBe('trader.eth');
  });
});

describe('holdingTime', () => {
  it('drops to two units, coarsest first', () => {
    expect(holdingTime(65 * 60_000)).toBe('1H 05M');
    expect(holdingTime((2 * 24 * 60 + 3 * 60 + 41) * 60_000)).toBe('2D 03H');
    expect(holdingTime(90_000)).toBe('1M 30S');
  });

  it('says seconds when that is all there is', () => {
    // A scalp closed inside a minute held for a real, sayable length of time.
    expect(holdingTime(12_000)).toBe('12S');
    expect(holdingTime(0)).toBe('0S');
  });

  it('does not go negative on a position with no measurable duration', () => {
    expect(holdingTime(-5_000)).toBe('0S');
  });
});
