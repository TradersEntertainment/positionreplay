/**
 * Adapter contracts. SPEC.md §4.1.
 *
 * Venue-specific shapes stop here: nothing below this boundary is re-exported into
 * `@trade-replay/core` or `@trade-replay/renderer` (CLAUDE.md: "Adapters never leak").
 */

import type {
  Fill,
  FundingEvent,
  IntervalSpec,
  PriceSeries,
  TimeRange,
  VenueId,
} from '@trade-replay/core';
import type { CsvDocumentStore } from './csv/document.js';

export interface AdapterInput {
  venue: VenueId;
  /** Main account address, lowercased. SPEC §4.3: never an agent/API wallet. */
  address: string;
  /** What the user actually typed, for display. */
  label?: string;
}

export interface SeriesRequest {
  /** Canonical instrument key, e.g. "HYPE-PERP". */
  instrument: string;
  /** Venue interval name, e.g. "1h". */
  interval: string;
  from: number;
  to: number;
}

export type AdapterWarningKind =
  /** SPEC §4.3 / §11 case 9: the venue only serves the most recent N fills. */
  | 'fill_history_truncated'
  /** SPEC §11 case 11: fee charged in a token we cannot value in USD. */
  | 'non_usd_fee'
  /** More fills share one millisecond than a single page can hold. */
  | 'pagination_collision'
  /** A funding amount is derived from public rates, not the account's charges. */
  | 'estimated_funding'
  /**
   * SPEC §4.4.1 option A: only the current open cycle is retrievable on Perps.
   *
   * No longer raised — `/v1/info/fills` turned out to serve the full history publicly,
   * so closed Perps positions are replayable after all. Kept because the option-A path
   * is still in the adapter and would raise it again if anyone switched back.
   */
  | 'perps_open_positions_only'
  /** The account holds an instrument missing from the venue's own instrument list. */
  | 'unknown_instrument'
  /** SPEC §4.6: a CSV row could not be read with the confirmed mapping. */
  | 'csv_rows_rejected'
  /** A CSV row's field count disagreed with its header. */
  | 'csv_ragged_rows';

/**
 * A non-fatal problem the UI must surface.
 *
 * CLAUDE.md: "No fabricated numbers in the HUD. If a value is unavailable or
 * estimated, show it as unavailable or label it as an estimate." Warnings are how
 * that information travels out of an adapter.
 */
export interface AdapterWarning {
  kind: AdapterWarningKind;
  message: string;
  detail?: Record<string, unknown>;
}

/** Minimal structural HTTP types — global `fetch`/`Response` satisfy these. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  /**
   * Absent on GET, and that is not a style choice.
   *
   * `fetch` rejects a GET carrying a body — even an empty string — with "Request with
   * GET/HEAD method cannot have body". Every test double and every fixture replay here
   * ignores the field, so a `body: ''` on a GET passed the whole suite and failed
   * against the only implementation that matters. Optional so the type cannot express
   * the broken call.
   */
  body?: string;
}

