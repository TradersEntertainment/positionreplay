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
  HL_INTERVALS,
  buildEpisodes,
  decodeReplayId,
  findEpisodeByRef,
  pickInterval,
  replayIdForEpisode,
  seriesRangeFor,
} from '@trade-replay/core';
import type { PositionEpisode, PriceSeries } from '@trade-replay/core';

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
    } catch {
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

export async function loadEpisodes(address: string): Promise<EpisodesResult> {
  const { source, input, episodes } = await loadAll(address);

  return {
    address: input.address,
    label: source.label,
    episodes: episodes.map((e) => ({
      replayId: replayIdForEpisode(e, input.address),
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
  const picked = pickInterval((episode.closedAt ?? now) - episode.openedAt, HL_INTERVALS, {
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
    availableIntervals: HL_INTERVALS.map((i) => i.name),
    warnings: source.warnings,
    notices,
    ...(source.provenanceWarning ? { provenanceWarning: source.provenanceWarning } : {}),
  };
}
