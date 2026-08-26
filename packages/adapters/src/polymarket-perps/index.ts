/**
 * Polymarket Perps adapter. SPEC.md §4.4.
 *
 * **Full history, not option A.** This was built as SPEC §4.4.1's option A — open
 * positions only, via `/v1/info/position-fills`, which serves just the account's current
 * open cycle. That made a closed Perps position permanently unreplayable, and the whole
 * app said so.
 *
 * It turned out not to be true. `/v1/info/fills` serves the account's entire trade
 * history, publicly: probed live against a real account, a cross-origin `fetch` with no
 * `Authorization` header and no cookies returns 200 and pages of records — including
 * `liquidation`, `adl`, `previous_size` and `previous_entry_price`. Option A was chosen
 * on the belief that no such endpoint existed, so the belief is what changed, not the
 * judgement. CLAUDE.md: "Never guess at a venue's API contract... check against the live
 * endpoint before building on it." That check is what produced this.
 *
 * `position-fills` is still here, unused by the default path but kept in the fixture and
 * the schemas: it is the endpoint SPEC actually documents, and dropping it would make
 * going back to option A a rewrite rather than a switch.
 *
 * Read-only and unauthenticated, like the Hyperliquid adapter. The endpoints used here
 * are the ones §4.4.1's table marks `security: []`.
 */

import type { Fill, IntervalSpec, PriceSeries, TimeRange } from '@trade-replay/core';
import { withCandleCache } from '../cacheHelpers.js';
import type {
  Adapter,
  AdapterContext,
  AdapterInput,
  AdapterWarning,
  CachedCandle,
  SeriesRequest,
} from '../types.js';
import { InvalidInputError, SeriesUnavailableError } from '../types.js';
import { PM_WEIGHTS, createPerpsClient } from './client.js';
import { loadInstruments } from './instruments.js';
import { instrumentIdFor, mapKlines, mapMarkHistory, mapPerpsFill } from './map.js';
import {
  PmFillHistorySchema,
  PmKlinesSchema,
  PmMarkHistorySchema,
} from './schemas.js';

export { PM_PERPS_API_BASE, PM_WEIGHTS } from './client.js';
export * from './map.js';
export * from './schemas.js';
export { loadInstruments, resetInstrumentCache, type InstrumentMap } from './instruments.js';
// Pure replay helper; the Node-only loader lives behind ./polymarket-perps/fixtures.
export * from './fixtureFetch.js';

/** SPEC §4.4.2: klines and mark-history both cap at 1000 rows per request. */
export const PM_PAGE_LIMIT = 1000;

const MAX_PAGES = 200;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Selectable intervals.
 *
 * `1s` is mark-history (SPEC §4.4.2 documents that endpoint at 1s, and §11 case 6
 * prescribes it for very short positions). The rest are klines.
 *
 * UNVERIFIED: SPEC does not enumerate the kline interval vocabulary, and this list has
 * not been checked against a live response — see docs/VERIFYING-M1.md. An interval the
 * venue rejects surfaces as a PerpsContractError naming what came back, not as a wrong
 * chart.
 */
export const PM_INTERVALS: readonly IntervalSpec[] = [
  { name: '1s', ms: 1_000 },
  { name: '1m', ms: 60_000 },
  { name: '5m', ms: 5 * 60_000 },
  { name: '15m', ms: 15 * 60_000 },
  { name: '1h', ms: 60 * 60_000 },
  { name: '4h', ms: 4 * 60 * 60_000 },
  { name: '1d', ms: 24 * 60 * 60_000 },
];

/** Mark-history is the 1s series; everything coarser comes from klines. */
export const PM_MARK_INTERVAL = '1s';

function warn(ctx: AdapterContext | undefined, warning: AdapterWarning): void {
  ctx?.onWarning?.(warning);
}

/**
 * SPEC §4.5 input handling.
 *
 * Polymarket does have a username system, but §4.5 flags the Gamma-to-Perps address
 * mapping as an unverified assumption and CLAUDE.md requires a curl check before the
 * resolver is written. Until that runs, a username is refused with the reason rather
 * than resolved to an address that may belong to a different system entirely —
 * §4.5: "Do not ship a resolver that silently returns 'no positions' for a valid trader."
 */
