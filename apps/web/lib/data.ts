/**
 * Server-side data loading for the web app.
 *
 * Everything venue-facing happens here so rate limiting, Zod validation and the
 * fixture/live decision stay on the server (SPEC §8: "keeps rate-limiting and caching
 * server-side, avoids CORS surprises").
 *
 * There is no caching layer yet — every request refetches. That is M4's job (SPEC §10
 * and §12), and building it now would be scaffolding a milestone that has not started.
 */

import { hyperliquidAdapter } from '@trade-replay/adapters';
import type { AdapterWarning } from '@trade-replay/adapters';
import { createSource, fixtureFromEnv, findWorkspaceRoot } from '@trade-replay/adapters/source';
import type { SourceCache } from '@trade-replay/adapters/source';
import { cacheUrlFor, createCandleCache, createFillCache, openCache } from '@trade-replay/cache';
import {
  buildEpisodes,
  decodeReplayId,
  findEpisodeByRef,
  pickInterval,
  replayIdForEpisode,
  seriesRangeFor,
} from '@trade-replay/core';
import type { PositionEpisode, PriceSeries, TimeRange } from '@trade-replay/core';

/**
 * One SQLite connection for the whole process, opened lazily.
 *
 * A connection per request would leak a file handle per request. SPEC §15 already
 * requires this process to be the single writer (replica count 1 while SQLite is the
 * store), so one shared connection is also the only correct shape.
 *
 * A cache is an optimisation: if it cannot be opened, requests still work uncached.
 */
let sharedCache: SourceCache | null | undefined;

