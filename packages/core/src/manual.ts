/**
 * A position someone typed rather than traded.
 *
 * Pick an instrument from the venue's own list, enter the entries and exits with their
 * dates, and replay it against the venue's real candles. The chart is the market's; the
 * position is a construction.
 *
 * That distinction is the whole reason this file is careful. CLAUDE.md: "No fabricated
 * numbers in the HUD… These outputs get exported as images and posted as fact." A
 * constructed replay is indistinguishable from a real one once it is an MP4, so two
 * things follow, and both are enforced elsewhere but decided here:
 *
 *  - Every fill carries `fee: 0` and the *episode* is presented with fees marked
 *    unavailable. A hypothetical trade genuinely paid nothing, but a real one would
 *    have, and a HUD reading "FEES $0.00" is a claim about what this trade would have
 *    cost. Unavailable is the honest reading, the same one leverage and Perps funding
 *    get.
 *  - The replay is labelled as constructed in the image itself, not only in the page
 *    around it.
 *
 * The spec travels in the URL rather than in a table. It is a handful of numbers, it
 * makes the link shareable with no storage behind it, and a "what if I had bought here"
 * is a thing people want to send to someone.
 */

import { base64UrlToBytes, bytesToBase64Url } from './base64url.js';
import type { Fill, Side, VenueId } from './types.js';

export interface ManualLeg {
  /** Epoch milliseconds. */
  ts: number;
  side: Side;
  /** Absolute, in base units. Never signed — direction is `side`. */
  size: number;
  price: number;
}

export interface ManualSpec {
  /** Whose candles to draw. The position itself belongs to no account. */
  venue: VenueId;
  /** The venue's instrument key, e.g. `HYPE` or `pm:7`. */
  instrument: string;
  /** What the HUD calls it. Falls back to `instrument`. */
  displayName: string;
  legs: ManualLeg[];
}

/**
 * Legs one spec may carry.
 *
 * The bound is the URL, not the maths: the fold handles any number of fills. Eight
 * entries and exits is more than anyone types by hand, and it keeps the encoded link
 * comfortably inside what every browser and chat client will carry.
 */
export const MANUAL_MAX_LEGS = 8;

export class ManualSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualSpecError';
  }
}

/**
 * Check a spec and put it in canonical form.
 *
 * Sorting is not cosmetic. §5 is a running fold over fills in time order, so legs typed
 * out of order — which a form with free-text rows invites — would produce a different
 * and entirely wrong position rather than an error anyone would notice.
 */
export function normalizeManualSpec(spec: ManualSpec): ManualSpec {
  const instrument = spec.instrument.trim();
  if (instrument === '') {
    throw new ManualSpecError('Pick an instrument first.');
  }
  if (spec.legs.length === 0) {
    throw new ManualSpecError('A position needs at least one entry.');
  }
  if (spec.legs.length > MANUAL_MAX_LEGS) {
    throw new ManualSpecError(`A position can have at most ${MANUAL_MAX_LEGS} entries and exits.`);
  }

  const legs = spec.legs.map((leg, index) => {
    if (!Number.isFinite(leg.ts)) {
      throw new ManualSpecError(`Row ${index + 1} has no valid date and time.`);
    }
    if (!positive(leg.size)) {
      throw new ManualSpecError(`Row ${index + 1}: size must be a number above zero.`);
    }
    if (!positive(leg.price)) {
      throw new ManualSpecError(`Row ${index + 1}: price must be a number above zero.`);
    }
    if (leg.side !== 'buy' && leg.side !== 'sell') {
      throw new ManualSpecError(`Row ${index + 1} is neither a buy nor a sell.`);
    }
    return { ts: Math.trunc(leg.ts), side: leg.side, size: leg.size, price: leg.price };
  });

  legs.sort((a, b) => a.ts - b.ts);

  return {
    venue: spec.venue,
    instrument,
    displayName: spec.displayName.trim() || instrument,
    legs,
  };
}

/**
 * The spec as fills, ready for `buildEpisodes`.
 *
 * Ids are positional and unique. `Fill.id` is the dedupe key, and two legs at the same
 * instant and price is a perfectly reasonable thing to type — sharing an id would make
 * one of them silently disappear.
 */
export function manualFills(spec: ManualSpec): Fill[] {
  const normalized = normalizeManualSpec(spec);

  return normalized.legs.map((leg, index) => ({
    id: `manual:${index}`,
    ts: leg.ts,
    instrument: normalized.instrument,
    displayName: normalized.displayName,
    side: leg.side,
    price: leg.price,
    size: leg.size,
    // Zero because nothing was paid. What this must not become is a *guess* at what the
    // venue would have charged; the HUD marks fees unavailable for a manual replay, so
    // this number is never presented as the cost of the trade.
    fee: 0,
    // There is no venue response behind this fill. Null says so; an object shaped like
    // one would let a later cross-check believe it had an oracle to compare against.
    raw: null,
  }));
}

/** Compact wire form. Short keys because this ends up in a URL. */
interface Wire {
  v: string;
  i: string;
  n?: string;
  /** `[ts, side (0 buy / 1 sell), size, price]` per leg. */
  l: [number, number, number, number][];
}

export function encodeManualSpec(spec: ManualSpec): string {
  const normalized = normalizeManualSpec(spec);
  const wire: Wire = {
    v: normalized.venue,
    i: normalized.instrument,
    l: normalized.legs.map((leg) => [leg.ts, leg.side === 'buy' ? 0 : 1, leg.size, leg.price]),
  };
  // Omitted when it adds nothing, which is the common case for a venue whose instrument
  // key is already the symbol.
  if (normalized.displayName !== normalized.instrument) wire.n = normalized.displayName;

  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

/**
 * Decode a spec from a URL.
 *
 * Null on anything malformed rather than throwing, for the same reason `decodeReplayId`
 * does: this value is attacker-controlled, and a route handler must be able to answer a
 * bad one with a 404 rather than a 500. It also re-normalizes, so a hand-built link
 * cannot smuggle in out-of-order legs, a negative size, or fifty of them.
 */
export function decodeManualSpec(encoded: string): ManualSpec | null {
  const bytes = base64UrlToBytes(encoded);
  if (!bytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const wire = parsed as Partial<Wire>;
  if (typeof wire.v !== 'string' || typeof wire.i !== 'string' || !Array.isArray(wire.l)) {
    return null;
  }

  const legs: ManualLeg[] = [];
  for (const row of wire.l) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const [ts, side, size, price] = row;
    if ([ts, side, size, price].some((n) => typeof n !== 'number')) return null;
    legs.push({ ts, side: side === 0 ? 'buy' : 'sell', size, price });
  }

  try {
    return normalizeManualSpec({
      venue: wire.v as VenueId,
      instrument: wire.i,
      displayName: typeof wire.n === 'string' ? wire.n : wire.i,
      legs,
    });
  } catch {
    return null;
  }
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
