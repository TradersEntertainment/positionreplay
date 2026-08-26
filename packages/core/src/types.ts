/**
 * Core domain types. SPEC.md §1 and §4.2.
 *
 * This package is pure: no I/O, no DOM, no venue-specific shapes. Anything
 * Hyperliquid- or Polymarket-flavoured stops at the adapter boundary
 * (CLAUDE.md: "Adapters never leak").
 */

export type Side = 'buy' | 'sell';

export type Direction = 'long' | 'short';

export type VenueId = 'hyperliquid' | 'polymarket-perps' | 'csv';

/** A single execution, normalized across venues. SPEC §4.2. */
export interface Fill {
  /** Venue-unique; used as the dedupe key. */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** Canonical instrument key, e.g. "HYPE-PERP". */
  instrument: string;
  /** Human label, e.g. "HYPE PERP". */
  displayName: string;
  side: Side;
  price: number;
  /** Absolute, in base units / shares. Never signed. */
  size: number;
  /** Positive = paid by the trader. SPEC §4.2. */
  fee: number;
  /** Venue-reported realized PnL for this fill, when the venue provides one. */
  closedPnl?: number;
  /** The venue's own label, e.g. "Open Long". Cross-check only, never the source of truth. */
  dir?: string;
  /** Original payload, kept for debugging. */
  raw: unknown;
}

/**
 * A funding payment.
 *
 * SIGN CONVENTION — `amount` is a signed cash flow from the trader's point of view:
 * positive = RECEIVED by the trader, negative = PAID by the trader.
 *
 * SPEC.md never states this, but it is forced by §6.2's
 * `totalPnl = realized + unrealized - fees + funding`: `fee` is documented as
 * "positive = paid" and is subtracted, so for funding to be *added* it must carry
 * its own sign. This also matches Hyperliquid's `userFunding` `delta.usdc`.
 * Getting it backwards produces a plausible-looking wrong number, which SPEC §14
 * calls out as worse than a crash.
 */
export interface FundingEvent {
  id: string;
  ts: number;
  instrument: string;
  /** Signed: positive = received, negative = paid. */
  amount: number;
  /**
   * True when the amount is derived from public funding *rates* rather than the
   * account's actual charges (Polymarket Perps, SPEC §4.4.2). Must be surfaced
   * anywhere this reaches the HUD — CLAUDE.md forbids presenting an estimate as fact.
   */
  isEstimate: boolean;
  raw: unknown;
}

/** What a single fill did to the position. Venue-neutral. */
export type FillAction =
  /** Opened a new episode from flat. */
  | 'open'
  /** Increased an existing position in the same direction. */
  | 'scale_in'
  /** Decreased the position without reaching flat. */
  | 'reduce'
  /** Brought the position to flat. */
  | 'close'
  /** The closing half of a fill that crossed through zero. */
  | 'flip_out'
  /** The opening half of a fill that crossed through zero. */
  | 'flip_in';

/**
 * Position state around one fill.
 *
 * This is the reconstruction oracle: `netSizeBefore` / `avgEntryBefore` are exactly
 * what Polymarket Perps reports as `previous_size` / `previous_entry_price`
 * (SPEC §4.4.3), and `action` is what Hyperliquid's `dir` string encodes (§4.3).
 * Adapters assert against these rather than core importing venue vocabulary.
 */
export interface EpisodeStep {
  fill: Fill;
  action: FillAction;
  netSizeBefore: number;
  netSizeAfter: number;
  avgEntryBefore: number;
  avgEntryAfter: number;
  /** Realized PnL booked by this fill, after the venue-value preference in SPEC §14. */
  realizedDelta: number;
  /** Fee attributed to this episode from this fill (a flip splits it across two). */
  feeDelta: number;
  /** Absolute size this fill contributed to THIS episode (a flip splits it across two). */
  sizeDelta: number;
}

/** A contiguous span where net size on one instrument goes 0 -> non-zero -> 0. SPEC §4.2. */
export interface PositionEpisode {
  id: string;
  instrument: string;
  displayName: string;
  venue: VenueId;
  direction: Direction;
  openedAt: number;
  /** null = still open. */
  closedAt: number | null;
  /** Chronological; includes both the opening and closing legs. A flip fill appears in both episodes. */
  fills: Fill[];
  /** Per-fill position state; parallel narrative to `fills`, plus the flip halves. */
  steps: EpisodeStep[];
  funding: FundingEvent[];
  /** Largest absolute net size reached during the episode. */
  peakSize: number;
  /** Final weighted average entry. */
  avgEntry: number;
  realizedPnl: number;
  totalFees: number;
  /** Sum of `FundingEvent.amount`; signed, same convention as above. */
  totalFunding: number;
  boughtNotional: number;
  soldNotional: number;
  /** Net size still open at the end of the episode; 0 for a closed episode. */
  closingNetSize: number;
  /**
   * Populated when our reconstruction disagreed with the venue's own numbers.
   * SPEC §14: trust the venue and log the delta — never silently pick one.
   */
  reconciliation: ReconciliationNote[];
}

export interface ReconciliationNote {
  kind: 'closed_pnl_mismatch' | 'dir_mismatch';
  fillId: string;
  /** What we computed. */
  ours: number | string;
  /** What the venue reported. */
  venue: number | string;
  /** Relative difference for numeric kinds. */
  relativeDelta?: number;
}

export interface Candle {
  /** Bucket open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface PricePoint {
  t: number;
  p: number;
}

/**
 * OHLCV candles (perps) or a (t, price) line (Polymarket mark history).
 * Common interface, two shapes. SPEC §1.
 */
export type PriceSeries =
  | { kind: 'ohlcv'; instrument: string; interval: string; candles: Candle[] }
  | { kind: 'line'; instrument: string; interval: string; points: PricePoint[] };

/** One rendered step of the replay. SPEC §6.2. */
export interface Frame {
  /** series[i] time. */
  t: number;
  /** Index i — series is drawn clipped to this. */
  visibleUpTo: number;
  markPrice: number;
  /** Signed, as of t. */
  netSize: number;
  avgEntry: number;
  realized: number;
  /** (mark - avgEntry) * netSize, sign-aware. */
  unrealized: number;
  fees: number;
  funding: number;
  /** realized + unrealized - fees + funding. */
  totalPnl: number;
  holdingValue: number;
  bought: number;
  sold: number;
  /** Fills landing inside this bar; drives the marker pop-in. */
  newFills: Fill[];
  isFinal: boolean;
}

/**
 * A complete, serializable replay. No DOM refs, no closures — this is what gets
 * handed to the export worker (SPEC §9 phase 2).
 */
export interface ReplayState {
  episode: PositionEpisode;
  series: PriceSeries;
  frames: Frame[];
  interval: string;
  /** Non-fatal problems the UI/HUD must surface rather than hide. */
  warnings: string[];
}

export interface TimeRange {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, inclusive. */
  to: number;
}

/**
 * Size comparisons must never use `=== 0` (SPEC §5, "Float safety").
 * A long chain of scale-ins and partial closes leaves netSize at ~1e-17, and an
 * exact comparison then reports a position that never closes.
 */
export const SIZE_EPS = 1e-9;

/** True when a net size is zero within tolerance. */
export function isFlat(netSize: number, eps: number = SIZE_EPS): boolean {
  return Math.abs(netSize) < eps;
}

/** Sign of a size, treating anything inside the epsilon as flat. */
export function sizeSign(netSize: number, eps: number = SIZE_EPS): -1 | 0 | 1 {
  if (isFlat(netSize, eps)) return 0;
  return netSize > 0 ? 1 : -1;
}