export type FetchLike = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** One bar, as stored. SPEC §10 keys candles by (venue, instrument, interval, bucketStart). */
export interface CachedCandle {
  /** Bucket open time. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleKey {
  venue: VenueId;
  instrument: string;
  interval: string;
}

/**
 * What the cache needs to reason about time.
 *
 * `intervalMs` is passed in rather than resolved from the interval name, because
 * interval vocabularies are venue-specific and the cache must not learn them.
 */
export interface CandleCacheContext {
  intervalMs: number;
  now: number;
}

/**
 * SPEC §10: "candles ... immutable once the bar closes. Cache forever. Only the most
 * recent (still-open) bar is volatile."
 *
 * `missing` exists because rows alone cannot answer "have we asked?". A venue
 * legitimately returns nothing for a quiet span, and a row-only cache then refetches
 * that span on every single load, forever. Coverage is tracked separately.
 */
export interface CandleCache {
  /** Closed bars known for this window. Never includes the still-forming bar. */
  read(key: CandleKey, range: TimeRange, ctx: CandleCacheContext): Promise<CachedCandle[]>;
  /** Sub-ranges of `range` never fetched, plus any still-volatile tail. */
  missing(key: CandleKey, range: TimeRange, ctx: CandleCacheContext): Promise<TimeRange[]>;
  /** Store bars and mark `range` fetched. Still-forming bars are dropped. */
  write(
    key: CandleKey,
    bars: readonly CachedCandle[],
    range: TimeRange,
    ctx: CandleCacheContext,
  ): Promise<void>;
}

/**
 * A venue fill kept verbatim.
 *
 * SPEC §4.3 caps Hyperliquid history at roughly the most recent 10,000 fills, so this
 * is data that cannot simply be refetched once it ages out. It is stored as the raw
 * payload rather than as a parsed `Fill`: the venue contract has not been checked
 * against a live response yet (docs/VERIFYING-M1.md), and keeping the original means a
 * corrected schema can re-derive everything from cache instead of from the network.
 */
export interface RawFillRecord {
  /** Venue-unique dedupe key, the same one `Fill.id` carries. */
  id: string;
  ts: number;
  payload: unknown;
}

export interface FillSyncState {
  /** Earliest timestamp the cache has actually synced from. */
  syncedFromTs: number;
  /** SPEC §10: "on refetch only request startTime = lastSyncedTs". */
  lastSyncedTs: number;
}

export interface FillCache {
  readState(venue: VenueId, address: string): Promise<FillSyncState | null>;
  read(venue: VenueId, address: string, range: TimeRange): Promise<RawFillRecord[]>;
  write(
    venue: VenueId,
    address: string,
    records: readonly RawFillRecord[],
    state: FillSyncState,
  ): Promise<void>;
}

export interface RateLimiter {
  /** Resolves once `weight` units are available. */
  take(weight: number): Promise<void>;
}

/**
 * Everything an adapter needs from its host.
 *
 * This is the seam SPEC §4.1's signatures do not provide: it carries the warning
 * sink required by §4.3/§11, and it makes `fetch` injectable so every adapter can
 * be tested against recorded responses with no network at all.
 */
export interface AdapterContext {
  fetch?: FetchLike;
  onWarning?: (warning: AdapterWarning) => void;
  limiter?: RateLimiter;
  /** Injectable clock, so retry/limiter behaviour is testable. */
  now?: () => number;
  /** Injectable sleep, so backoff does not make tests slow. */
  sleep?: (ms: number) => Promise<void>;
  /** SPEC §4.5: supplied from M4 onward; absent means ENS input is rejected, not guessed. */
  resolveEns?: (name: string) => Promise<string | null>;
  /** SPEC §10. Absent means every call goes to the venue. */
  candleCache?: CandleCache;
  fillCache?: FillCache;
  /**
   * SPEC §4.6: where uploaded CSVs live.
   *
   * Declared here rather than passed to the CSV adapter directly for the same reason
   * the caches are: the adapter stays a pure function of its context, and the host
   * decides whether that is SQLite, memory, or nothing at all.
   */
  csvStore?: CsvDocumentStore;
}

export interface Adapter {
  id: VenueId;

  /**
   * Candle intervals this venue offers, coarsest-last.
   *
   * Exposed here so callers pick an interval without importing a venue constant —
   * `pickInterval` takes the table as an argument for exactly this reason.
   */
  intervals: readonly IntervalSpec[];

  /**
   * Validate + normalize whatever the user typed.
   *
   * SPEC §4.1 types this as `string | File`. It stayed a string: the CSV adapter
   * takes the id of an already-stored upload rather than a File, because a File
   * cannot be put in a URL and SPEC §9's shareable deep link needs the account
   * identifier to survive a page load.
   */
  parseInput(raw: string, ctx?: AdapterContext): Promise<AdapterInput>;