async function parseInput(raw: string, ctx?: AdapterContext): Promise<AdapterInput> {
  const trimmed = raw.trim();

  if (ADDRESS_RE.test(trimmed)) {
    return { venue: 'polymarket-perps', address: trimmed.toLowerCase(), label: trimmed };
  }

  if (/\.eth$/i.test(trimmed)) {
    if (!ctx?.resolveEns) {
      throw new InvalidInputError(
        `ENS resolution is not wired up in this build, so "${trimmed}" cannot be resolved. ` +
          `Enter the 0x… address directly.`,
      );
    }
    const resolved = await ctx.resolveEns(trimmed);
    if (!resolved || !ADDRESS_RE.test(resolved)) {
      throw new InvalidInputError(`ENS name "${trimmed}" does not resolve to an address.`);
    }
    return { venue: 'polymarket-perps', address: resolved.toLowerCase(), label: trimmed };
  }

  throw new InvalidInputError(
    `Username lookup is not available for Perps. Polymarket's public search returns a ` +
      `Predictions-side profile address, and whether that is the same account on Perps ` +
      `has not been verified — resolving it could quietly show the wrong trader, or none. ` +
      `Enter the 0x… address directly.`,
  );
}

/**
 * Every fill the account has ever made, walked page by page.
 *
 * The venue returns newest-first and ignores `limit`; each page carries `more` and an
 * opaque `cursor` that is fed back as the `cursor` query parameter. Which parameter name
 * that is was settled by paging a live account with each of `cursor`, `next_cursor`,
 * `after` and `offset` — only `cursor` advanced the page.
 *
 * Fills come back descending and are sorted ascending here, because §5's fold is a
 * running position and reading it backwards produces a different, wrong answer.
 */
async function fetchFills(
  input: AdapterInput,
  range?: TimeRange,
  ctx?: AdapterContext,
): Promise<Fill[]> {
  const client = createPerpsClient(ctx);
  const instruments = await loadInstruments(ctx);

  const fills: Fill[] = [];
  const unknownInstruments = new Set<number>();
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  for (; pages < MAX_PAGES; pages++) {
    const response = await client.get(
      '/v1/info/fills',
      { address: input.address, sort: 'desc', ...(cursor === undefined ? {} : { cursor }) },
      PmFillHistorySchema,
      'fills',
      PM_WEIGHTS.fills,
    );

    for (const trade of response.data) {
      const instrument = instruments.byId.get(trade.instrument_id);
      if (!instrument) {
        unknownInstruments.add(trade.instrument_id);
        continue;
      }
      const fill = mapPerpsFill(trade, instrument);
      if (range && (fill.ts < range.from || fill.ts > range.to)) continue;
      fills.push(fill);
    }

    // A descending walk that has passed the start of the range will only go further
    // back, so stop rather than paging through years to reach an empty tail.
    const oldest = response.data.at(-1)?.timestamp;
    if (range && oldest !== undefined && oldest < range.from) break;

    if (!response.more || response.data.length === 0) break;

    // A cursor that does not move is the one failure that would page forever. Treat it
    // as the end of the history rather than trusting `more`.
    if (response.cursor === undefined || response.cursor === cursor) break;
    cursor = response.cursor;
  }

  if (pages >= MAX_PAGES) truncated = true;

  for (const id of unknownInstruments) {
    warn(ctx, {
      kind: 'unknown_instrument',
      message:
        `The account traded instrument ${id}, which is not in the venue's instrument ` +
        `list. Those fills are omitted.`,
      detail: { instrumentId: id },
    });
  }

  if (truncated) {
    // CLAUDE.md: a truncated history has to reach the exported image, because the
    // numbers computed from it are wrong in a way nothing on the chart reveals.
    warn(ctx, {
      kind: 'fill_history_truncated',
      message:
        `Only the most recent ${MAX_PAGES} pages of this account's fills were read. ` +
        `Anything older is not included and the earliest position shown may be incomplete.`,
      detail: { pages: MAX_PAGES },
    });
  }

  fills.sort((a, b) => a.ts - b.ts);
  return fills;
}

