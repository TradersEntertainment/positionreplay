/**
 * Adapter contracts. SPEC.md §4.1.
 *
 * Venue-specific shapes stop here: nothing below this boundary is re-exported into
 * `@trade-replay/core` or `@trade-replay/renderer` (CLAUDE.md: "Adapters never leak").
 */

import type { Fill, FundingEvent, PriceSeries, TimeRange, VenueId } from '@trade-replay/core';

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
  | 'estimated_funding';

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
  body: string;
}

export type FetchLike = (url: string, init: HttpRequest) => Promise<HttpResponse>;

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
}

export interface Adapter {
  id: VenueId;

  /**
   * Validate + normalize whatever the user typed.
   *
   * SPEC §4.1 types this as `string | File`; the File branch arrives with the CSV
   * adapter in M7. Widening it before there is an implementation would be a
   * placeholder, which CLAUDE.md forbids.
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

/** Thrown when input cannot be resolved to an address. SPEC §11 case 10. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