  /** All fills for this account. Order is not guaranteed — core sorts. */
  fetchFills(input: AdapterInput, range?: TimeRange, ctx?: AdapterContext): Promise<Fill[]>;

  /** Price data covering [from, to] at the requested granularity. */
  fetchSeries(req: SeriesRequest, ctx?: AdapterContext): Promise<PriceSeries>;

  /** Optional: perp funding payments inside the window. */
  fetchFunding?(
    input: AdapterInput,
    range: TimeRange,
    ctx?: AdapterContext,
  ): Promise<FundingEvent[]>;

  /**
   * Optional: every instrument this venue lists.
   *
   * For choosing a market without an account — the manual position builder, where
   * someone picks a symbol and types entries and exits against the venue's real
   * candles. Optional because not every venue can answer it: the CSV adapter's
   * instruments come from an uploaded file, so there is no list to fetch.
   */
  listInstruments?(ctx?: AdapterContext): Promise<InstrumentListing[]>;
}

/** One tradable market, as little as a picker needs. */
export interface InstrumentListing {
  /** The adapter's own instrument key, the one `fetchSeries` takes. */
  instrument: string;
  /** What a human calls it. */
  displayName: string;
}

/** Thrown when a venue responds with a non-2xx status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /** Parsed from `Retry-After`, when the venue told us how long to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/**
 * Thrown when a venue has no price data for a range we hold fills for.
 * SPEC §11 case 8: this must be a clear error, never a blank canvas.
 */
export class SeriesUnavailableError extends Error {
  constructor(
    readonly instrument: string,
    readonly interval: string,
    readonly range: TimeRange,
  ) {
    super(
      `No price data for ${instrument} at ${interval} between ` +
        `${new Date(range.from).toISOString()} and ${new Date(range.to).toISOString()}. ` +
        `The market may be delisted, or the interval may predate the venue's retention window.`,
    );
    this.name = 'SeriesUnavailableError';
  }
}

/**
 * Thrown when the venue host cannot be reached at all.
 *
 * Distinguished from HttpError on purpose: a blocked egress policy, a DNS failure and
 * a 500 are three different problems, and collapsing them into "request failed" sends
 * whoever is debugging in the wrong direction.
 */
export class VenueUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not reach ${baseUrl}: ${detail}\n` +
        `  If this is a sandboxed or CI environment, the host is probably not on the ` +
        `egress allowlist. Capture fixtures where the network is open (pnpm capture:hl) ` +
        `and re-run against those instead.`,
    );
    this.name = 'VenueUnreachableError';
  }
}

/**
 * Thrown for a 413 from Polymarket Perps.
 *
 * SPEC §4.4.1: "cycle discovery for positions inherited from a gateway snapshot is
 * capped at 250,000 account-history rows and returns 413 for cycles older than that
 * bound. Handle 413 as 'history too old', not as a generic failure."
 */
export class HistoryTooOldError extends Error {
  constructor(readonly detail: string) {
    super(
      `The venue will not serve this position's history: it predates the cycle-discovery ` +
        `limit. ${detail}`,
    );
    this.name = 'HistoryTooOldError';
  }
}

/** Thrown when input cannot be resolved to an address. SPEC §11 case 10. */
/**
 * The venue has never seen this account.
 *
 * Distinct from "no positions" on purpose. Polymarket keeps two address spaces: the
 * proxy wallet a profile page shows, and the address Perps actually trades under.
 * Probing both live, the proxy wallet returns `400 {"error":"account not found"}` while
 * the Perps address returns 200 with a full history. SPEC §4.5: "Do not ship a resolver
 * that silently returns 'no positions' for a valid trader — that reads as a bug in our
 * app, not as an address mismatch." An empty replay would be exactly that bug; this is
 * the sentence that tells someone what actually happened.
 */
export class UnknownAccountError extends Error {
  constructor(
    readonly venue: string,
    readonly address: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnknownAccountError';
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
