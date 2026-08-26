/**
 * Fetch the replay the browser was looking at.
 *
 * SPEC §15 suggests the worker "talk to [web] over an internal HTTP endpoint", and
 * that is worth more here than convenience: SPEC §9's claim is that "server output is
 * pixel-identical to the browser preview", and the surest way to guarantee that is for
 * the worker to render from *the same payload the browser rendered from* rather than
 * from its own re-derivation, which could differ by a cache state or a clock tick.
 *
 * Zod is not used here on purpose. This is not an external venue: it is our own
 * endpoint, typed by `ReplayResult`, and the parts the renderer actually needs are
 * checked structurally below. A schema here would be a second copy of a type we own,
 * free to drift from the one that produces it.
 */

import type { Frame, PositionEpisode, PriceSeries } from '@trade-replay/core';

export interface ReplayPayload {
  replayId: string;
  address: string;
  episode: PositionEpisode;
  series: PriceSeries;
  interval: string;
  fundingUnavailable: boolean;
  notices: string[];
  frames?: Frame[];
}

export class ReplayFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayFetchError';
  }
}

function candlesOrPoints(series: PriceSeries): number {
  return series.kind === 'ohlcv' ? series.candles.length : series.points.length;
}

export async function fetchReplay(
  webUrl: string,
  replayId: string,
  interval: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ReplayPayload> {
  const url = new URL(`${webUrl}/api/replay`);
  url.searchParams.set('replayId', replayId);
  if (interval) url.searchParams.set('interval', interval);

  let response: Response;
  try {
    response = await fetchImpl(url.toString());
  } catch (error) {
    throw new ReplayFetchError(
      `Could not reach ${webUrl}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Set WEB_URL to where the web service is listening.`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ReplayFetchError(`${url.pathname} returned ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload: ReplayPayload;
  try {
    payload = JSON.parse(text) as ReplayPayload;
  } catch {
    throw new ReplayFetchError(`${url.pathname} did not return JSON: ${text.slice(0, 200)}`);
  }

  // The two things a render cannot proceed without. Checked rather than assumed
  // because an empty series renders a blank video, which looks like a bug in the
  // encoder rather than in the data.
  if (!payload.episode || !payload.series) {
    throw new ReplayFetchError(`${url.pathname} returned no episode or series for ${replayId}.`);
  }
  if (candlesOrPoints(payload.series) === 0) {
    throw new ReplayFetchError(`No price data for ${replayId}; there is nothing to render.`);
  }

  return payload;
}
