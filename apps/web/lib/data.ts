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

import { VENUE_LIMITATIONS, adapterFor, limitationText } from '@trade-replay/adapters';
import type { Adapter, AdapterWarning, VenueLimitation } from '@trade-replay/adapters';
import { createSource, fixtureFromEnv, findWorkspaceRoot } from '@trade-replay/adapters/source';
import type { SourceCache } from '@trade-replay/adapters/source';
import {
  cacheUrlFor,
  createCandleCache,
  createCsvDocumentStore,
  createFillCache,
  openCache,
  type CacheHandle,
} from '@trade-replay/cache';
import type { CsvDocumentStore } from '@trade-replay/adapters';
import {
  buildEpisodes,
  decodeReplayId,
  findEpisodeByRef,
  pickInterval,
  replayIdForEpisode,
  seriesRangeFor,
} from '@trade-replay/core';
import type { PositionEpisode, PriceSeries, TimeRange, VenueId } from '@trade-replay/core';

/**
 * One SQLite connection for the whole process, opened lazily.
 *
 * A connection per request would leak a file handle per request. SPEC §15 already
 * requires this process to be the single writer (replica count 1 while SQLite is the
 * store), so one shared connection is also the only correct shape.
 *
 * A cache is an optimisation: if it cannot be opened, requests still work uncached.
 */
let sharedHandle: CacheHandle | null | undefined;
let sharedCache: SourceCache | undefined;
/** SPEC §4.6's uploaded documents, on the same connection. */
let sharedCsvStore: CsvDocumentStore | undefined;

/**
 * The one connection, or null when the database could not be opened.
 *
 * Exported because the render queue (SPEC §9 Phase 2) is a different consumer of the
 * same file with a different failure policy: a missing cache degrades to uncached
 * reads, a missing queue means MP4 export is unavailable and has to say so.
 */
