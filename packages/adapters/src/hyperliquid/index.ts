/**
 * Hyperliquid adapter. SPEC.md §4.3.
 *
 * Read-only, unauthenticated. Nothing in this file places, modifies or cancels an
 * order, and no key or seed phrase is ever requested (CLAUDE.md, hard rules).
 */

import type { Fill, FundingEvent, PriceSeries, TimeRange } from '@trade-replay/core';
import { HL_WEIGHTS } from '../limiter.js';
import type { Adapter, AdapterContext, AdapterInput, AdapterWarning, SeriesRequest } from '../types.js';
import { InvalidInputError, SeriesUnavailableError } from '../types.js';
import { createHlClient } from './client.js';
import { coinForInstrument, mapCandles, mapFill, mapFunding } from './map.js';
import { HlCandlesSchema, HlFillsSchema, HlFundingListSchema } from './schemas.js';

export { HL_API_BASE } from './client.js';
export * from './map.js';
export * from './schemas.js';

/** SPEC §4.3: max 2000 fills per response. */
export const HL_FILL_PAGE_LIMIT = 2000;
/** SPEC §4.3: max 5000 candles per response, and only the most recent 5000 exist. */
export const HL_CANDLE_PAGE_LIMIT = 5000;
/** SPEC §4.3: "only the most recent ~10,000 fills are available via API". */
export const HL_FILL_HISTORY_LIMIT = 10_000;

/** Backstop against a pagination bug turning into an unbounded request loop. */
const MAX_PAGES = 200;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function warn(ctx: AdapterContext | undefined, warning: AdapterWarning): void {
  ctx?.onWarning?.(warning);
}

/**
 * SPEC §4.5 input sniffing.
 *
 * "Hyperliquid has no username system. Address or ENS only. Do not build a UI
 * affordance implying otherwise; if the venue is HL and the input isn't an address
 * or ENS, say so plainly."
 */
async function parseInput(raw: string, ctx?: AdapterContext): Promise<AdapterInput> {
  const trimmed = raw.trim();

  if (ADDRESS_RE.test(trimmed)) {
    return { venue: 'hyperliquid', address: trimmed.toLowerCase(), label: trimmed };
  }

  if (/\.eth$/i.test(trimmed)) {
    if (!ctx?.resolveEns) {
      throw new InvalidInputError(
        `ENS resolution is not wired up in this build, so "${trimmed}" cannot be resolved. ` +
          `Pass an ENS resolver via AdapterContext.resolveEns, or enter the 0x… address directly.`,
      );
    }
    const resolved = await ctx.resolveEns(trimmed);
    if (!resolved || !ADDRESS_RE.test(resolved)) {
      // SPEC §11 case 10: an ENS name that does not resolve is its own failure mode.
      throw new InvalidInputError(`ENS name "${trimmed}" does not resolve to an address.`);
    }
    return { venue: 'hyperliquid', address: resolved.toLowerCase(), label: trimmed };
  }

  throw new InvalidInputError(
    `"${trimmed}" is not a Hyperliquid account. Hyperliquid has no username system — ` +
      `enter a 0x… address or an ENS name.`,
  );
}

/**
 * All fills in `range`, paginated. SPEC §4.3.
 *
 * `aggregateByTime: true` merges the partial fills of a single crossing order, which
 * makes the replay's markers far cleaner.
 */
