/**
 * Fixture builders for the core tests. Not part of the public surface.
 */

import type { Fill, FundingEvent, Side } from './types.js';

let seq = 0;

export interface FillSpec {
  ts: number;
  side: Side;
  price: number;
  size: number;
  id?: string;
  instrument?: string;
  displayName?: string;
  fee?: number;
  closedPnl?: number;
  dir?: string;
}

/** Build a Fill with sensible defaults so tests only state what they care about. */
export function fill(spec: FillSpec): Fill {
  const instrument = spec.instrument ?? 'HYPE-PERP';
  return {
    id: spec.id ?? `f${++seq}`,
    ts: spec.ts,
    instrument,
    displayName: spec.displayName ?? instrument.replace('-', ' '),
    side: spec.side,
    price: spec.price,
    size: spec.size,
    fee: spec.fee ?? 0,
    ...(spec.closedPnl === undefined ? {} : { closedPnl: spec.closedPnl }),
    ...(spec.dir === undefined ? {} : { dir: spec.dir }),
    raw: null,
  };
}

export interface FundingSpec {
  ts: number;
  amount: number;
  id?: string;
  instrument?: string;
  isEstimate?: boolean;
}

export function funding(spec: FundingSpec): FundingEvent {
  return {
    id: spec.id ?? `fu${++seq}`,
    ts: spec.ts,
    instrument: spec.instrument ?? 'HYPE-PERP',
    amount: spec.amount,
    isEstimate: spec.isEstimate ?? false,
    raw: null,
  };
}

/** Deterministic PRNG so a failing fuzz case is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
