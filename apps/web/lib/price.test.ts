import { describe, expect, it } from 'vitest';
import { priceDigits, priceOnBar, roundPrice } from './price';

describe('priceDigits / roundPrice', () => {
  it('quotes a large price whole and a small one finely', () => {
    expect(priceDigits(91_018)).toBe(0);
    expect(priceDigits(3.14)).toBe(2);
    expect(priceDigits(0.00004217)).toBe(6);
  });

  it('rounds to that scale', () => {
    expect(roundPrice(91_018.21550642306)).toBe(91_018);
    expect(roundPrice(3.14159)).toBe(3.14);
    expect(roundPrice(0.000042173)).toBe(0.000042);
  });

  it('treats a negative the same as its magnitude', () => {
    expect(priceDigits(-91_018)).toBe(0);
  });
});

describe('priceOnBar', () => {
  it('rounds a price that stays inside the bar', () => {
    expect(priceOnBar(91_018.2155, 90_500, 91_500)).toBe(91_018);
  });

  it('clamps a click above the bar to the bar', () => {
    expect(priceOnBar(99_999, 90_500.4, 91_500.6)).toBe(91_500);
  });

  it('clamps a click below the bar to the bar', () => {
    expect(priceOnBar(1, 90_500.4, 91_500.6)).toBe(90_501);
  });

  it('never returns a value outside the bar, whichever way rounding went', () => {
    // The bug this function exists for: rounding after clamping can push the value back
    // out, and clamping again then restores the digits the rounding removed.
    const low = 91_018.21550642306;
    const high = 91_099.98;
    for (const raw of [0, low, 91_050, high, 1e9]) {
      const out = priceOnBar(raw, low, high);
      expect(out, `raw ${raw}`).toBeGreaterThanOrEqual(low);
      expect(out, `raw ${raw}`).toBeLessThanOrEqual(high);
    }
  });

  it('rounds inward from a low with an ugly fraction', () => {
    // Rounding 91018.2155 to whole gives 91018, which is *below* the low. The answer has
    // to be the next whole number inside the bar, not the unrounded low.
    expect(priceOnBar(91_018.3, 91_018.21550642306, 91_099.98)).toBe(91_019);
  });

  it('falls back to the venue’s own number when the bar is thinner than a tick', () => {
    // No whole number lies between these two, so there is no rounded price to give. The
    // bound is a real number the venue reported; inventing one would not be.
    expect(priceOnBar(91_018.5, 91_018.4, 91_018.6)).toBeCloseTo(91_018.5, 9);
  });

  it('handles a zero-width bar', () => {
    expect(priceOnBar(5, 91_018.4, 91_018.4)).toBeCloseTo(91_018.4, 9);
  });
});