async function fetchFills(
  input: AdapterInput,
  range?: TimeRange,
  ctx?: AdapterContext,
): Promise<Fill[]> {
  const client = createHlClient(ctx);
  const now = ctx?.now ?? Date.now;
  const from = range?.from ?? 0;
  const to = range?.to ?? now();

  const seen = new Set<number>();
  const raws = [];
  let startTime = from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.info(
      {
        type: 'userFillsByTime',
        user: input.address,
        startTime,
        endTime: to,
        aggregateByTime: true,
      },
      HlFillsSchema,
      'userFillsByTime',
      HL_WEIGHTS.optimisticFillPage,
    );

    if (batch.length === 0) break;

    let maxTime = startTime;
    let minTime = Number.POSITIVE_INFINITY;
    for (const f of batch) {
      if (!seen.has(f.tid)) {
        seen.add(f.tid);
        raws.push(f);
      }
      if (f.time > maxTime) maxTime = f.time;
      if (f.time < minTime) minTime = f.time;
    }

    if (batch.length < HL_FILL_PAGE_LIMIT) break;

    // A full page whose fills all share one millisecond cannot be paginated past
    // without risking a silent drop — advancing is still the only option, but it
    // must not be silent.
    if (minTime === maxTime) {
      warn(ctx, {
        kind: 'pagination_collision',
        message:
          `A full page of ${batch.length} fills all share timestamp ${new Date(maxTime).toISOString()}. ` +
          `Any further fills at that exact millisecond cannot be retrieved and are missing.`,
        detail: { timestamp: maxTime, pageSize: batch.length },
      });
    }

    const next = maxTime + 1;
    if (next <= startTime || next > to) break;
    startTime = next;
  }

  // SPEC §4.3 / §11 case 9. The count reaching the venue's history ceiling is the
  // reliable signal; an old wallet that simply traded little looks identical to a
  // truncated one from the oldest-fill timestamp alone, so we key off the count.
  if (raws.length >= HL_FILL_HISTORY_LIMIT) {
    const oldest = raws.reduce((min, f) => Math.min(min, f.time), Number.POSITIVE_INFINITY);
    warn(ctx, {
      kind: 'fill_history_truncated',
      message:
        `Fill history unavailable before ${new Date(oldest).toISOString()} — Hyperliquid API limit ` +
        `(~${HL_FILL_HISTORY_LIMIT} most recent fills). Positions opened earlier will have an ` +
        `incorrect average entry.`,
      detail: { oldestAvailable: oldest, fillCount: raws.length, requestedFrom: from },
    });
  }

  return raws.map((raw) => mapFill(raw, ctx?.onWarning));
}

/** Candles covering [from, to]. SPEC §4.3. */
async function fetchSeries(req: SeriesRequest, ctx?: AdapterContext): Promise<PriceSeries> {
  const client = createHlClient(ctx);
  const coin = coinForInstrument(req.instrument);

  const all = [];
  let startTime = req.from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.info(
      { type: 'candleSnapshot', req: { coin, interval: req.interval, startTime, endTime: req.to } },
      HlCandlesSchema,
      'candleSnapshot',
      HL_WEIGHTS.optimisticCandlePage,
    );

    if (batch.length === 0) break;
    all.push(...batch);

    if (batch.length < HL_CANDLE_PAGE_LIMIT) break;

    const maxTime = batch.reduce((max, c) => Math.max(max, c.t), startTime);
    const next = maxTime + 1;
    if (next <= startTime || next > req.to) break;
    startTime = next;
  }

  // SPEC §11 case 8: a delisted or HIP-3 market with no candles must be a clear
  // error, never a blank canvas.
  if (all.length === 0) {
    throw new SeriesUnavailableError(req.instrument, req.interval, { from: req.from, to: req.to });
  }

  return mapCandles(req.instrument, req.interval, all);
}

/** Funding payments inside the window. SPEC §4.3, same 2000-item pagination. */
async function fetchFunding(
  input: AdapterInput,
  range: TimeRange,
  ctx?: AdapterContext,
): Promise<FundingEvent[]> {
  const client = createHlClient(ctx);

  const all = [];
  let startTime = range.from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.info(
      { type: 'userFunding', user: input.address, startTime, endTime: range.to },
      HlFundingListSchema,
      'userFunding',
      HL_WEIGHTS.optimisticFillPage,
    );

    if (batch.length === 0) break;
    all.push(...batch);

    if (batch.length < HL_FILL_PAGE_LIMIT) break;

    const maxTime = batch.reduce((max, e) => Math.max(max, e.time), startTime);
    const next = maxTime + 1;
    if (next <= startTime || next > range.to) break;
    startTime = next;
  }

  return mapFunding(all);
}

export const hyperliquidAdapter: Adapter = {
  id: 'hyperliquid',
  parseInput,
  fetchFills,
  fetchSeries,
  fetchFunding,
};
