/**
 * Polymarket Perps adapter. SPEC.md §4.4.
 *
 * **Option A — open positions only.** CLAUDE.md records A as the default, SPEC §4.4.1
 * recommends it and §12 M6 names it. The consequence is stark and is surfaced, not
 * buried: `/v1/info/position-fills` serves only the account's *current open cycle*, so
 * once a Perps position closes its history is unreachable and it can never be replayed.
 * A closed Hyperliquid trade is replayable forever; a closed Perps trade is not.
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
import { PmFillsSchema, PmKlinesSchema, PmMarkHistorySchema, PmPortfolioSchema } from './schemas.js';

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
 * Fills for every position the account currently has open. SPEC §4.4.1 option A.
 *
 * Two calls deep by necessity: the portfolio names which instruments are open, and only
 * those have a retrievable cycle.
 */
async function fetchFills(
  input: AdapterInput,
  range?: TimeRange,
  ctx?: AdapterContext,
): Promise<Fill[]> {
  const client = createPerpsClient(ctx);
  const instruments = await loadInstruments(ctx);

  const portfolio = await client.get(
    '/v1/info/public-portfolio',
    { address: input.address },
    PmPortfolioSchema,
    'public-portfolio',
    PM_WEIGHTS.portfolio,
  );

  const open = portfolio.positions.filter((position) => position.size !== 0);

  if (open.length === 0) {
    warn(ctx, {
      kind: 'perps_open_positions_only',
      message:
        `This account has no open Perps positions. Polymarket Perps only serves the ` +
        `current open cycle, so positions that have already closed cannot be replayed at all.`,
      detail: { address: input.address },
    });
    return [];
  }

  const fills: Fill[] = [];

  for (const position of open) {
    const instrument = instruments.byId.get(position.instrument_id);
    if (!instrument) {
      warn(ctx, {
        kind: 'unknown_instrument',
        message:
          `The account holds instrument ${position.instrument_id}, which is not in the ` +
          `venue's instrument list. Its position cannot be reconstructed.`,
        detail: { instrumentId: position.instrument_id },
      });
      continue;
    }

    const raw = await client.get(
      '/v1/info/position-fills',
      { address: input.address, instrument_id: position.instrument_id },
      PmFillsSchema,
      'position-fills',
      PM_WEIGHTS.positionFills,
    );

    for (const trade of raw) {
      const fill = mapPerpsFill(trade, instrument);
      if (range && (fill.ts < range.from || fill.ts > range.to)) continue;
      fills.push(fill);
    }
  }

  warn(ctx, {
    kind: 'perps_open_positions_only',
    message:
      `Perps replays cover open positions only. ${open.length} open position(s) found; ` +
      `anything this account has already closed is unreachable through the public API.`,
    detail: { openPositions: open.length },
  });

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
