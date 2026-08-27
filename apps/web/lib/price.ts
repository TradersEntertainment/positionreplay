/**
 * The price a click on the chart becomes.
 *
 * Two constraints pull against each other, and getting them both right is the whole
 * reason this is its own function with its own tests.
 *
 * **It has to be inside the bar.** You cannot have filled at a price the market never
 * reached in that hour, so the value is clamped to the candle's low–high range. This is
 * the same rule `estimateRows` uses working the other way round.
 *
 * **It has to look like a price.** A click lands on a continuous pixel, so the raw value
 * carries fourteen significant digits — a precision nobody has, given the underlying data
 * is one bar an hour. So it is rounded to the scale the market is quoted at.
 *
 * Doing those in the obvious order is wrong: rounding can push the value back out of the
 * bar, and clamping afterwards restores the very digits the rounding removed. So the
 * rounded value is nudged *inward* instead — down from the high, up from the low. When
 * the bar is narrower than one tick there is no rounded price inside it at all, and the
 * clamped raw value is used: it is the venue's own number for that bound, not an invented
 * one.
 */

/** Decimals a price of this magnitude is quoted at. */
export function priceDigits(value: number): number {
  const abs = Math.abs(value);
  return abs >= 1000 ? 0 : abs >= 1 ? 2 : 6;
}

export function roundPrice(value: number): number {
  const factor = 10 ** priceDigits(value);
  return Math.round(value * factor) / factor;
}

/**
 * A clickable price for this bar: inside `[low, high]`, at the market's own scale.
 *
 * `low`/`high` are taken as given; a caller handing them the wrong way round gets them
 * used the wrong way round, which is a bug in the caller and not something to paper over
 * here.
 */
export function priceOnBar(raw: number, low: number, high: number): number {
  const clamped = Math.min(high, Math.max(low, raw));
  const factor = 10 ** priceDigits(clamped);

  const nearest = Math.round(clamped * factor) / factor;
  if (nearest >= low && nearest <= high) return nearest;

  // Rounding left the bar. Take the nearest rounded value that is still inside it.
  const inward = nearest > high ? Math.floor(high * factor) / factor : Math.ceil(low * factor) / factor;
  if (inward >= low && inward <= high) return inward;

  // The bar is narrower than one tick, so no rounded price sits inside it. The bound
  // itself is a real number the venue reported, which is the honest thing to fall back on.
  return clamped;
}