/** One contiguous span of klines, paginated on the `more` flag. SPEC §4.4.2. */
async function fetchKlineSpan(
  instrumentId: number,
  interval: string,
  span: TimeRange,
  ctx: AdapterContext | undefined,
): Promise<CachedCandle[]> {
  const client = createPerpsClient(ctx);
  const bars: CachedCandle[] = [];
  let start = span.from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.get(
      '/v1/info/klines',
      {
        instrument_id: instrumentId,
        interval,
        start_timestamp: start,
        end_timestamp: span.to,
      },
      PmKlinesSchema,
      'klines',
      PM_WEIGHTS.klines,
    );

    for (const [t, o, h, l, c, v] of response.data) bars.push({ t, o, h, l, c, v });

    if (!response.more || response.data.length === 0) break;

    const newest = response.data.reduce((max, row) => Math.max(max, row[0]), start);
    const next = newest + 1;
    if (next <= start || next > span.to) break;
    start = next;
  }

  return bars;
}

/** Mark history for a span, paginated. Returned sparse; forward-filled by the mapper. */
async function fetchMarkSpan(
  instrumentId: number,
  span: TimeRange,
  ctx: AdapterContext | undefined,
): Promise<[number, number][]> {
  const client = createPerpsClient(ctx);
  const points: [number, number][] = [];
  let start = span.from;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.get(
      '/v1/info/mark-history',
      {
        instrument_id: instrumentId,
        interval: PM_MARK_INTERVAL,
        start_timestamp: start,
        end_timestamp: span.to,
      },
      PmMarkHistorySchema,
      'mark-history',
      PM_WEIGHTS.markHistory,
    );

    for (const [t, p] of response.data) points.push([t, p]);

    if (!response.more || response.data.length === 0) break;

    const newest = response.data.reduce((max, row) => Math.max(max, row[0]), start);
    const next = newest + 1;
    if (next <= start || next > span.to) break;
    start = next;
  }

  return points;
}

/**
 * Price data for a range.
 *
 * Klines are the default. Mark-history is used at `1s`, which is what SPEC §11 case 6
 * prescribes for a position too short to have enough candles — and 1s is the only
 * interval §4.4.2 documents that endpoint at, so asking it for anything coarser would
 * be guessing at the contract.
 */
async function fetchSeries(req: SeriesRequest, ctx?: AdapterContext): Promise<PriceSeries> {
  const instrumentId = instrumentIdFor(req.instrument);
  if (instrumentId === null) {
    throw new SeriesUnavailableError(req.instrument, req.interval, {
      from: req.from,
      to: req.to,
    });
  }

  const spec = PM_INTERVALS.find((i) => i.name === req.interval);
  if (!spec) {
    throw new Error(
      `Unknown Perps interval "${req.interval}". Available: ${PM_INTERVALS.map((i) => i.name).join(', ')}`,
    );
  }

  if (req.interval === PM_MARK_INTERVAL) {
    // Mark history is not cached: it is sampled, not bucketed, so SPEC §10's
    // "immutable once the bar closes" rule does not apply to it.
    const points = await fetchMarkSpan(instrumentId, { from: req.from, to: req.to }, ctx);
    if (points.length === 0) {
      throw new SeriesUnavailableError(req.instrument, req.interval, {
        from: req.from,
        to: req.to,
      });
    }
    return mapMarkHistory(req.instrument, req.interval, points, spec.ms);
  }

  const bars = await withCandleCache({
    cache: ctx?.candleCache,
    key: { venue: 'polymarket-perps', instrument: req.instrument, interval: req.interval },
    range: { from: req.from, to: req.to },
    intervalMs: spec.ms,
    now: (ctx?.now ?? Date.now)(),
    fetchSpan: (span) => fetchKlineSpan(instrumentId, req.interval, span, ctx),
  });

  // SPEC §11 case 8: no price data is a clear error, never a blank canvas.
  if (bars.length === 0) {
    throw new SeriesUnavailableError(req.instrument, req.interval, { from: req.from, to: req.to });
  }

  return mapKlines(req.instrument, req.interval, bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v, 0]));
}

/**
 * No `fetchFunding`.
 *
 * SPEC §4.4.2: the public funding endpoint returns the *rate*, not this account's paid
 * amount — "per-account funding charges are authenticated only". Producing a number
 * from the rate would be an estimate presented where a fact is expected, so the HUD
 * shows funding as unavailable instead (CLAUDE.md, no fabricated numbers).
 */
export const polymarketPerpsAdapter: Adapter = {
  id: 'polymarket-perps',
  intervals: PM_INTERVALS,
  parseInput,
  fetchFills,
  fetchSeries,
};
