/**
 * Hyperliquid adapter. SPEC.md §4.3.
 *
 * Read-only, unauthenticated. Nothing in this file places, modifies or cancels an
 * order, and no key or seed phrase is ever requested (CLAUDE.md, hard rules).
 */

import { HL_INTERVALS } from '@trade-replay/core';
import type { Fill, FundingEvent, PriceSeries, TimeRange } from '@trade-replay/core';
import { withCandleCache, withFillCache } from '../cacheHelpers.js';
import { HL_WEIGHTS } from '../limiter.js';
import type {
  Adapter,
  AdapterContext,
  AdapterInput,
  AdapterWarning,
  CachedCandle,
  RawFillRecord,
  SeriesRequest,
} from '../types.js';
import { InvalidInputError, SeriesUnavailableError } from '../types.js';
import { createHlClient } from './client.js';
import { coinForInstrument, mapCandles, mapFill, mapFunding } from './map.js';
import { HlCandlesSchema, HlFillSchema, HlFillsSchema, HlFundingListSchema, parseVenue } from './schemas.js';

export { HL_API_BASE } from './client.js';
// Pure replay helper; the Node-only fixture loader lives behind ./hyperliquid/fixtures.
export * from './fixtureFetch.js';
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
 * One contiguous span of fills, paginated. SPEC §4.3.
 *
 * `aggregateByTime: true` merges the partial fills of a single crossing order, which
 * makes the replay's markers far cleaner.
 */
async function fetchFillSpan(
  input: AdapterInput,
  span: TimeRange,
  ctx: AdapterContext | undefined,
): Promise<RawFillRecord[]> {
  const client = createHlClient(ctx);
  const seen = new Set<number>();
  const raws = [];
  let startTime = span.from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.info(
      {
        type: 'userFillsByTime',
        user: input.address,
        startTime,
        endTime: span.to,
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
    if (next <= startTime || next > span.to) break;
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
      detail: { oldestAvailable: oldest, fillCount: raws.length, requestedFrom: span.from },
    });
  }

  return raws.map((raw) => ({ id: `hl:${raw.tid}`, ts: raw.time, payload: raw }));
}

/** All fills for this account, served through the cache when one is supplied. */
async function fetchFills(
  input: AdapterInput,
  range?: TimeRange,
  ctx?: AdapterContext,
): Promise<Fill[]> {
  const now = ctx?.now ?? Date.now;
  const window: TimeRange = { from: range?.from ?? 0, to: range?.to ?? now() };

  const records = await withFillCache({
    cache: ctx?.fillCache,
    venue: 'hyperliquid',
    address: input.address,
    range: window,
    fetchSpan: (span) => fetchFillSpan(input, span, ctx),
  });

  // Cached payloads go back through Zod on the way out. A cache written by an older
  // build is just as untrusted as a venue response (SPEC §14).
  return records.map((record) =>
    mapFill(parseVenue(HlFillSchema, record.payload, 'cached fill'), ctx?.onWarning),
  );
}

/** One contiguous span of candles, paginated. SPEC §4.3. */
async function fetchCandleSpan(
  coin: string,
  interval: string,
  span: TimeRange,
  ctx: AdapterContext | undefined,
): Promise<CachedCandle[]> {
  const client = createHlClient(ctx);
  const all = [];
  let startTime = span.from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.info(
      { type: 'candleSnapshot', req: { coin, interval, startTime, endTime: span.to } },
      HlCandlesSchema,
      'candleSnapshot',
      HL_WEIGHTS.optimisticCandlePage,
    );

    if (batch.length === 0) break;
    all.push(...batch);

    if (batch.length < HL_CANDLE_PAGE_LIMIT) break;

    const maxTime = batch.reduce((max, c) => Math.max(max, c.t), startTime);
    const next = maxTime + 1;
    if (next <= startTime || next > span.to) break;
    startTime = next;
  }

  return all.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
}

/** Candles covering [from, to], served through the cache when one is supplied. */
async function fetchSeries(req: SeriesRequest, ctx?: AdapterContext): Promise<PriceSeries> {
  const coin = coinForInstrument(req.instrument);
  const spec = HL_INTERVALS.find((i) => i.name === req.interval);
  if (!spec) {
    throw new Error(
      `Unknown Hyperliquid interval "${req.interval}". Available: ${HL_INTERVALS.map((i) => i.name).join(', ')}`,
    );
  }

  const bars = await withCandleCache({
    cache: ctx?.candleCache,
    key: { venue: 'hyperliquid', instrument: req.instrument, interval: req.interval },
    range: { from: req.from, to: req.to },
    intervalMs: spec.ms,
    now: (ctx?.now ?? Date.now)(),
    fetchSpan: (span) => fetchCandleSpan(coin, req.interval, span, ctx),
  });

  // SPEC §11 case 8: a delisted or HIP-3 market with no candles must be a clear
  // error, never a blank canvas.
  if (bars.length === 0) {
    throw new SeriesUnavailableError(req.instrument, req.interval, { from: req.from, to: req.to });
  }

  return mapCandles(req.instrument, req.interval, bars);
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
