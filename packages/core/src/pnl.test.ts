import { describe, expect, it } from 'vitest';
import { realizedFor, totalPnl, unrealizedFor, weightedAvgEntry } from './pnl.js';

describe('weightedAvgEntry', () => {
  it('returns the fill price when opening from flat', () => {
    expect(weightedAvgEntry(0, 0, 100, 5)).toBe(100);
  });

  it('weights by size, not by fill count', () => {
    // 1 unit @ 100, then 9 units @ 200 -> 190, not 150.
    expect(weightedAvgEntry(100, 1, 200, 9)).toBeCloseTo(190, 12);
  });

  it('is unchanged by a zero-size addition', () => {
    expect(weightedAvgEntry(150, 4, 999, 0)).toBe(150);
  });
});

describe('realizedFor', () => {
  it('is positive when a long closes above its entry', () => {
    expect(realizedFor(110, 100, 3, 'long')).toBeCloseTo(30, 12);
  });

  it('is negative when a long closes below its entry', () => {
    expect(realizedFor(90, 100, 3, 'long')).toBeCloseTo(-30, 12);
  });

  it('is positive when a short closes BELOW its entry', () => {
    expect(realizedFor(90, 100, 3, 'short')).toBeCloseTo(30, 12);
  });

  it('is negative when a short closes above its entry', () => {
    expect(realizedFor(110, 100, 3, 'short')).toBeCloseTo(-30, 12);
  });
});

describe('unrealizedFor', () => {
  it('uses the sign of netSize so shorts invert automatically', () => {
    expect(unrealizedFor(110, 100, 2)).toBeCloseTo(20, 12);
    expect(unrealizedFor(110, 100, -2)).toBeCloseTo(-20, 12);
    expect(unrealizedFor(90, 100, -2)).toBeCloseTo(20, 12);
  });

  it('is exactly zero when flat, whatever the mark price', () => {
    expect(unrealizedFor(12345, 100, 0)).toBe(0);
  });

  it('is zero when netSize is float dust rather than a real position', () => {
    expect(unrealizedFor(12345, 100, 1e-15)).toBe(0);
  });
});

describe('totalPnl', () => {
  it('subtracts fees and adds signed funding (SPEC §6.2)', () => {
    expect(totalPnl({ realized: 100, unrealized: 50, fees: 10, funding: -5 })).toBeCloseTo(135, 12);
  });

  it('treats received funding as a gain', () => {
    expect(totalPnl({ realized: 0, unrealized: 0, fees: 0, funding: 7 })).toBeCloseTo(7, 12);
  });

  it('treats paid funding as a loss', () => {
    expect(totalPnl({ realized: 0, unrealized: 0, fees: 0, funding: -7 })).toBeCloseTo(-7, 12);
  });
});