export function cacheHandle(): CacheHandle | undefined {
  if (sharedHandle === undefined) {
    try {
      sharedHandle = openCache({
        // No venue argument: this connection serves every venue, and the render
        // worker has to be able to find the same file (SPEC §15).
        url: cacheUrlFor(fixtureFromEnv()),
        cwd: findWorkspaceRoot(),
      });
    } catch (error) {
      // Degrading to uncached is correct, but doing it silently is not: a misconfigured
      // volume or an unbundled native binding would look like the cache simply never
      // helping, with nothing to point at.
      console.warn(
        `[cache] disabled — falling back to uncached reads: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      sharedHandle = null;
    }
  }
  return sharedHandle ?? undefined;
}

function cache(): SourceCache | undefined {
  const handle = cacheHandle();
  if (!handle) return undefined;

  if (sharedCache === undefined) {
    sharedCsvStore = createCsvDocumentStore(handle.db);
    sharedCache = {
      candleCache: createCandleCache(handle.db),
      fillCache: createFillCache(handle.db),
      // The connection outlives any single request, so a request must not close it.
      close: () => undefined,
    };
  }
  return sharedCache;
}

/** True when the database is reachable — the /api/health probe (SPEC §15.1). */
export function cacheAvailable(): boolean {
  return cache() !== undefined;
}

/**
 * The database file this process actually opened.
 *
 * Reported by /api/health because the render worker must poll the same file, and a
 * mismatch presents as a queue nothing ever picks up — which looks like a dead worker
 * rather than like two processes talking past each other.
 */
export function cacheDatabasePath(): string | null {
  return cacheHandle()?.path ?? null;
}

/**
 * Where uploaded CSVs live. SPEC §4.6.
 *
 * Unlike the candle cache, this is not an optimisation: without it a CSV upload has
 * nowhere to go, so the caller has to be told rather than silently degraded.
 */
export function csvStore(): CsvDocumentStore | undefined {
  cache();
  return sharedCsvStore;
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
  /**
   * How long the position ran, decided here rather than in the table.
   *
   * An open episode's duration is "now minus opened", and "now" is a different instant
   * on the server than it is when the browser hydrates. Computing it in the component
   * produced a React hydration mismatch on every open position — invisible on screen,
   * and a warning React says it will not patch up.
   */
  durationMs: number;
}

export interface EpisodesResult {
  venue: VenueId;
  address: string;
  label: string;
  /** SPEC §4.4.1: shown before any numbers are, for venues that have one. */
  limitation?: VenueLimitation;
  episodes: EpisodeSummary[];
  warnings: AdapterWarning[];
  provenanceWarning?: string;
}

export interface ReplayResult {
  replayId: string;
  venue: VenueId;
  address: string;
  label: string;
  limitation?: VenueLimitation;
  /** The venue cannot report this account's funding; the HUD must not print zero. */
  fundingUnavailable: boolean;
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

async function loadAll(venue: VenueId, address: string) {
  const adapter: Adapter = adapterFor(venue);
  const source = createSource(fixtureFromEnv(), {
    venue,
    cache: cache(),
    csvStore: csvStore(),
  });
  const input = await adapter.parseInput(address, source.ctx);

  const fills = await adapter.fetchFills(input, undefined, source.ctx);
  if (fills.length === 0) {
    return { adapter, source, input, fills, episodes: [] as PositionEpisode[] };
  }

  const range = {
    from: Math.min(...fills.map((f) => f.ts)),
    to: Math.max(...fills.map((f) => f.ts)),
  };
  const funding = (await adapter.fetchFunding?.(input, range, source.ctx)) ?? [];
  const episodes = buildEpisodes(fills, { venue, funding });

  return { adapter, source, input, fills, episodes };
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
  adapter: Adapter,
  episodes: readonly PositionEpisode[],
  ctx: Parameters<Adapter['fetchSeries']>[1],
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
      const picked = pickInterval(range.to - range.from, adapter.intervals, { targetFrames: 120 });
      try {
        series.set(
          instrument,
          await adapter.fetchSeries(
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

export async function loadEpisodes(venue: VenueId, address: string): Promise<EpisodesResult> {
  const { adapter, source, input, episodes } = await loadAll(venue, address);
  // One instant for the whole response, so every derived duration agrees with itself.
  const now = Date.now();
  const sparks = await loadSparklines(adapter, episodes, source.ctx, now);
  const limitation = VENUE_LIMITATIONS[venue];

  return {
    venue,
    address: input.address,
    label: source.label,
    ...(limitation ? { limitation } : {}),
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
      durationMs: (e.closedAt ?? now) - e.openedAt,
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

  const { adapter, source, episodes } = await loadAll(ref.venue, ref.address);
  const episode = findEpisodeByRef(episodes, ref);
  if (!episode) {
    throw new ReplayNotFoundError(
      `No ${ref.instrument} position opened at ${new Date(ref.openedAt).toISOString()} for this address.`,
    );
  }

  const now = Date.now();
  const range = seriesRangeFor(episode, now);
  const picked = pickInterval((episode.closedAt ?? now) - episode.openedAt, adapter.intervals, {
    ...(intervalOverride ? { override: intervalOverride } : {}),
  });

  const series = await adapter.fetchSeries(
    { instrument: episode.instrument, interval: picked.interval, from: range.from, to: range.to },
    source.ctx,
  );

  const limitation = VENUE_LIMITATIONS[ref.venue];
  // The canvas notice gets the one-line form: there is no bold lead-in to hang a
  // title on, and these are rendered into the exported image.
  const limitationLine = limitationText(ref.venue);
  const notices = [
    ...(limitationLine ? [limitationLine] : []),
    ...source.warnings.map((w) => w.message),
    ...(picked.warning ? [picked.warning] : []),
    ...(source.provenanceWarning ? ['SYNTHETIC DATA — not a real position'] : []),
  ];

  return {
    replayId,
    venue: ref.venue,
    address: ref.address,
    label: source.label,
    ...(limitation ? { limitation } : {}),
    // SPEC §4.4.2: some venues serve per-account funding only to an authenticated
    // session. The HUD shows a dash rather than asserting zero.
    fundingUnavailable: adapter.fetchFunding === undefined,
    episode: stripRaw(episode),
    series,
    interval: picked.interval,
    barCount: series.kind === 'ohlcv' ? series.candles.length : series.points.length,
    availableIntervals: adapter.intervals.map((i) => i.name),
    warnings: source.warnings,
    notices,
    ...(source.provenanceWarning ? { provenanceWarning: source.provenanceWarning } : {}),
  };
}
