/**
 * The PnL arithmetic, in one place. SPEC.md §5 and §6.2.
 *
 * `episodes.ts` and `timeline.ts` both need this maths; keeping one
 * implementation means a fix to the short-side sign can only be made once.
 */

import type { Direction } from './types.js';
import { isFlat } from './types.js';

/**
 * Weighted average entry after adding `addAbsSize` at `fillPrice`.
 * SPEC §5 step (b). Both sizes are absolute.
 */
export function weightedAvgEntry(
  currentAvg: number,
  currentAbsSize: number,
  fillPrice: number,
  addAbsSize: number,
): number {
  const total = currentAbsSize + addAbsSize;
  if (isFlat(total)) return fillPrice;
  return (currentAvg * currentAbsSize + fillPrice * addAbsSize) / total;
}

/**
 * Realized PnL for closing `closedQty` (absolute) at `exitPrice`.
 * SPEC §5 step (c): (price - avgEntry) * closedQty * (long ? +1 : -1).
 */
export function realizedFor(
  exitPrice: number,
  avgEntry: number,
  closedQty: number,
  direction: Direction,
): number {
  const sign = direction === 'long' ? 1 : -1;
  return (exitPrice - avgEntry) * closedQty * sign;
}

/**
 * Unrealized PnL at `mark` for a signed `netSize`.
 * SPEC §6.2: (mark - avgEntry) * netSize — the sign of netSize makes shorts
 * invert on their own, so there is no separate short branch to get wrong.
 */
export function unrealizedFor(mark: number, avgEntry: number, netSize: number): number {
  if (isFlat(netSize)) return 0;
  return (mark - avgEntry) * netSize;
}

export interface PnlComponents {
  realized: number;
  unrealized: number;
  /** Positive = paid. */
  fees: number;
  /** Signed: positive = received, negative = paid. See FundingEvent in types.ts. */
  funding: number;
}

/** SPEC §6.2: realized + unrealized - fees + funding. */
export function totalPnl({ realized, unrealized, fees, funding }: PnlComponents): number {
  return realized + unrealized - fees + funding;
}