function cache(): SourceCache | undefined {
  if (sharedCache === undefined) {
    try {
      const handle = openCache({
        url: cacheUrlFor(fixtureFromEnv()),
        cwd: findWorkspaceRoot(),
      });
      sharedCache = {
        candleCache: createCandleCache(handle.db),
        fillCache: createFillCache(handle.db),
        // The connection outlives any single request, so a request must not close it.
        close: () => undefined,
      };
    } catch (error) {
      // Degrading to uncached is correct, but doing it silently is not: a misconfigured
      // volume or an unbundled native binding would look like the cache simply never
      // helping, with nothing to point at.
      console.warn(
        `[cache] disabled — falling back to uncached reads: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      sharedCache = null;
    }
  }
  return sharedCache ?? undefined;
}

/** True when the database is reachable — the /api/health probe (SPEC §15.1). */
export function cacheAvailable(): boolean {
  return cache() !== undefined;
}

export interface EpisodeSummary {
  replayId: string;
  /** Normalized 0..1 closes across the episode, for the row sparkline. */
  spark: number[];
  instrument: string;
  displayName: string;
  direction: 'long' | 'short';
  openedAt: number;
  closedAt: number | null;
  peakSize: number;
  avgEntry: number;
  realizedPnl: number;
  totalFees: number;
  totalFunding: number;
  net: number;
  fillCount: number;
}

export interface EpisodesResult {
  address: string;
  label: string;
  episodes: EpisodeSummary[];
  warnings: AdapterWarning[];
  provenanceWarning?: string;
}

export interface ReplayResult {
  replayId: string;
  address: string;
  label: string;
  episode: PositionEpisode;
  series: PriceSeries;
  interval: string;
  /** Bars actually returned, not pickInterval's estimate — they differ by a bar or two. */
  barCount: number;
  availableIntervals: string[];
  warnings: AdapterWarning[];
  /** Rendered onto the canvas itself, so they survive an export. */
  notices: string[];
  provenanceWarning?: string;
}

/**
 * `Fill.raw` holds the whole venue payload for debugging. It is useless to the
 * browser and roughly doubles the page's serialized size, so it is dropped at the
 * boundary rather than shipped.
 */
function stripRaw(episode: PositionEpisode): PositionEpisode {
  const lighten = <T extends { raw: unknown }>(item: T): T => ({ ...item, raw: null });
  return {
    ...episode,
    fills: episode.fills.map(lighten),
    funding: episode.funding.map(lighten),
    steps: episode.steps.map((step) => ({ ...step, fill: lighten(step.fill) })),
  };
}

async function loadAll(address: string) {
  const source = createSource(fixtureFromEnv(), { cache: cache() });
  const input = await hyperliquidAdapter.parseInput(address, source.ctx);

  const fills = await hyperliquidAdapter.fetchFills(input, undefined, source.ctx);
  if (fills.length === 0) {
    return { source, input, fills, episodes: [] as PositionEpisode[] };
  }

  const range = {
    from: Math.min(...fills.map((f) => f.ts)),
    to: Math.max(...fills.map((f) => f.ts)),
  };
  const funding = (await hyperliquidAdapter.fetchFunding?.(input, range, source.ctx)) ?? [];
  const episodes = buildEpisodes(fills, { venue: 'hyperliquid', funding });

  return { source, input, fills, episodes };
}

/** Points per row sparkline. Enough to show a shape, few enough to inline in HTML. */
const SPARK_POINTS = 32;

/**
 * Sparkline data for every episode, using one series per instrument.
 *
 * Fetching per episode would be N requests for an N-episode address. One coarse series
 * per instrument, spanning that instrument's whole history and sliced per row, is 1-3
 * requests for the page — and the §10 cache makes repeat loads free.
 *
 * A failure here degrades the row to a flat line rather than failing the page: a
 * missing sparkline is cosmetic, an unreachable episode list is not.
 */
async function loadSparklines(
  episodes: readonly PositionEpisode[],
  ctx: Parameters<typeof hyperliquidAdapter.fetchSeries>[1],
  now: number,
): Promise<Map<string, number[]>> {
  const byInstrument = new Map<string, TimeRange>();
  for (const episode of episodes) {
    const range = seriesRangeFor(episode, now);
    const existing = byInstrument.get(episode.instrument);
    byInstrument.set(
      episode.instrument,
      existing
        ? { from: Math.min(existing.from, range.from), to: Math.max(existing.to, range.to) }
        : range,
    );
  }

  const series = new Map<string, PriceSeries>();
  await Promise.all(
    [...byInstrument].map(async ([instrument, range]) => {
      // Coarse on purpose: a sparkline needs a shape, not resolution.
      const picked = pickInterval(range.to - range.from, hyperliquidAdapter.intervals, { targetFrames: 120 });
      try {
        series.set(
          instrument,
          await hyperliquidAdapter.fetchSeries(
            { instrument, interval: picked.interval, ...range },
            ctx,
          ),
        );
      } catch {
        // Delisted market, or a range past the venue's retention (SPEC §11 case 8).
      }
    }),
  );

  const sparks = new Map<string, number[]>();
  for (const episode of episodes) {
    const found = series.get(episode.instrument);
    if (!found) continue;
    const spark = sliceSpark(found, episode.openedAt, episode.closedAt ?? now);
    if (spark.length > 1) sparks.set(episode.id, spark);
  }
  return sparks;
}

/** Closes between two timestamps, downsampled and normalized to 0..1. */
function sliceSpark(series: PriceSeries, from: number, to: number): number[] {
  const points =
    series.kind === 'ohlcv'
      ? series.candles.filter((c) => c.t >= from && c.t <= to).map((c) => c.c)
      : series.points.filter((p) => p.t >= from && p.t <= to).map((p) => p.p);

  if (points.length < 2) return [];

  const step = Math.max(1, Math.floor(points.length / SPARK_POINTS));
  const sampled = points.filter((_, i) => i % step === 0);

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min;
  // A perfectly flat window still needs to render as a line, not a divide-by-zero.
  return span === 0 ? sampled.map(() => 0.5) : sampled.map((p) => (p - min) / span);
}

export async function loadEpisodes(address: string): Promise<EpisodesResult> {
  const { source, input, episodes } = await loadAll(address);
  const sparks = await loadSparklines(episodes, source.ctx, Date.now());

  return {
    address: input.address,
    label: source.label,
    episodes: episodes.map((e) => ({
      replayId: replayIdForEpisode(e, input.address),
      spark: sparks.get(e.id) ?? [],
      instrument: e.instrument,
      displayName: e.displayName,
      direction: e.direction,
      openedAt: e.openedAt,
      closedAt: e.closedAt,
      peakSize: e.peakSize,
      avgEntry: e.avgEntry,
      realizedPnl: e.realizedPnl,
      totalFees: e.totalFees,
      totalFunding: e.totalFunding,
      net: e.realizedPnl - e.totalFees + e.totalFunding,
      fillCount: e.fills.length,
    })),
    warnings: source.warnings,
    ...(source.provenanceWarning ? { provenanceWarning: source.provenanceWarning } : {}),
  };
}

export class ReplayNotFoundError extends Error {}

export async function loadReplay(
  replayId: string,
  intervalOverride?: string,
): Promise<ReplayResult> {
  const ref = decodeReplayId(replayId);
  if (!ref) throw new ReplayNotFoundError('That replay link is not valid.');

  const { source, episodes } = await loadAll(ref.address);
  const episode = findEpisodeByRef(episodes, ref);
  if (!episode) {
    throw new ReplayNotFoundError(
      `No ${ref.instrument} position opened at ${new Date(ref.openedAt).toISOString()} for this address.`,
    );
  }

  const now = Date.now();
  const range = seriesRangeFor(episode, now);
  const picked = pickInterval((episode.closedAt ?? now) - episode.openedAt, hyperliquidAdapter.intervals, {
    ...(intervalOverride ? { override: intervalOverride } : {}),
  });

  const series = await hyperliquidAdapter.fetchSeries(
    { instrument: episode.instrument, interval: picked.interval, from: range.from, to: range.to },
    source.ctx,
  );

  const notices = [
    ...source.warnings.map((w) => w.message),
    ...(picked.warning ? [picked.warning] : []),
    ...(source.provenanceWarning ? ['SYNTHETIC DATA — not a real position'] : []),
  ];

  return {
    replayId,
    address: ref.address,
    label: source.label,
    episode: stripRaw(episode),
    series,
    interval: picked.interval,
    barCount: series.kind === 'ohlcv' ? series.candles.length : series.points.length,
    availableIntervals: hyperliquidAdapter.intervals.map((i) => i.name),
    warnings: source.warnings,
    notices,
    ...(source.provenanceWarning ? { provenanceWarning: source.provenanceWarning } : {}),
  };
}
