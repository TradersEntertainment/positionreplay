/**
 * Position reconstruction. SPEC.md §5.
 *
 * "The single most important and most bug-prone part." Every branch here is
 * covered by episodes.test.ts, including a fuzz test — change nothing without
 * a failing test first.
 */

import { realizedFor, weightedAvgEntry } from './pnl.js';
import type {
  EpisodeStep,
  Fill,
  FillAction,
  FundingEvent,
  PositionEpisode,
  ReconciliationNote,
  VenueId,
} from './types.js';
import { SIZE_EPS, isFlat, sizeSign } from './types.js';

export interface BuildEpisodesOptions {
  venue: VenueId;
  /** Funding events to attribute to whichever episode was open at their timestamp. */
  funding?: FundingEvent[];
  /** Size epsilon; derive from the instrument's size decimals when known. */
  eps?: number;
  /**
   * Relative disagreement with the venue's `closedPnl` that is worth recording.
   * SPEC §5: 0.5%.
   */
  closedPnlTolerance?: number;
}

/** Mutable accumulator for the episode currently being folded. */
interface Accum {
  id: string;
  instrument: string;
  displayName: string;
  direction: 'long' | 'short';
  openedAt: number;
  fills: Fill[];
  steps: EpisodeStep[];
  peakSize: number;
  realized: number;
  fees: number;
  bought: number;
  sold: number;
  reconciliation: ReconciliationNote[];
}

/**
 * Fold a flat list of fills into position episodes.
 *
 * Fills may arrive unsorted and may contain duplicates; both are handled here so
 * adapters do not each have to. SPEC §4.1: "newest-first NOT guaranteed — core sorts."
 */
export function buildEpisodes(
  fills: readonly Fill[],
  options: BuildEpisodesOptions,
): PositionEpisode[] {
  const eps = options.eps ?? SIZE_EPS;
  const tolerance = options.closedPnlTolerance ?? 0.005;

  const ordered = dedupeAndSort(fills);
  const byInstrument = groupBy(ordered, (f) => f.instrument);

  // Ordinal disambiguates episodes that share (instrument, openedAt) — which a flip
  // always produces. SPEC §8 deep-links on {venue, address, instrument, openedAt},
  // so those two must still be separately addressable.
  const ordinals = new Map<string, number>();
  const nextId = (instrument: string, openedAt: number): string => {
    const key = `${options.venue}:${instrument}:${openedAt}`;
    const n = ordinals.get(key) ?? 0;
    ordinals.set(key, n + 1);
    return `${key}#${n}`;
  };

  const out: PositionEpisode[] = [];

  for (const group of byInstrument.values()) {
    let netSize = 0;
    let avgEntry = 0;
    let current: Accum | null = null;

    const openEpisode = (f: Fill, signedDelta: number): Accum => ({
      id: nextId(f.instrument, f.ts),
      instrument: f.instrument,
      displayName: f.displayName,
      direction: signedDelta > 0 ? 'long' : 'short',
      openedAt: f.ts,
      fills: [],
      steps: [],
      peakSize: 0,
      realized: 0,
      fees: 0,
      bought: 0,
      sold: 0,
      reconciliation: [],
    });

    /** SPEC §5 step 5: an episode with net size left over is still open. */
    const finish = (acc: Accum, closedAt: number | null, finalAvgEntry: number): void => {
      out.push({
        id: acc.id,
        instrument: acc.instrument,
        displayName: acc.displayName,
        venue: options.venue,
        direction: acc.direction,
        openedAt: acc.openedAt,
        closedAt,
        fills: acc.fills,
        steps: acc.steps,
        funding: [],
        peakSize: acc.peakSize,
        avgEntry: finalAvgEntry,
        realizedPnl: acc.realized,
        totalFees: acc.fees,
        totalFunding: 0,
        boughtNotional: acc.bought,
        soldNotional: acc.sold,
        closingNetSize: closedAt === null ? netSize : 0,
        reconciliation: acc.reconciliation,
      });
    };

    for (const f of group) {
      const signedDelta = f.side === 'buy' ? f.size : -f.size;

      // A zero-size fill carries no position change. Keep any fee it charged.
      if (isFlat(f.size, eps)) {
        if (current) {
          current.fees += f.fee;
          current.fills.push(f);
        }
        continue;
      }

      const netBefore = netSize;
      const avgBefore = avgEntry;

      if (current === null) {
        // (a) START a new episode from flat.
        current = openEpisode(f, signedDelta);
        netSize = signedDelta;
        avgEntry = f.price;
        attribute(current, f, f.size, f.fee);
        current.peakSize = Math.max(current.peakSize, Math.abs(netSize));
        pushStep(current, {
          fill: f,
          action: 'open',
          netSizeBefore: netBefore,
          netSizeAfter: netSize,
          avgEntryBefore: avgBefore,
          avgEntryAfter: avgEntry,
          realizedDelta: 0,
          feeDelta: f.fee,
          sizeDelta: f.size,
        });
        continue;
      }

      if (sizeSign(signedDelta, eps) === sizeSign(netSize, eps)) {
        // (b) SCALE IN — average entry moves, nothing is realized.
        avgEntry = weightedAvgEntry(avgEntry, Math.abs(netSize), f.price, Math.abs(signedDelta));
        netSize += signedDelta;
        attribute(current, f, f.size, f.fee);
        current.peakSize = Math.max(current.peakSize, Math.abs(netSize));
        pushStep(current, {
          fill: f,
          action: 'scale_in',
          netSizeBefore: netBefore,
          netSizeAfter: netSize,
          avgEntryBefore: avgBefore,
          avgEntryAfter: avgEntry,
          realizedDelta: 0,
          feeDelta: f.fee,
          sizeDelta: f.size,
        });
        continue;
      }

      // (c) REDUCE / CLOSE / FLIP.
      const closedQty = Math.min(Math.abs(signedDelta), Math.abs(netSize));
      const remainder = Math.abs(signedDelta) - closedQty;
      const isFlip = remainder > eps;

      // A flip fill belongs to two episodes; split its fee and notional on the same
      // proportion as the size, so boughtNotional/soldNotional still reconcile per episode.
      const closingShare = closedQty / f.size;
      const closingFee = f.fee * closingShare;

      const computed = realizedFor(f.price, avgEntry, closedQty, current.direction);
      const resolved = resolveRealized(f, computed, tolerance);
      if (resolved.note) current.reconciliation.push(resolved.note);
      current.realized += resolved.value;

      netSize += signedDelta;
      attribute(current, f, closedQty, closingFee);

      const action: FillAction = isFlip ? 'flip_out' : isFlat(netSize, eps) ? 'close' : 'reduce';
      const netAfterForStep = isFlip ? 0 : isFlat(netSize, eps) ? 0 : netSize;
      pushStep(current, {
        fill: f,
        action,
        netSizeBefore: netBefore,
        netSizeAfter: netAfterForStep,
        avgEntryBefore: avgBefore,
        // A reduce never moves average entry; a close/flip freezes it at the entry basis.
        avgEntryAfter: avgBefore,
        realizedDelta: resolved.value,
        feeDelta: closingFee,
        sizeDelta: closedQty,
      });

      if (isFlip) {
        finish(current, f.ts, avgBefore);

        // ...and IMMEDIATELY start the next episode with the remainder, same ts.
        const remainderSigned = sizeSign(signedDelta, eps) * remainder;
        current = openEpisode(f, remainderSigned);
        netSize = remainderSigned;
        avgEntry = f.price;
        attribute(current, f, remainder, f.fee - closingFee);
        current.peakSize = Math.max(current.peakSize, Math.abs(netSize));
        pushStep(current, {
          fill: f,
          action: 'flip_in',
          netSizeBefore: 0,
          netSizeAfter: netSize,
          avgEntryBefore: 0,
          avgEntryAfter: avgEntry,
          realizedDelta: 0,
          feeDelta: f.fee - closingFee,
          sizeDelta: remainder,
        });
        continue;
      }

      if (isFlat(netSize, eps)) {
        finish(current, f.ts, avgBefore);
        current = null;
        // Reset explicitly: after a long chain of partial closes netSize is float dust,
        // and letting it carry into the next episode poisons its average entry.
        netSize = 0;
        avgEntry = 0;
      }
    }

    if (current) finish(current, null, avgEntry);
  }

  out.sort((a, b) => a.openedAt - b.openedAt || a.instrument.localeCompare(b.instrument) || a.id.localeCompare(b.id));

  attributeFunding(out, options.funding ?? []);
  return out;
}

/** SPEC §5 step 1: sort by (ts asc, id asc), dedupe by id. */
function dedupeAndSort(fills: readonly Fill[]): Fill[] {
  const seen = new Set<string>();
  const unique: Fill[] = [];
  for (const f of fills) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    unique.push(f);
  }
  return unique.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** Record a fill against an episode: its notional on the correct side, plus fees. */
function attribute(acc: Accum, f: Fill, size: number, fee: number): void {
  const notional = f.price * size;
  if (f.side === 'buy') acc.bought += notional;
  else acc.sold += notional;
  acc.fees += fee;
  if (acc.fills[acc.fills.length - 1]?.id !== f.id) acc.fills.push(f);
}

function pushStep(acc: Accum, step: EpisodeStep): void {
  acc.steps.push(step);
}

/**
 * SPEC §14: "When our computed PnL disagrees with the venue's reported `closedPnl`,
 * trust the venue and log the delta. Do not silently pick one."
 */
function resolveRealized(
  f: Fill,
  computed: number,
  tolerance: number,
): { value: number; note?: ReconciliationNote } {
  if (f.closedPnl === undefined) return { value: computed };

  const venue = f.closedPnl;
  const scale = Math.max(Math.abs(venue), Math.abs(computed));
  // Both effectively zero (closed at entry): nothing meaningful to compare.
  if (scale < 1e-8) return { value: venue };

  const relativeDelta = Math.abs(computed - venue) / scale;
  if (relativeDelta <= tolerance) return { value: venue };

  return {
    value: venue,
    note: {
      kind: 'closed_pnl_mismatch',
      fillId: f.id,
      ours: computed,
      venue,
      relativeDelta,
    },
  };
}

/**
 * SPEC §5 step 6: attribute each funding event to whichever episode was open at
 * that timestamp. Events outside every episode (the account was flat) are dropped.
 */
function attributeFunding(episodes: PositionEpisode[], events: readonly FundingEvent[]): void {
  if (events.length === 0) return;

  for (const event of events) {
    const host = episodes.find(
      (e) =>
        e.instrument === event.instrument &&
        event.ts >= e.openedAt &&
        event.ts <= (e.closedAt ?? Number.POSITIVE_INFINITY),
    );
    if (!host) continue;
    host.funding.push(event);
    host.totalFunding += event.amount;
  }
}
