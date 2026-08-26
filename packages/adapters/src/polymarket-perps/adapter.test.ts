import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpisodes, pickInterval } from '@trade-replay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUnlimitedLimiter } from '../limiter.js';
import { HistoryTooOldError, InvalidInputError, SeriesUnavailableError } from '../types.js';
import type { AdapterContext, AdapterWarning } from '../types.js';
import { createPerpsFixtureFetch } from './fixtureFetch.js';
import { loadPerpsFixtureStore } from './fixtureStore.node.js';
import { PM_INTERVALS, polymarketPerpsAdapter, resetInstrumentCache } from './index.js';
import { PerpsContractError } from './schemas.js';

const FIXTURE = join(
  fileURLToPath(new URL('../../../../', import.meta.url)),
  'fixtures/polymarket-perps/synthetic',
);
const store = loadPerpsFixtureStore(FIXTURE);
const ADDRESS = '0x393d0b87ed38fc779fd9611144ae649ba6082109';
const INPUT = { venue: 'polymarket-perps' as const, address: ADDRESS };

beforeEach(() => resetInstrumentCache());

function ctx(extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    fetch: createPerpsFixtureFetch(store),
    limiter: createUnlimitedLimiter(),
    sleep: async () => undefined,
    ...extra,
  };
}

describe('parseInput (SPEC §4.5)', () => {
  it('accepts a 0x address and normalizes its case', async () => {
    const input = await polymarketPerpsAdapter.parseInput(ADDRESS.toUpperCase().replace('0X', '0x'));
    expect(input).toMatchObject({ venue: 'polymarket-perps', address: ADDRESS });
  });

  it('refuses a username, and says why rather than guessing', async () => {
    // §4.5 flags the Gamma-to-Perps address mapping as unverified, and CLAUDE.md
    // requires a curl check before the resolver exists. Guessing could show a
    // different trader's position under someone's name.
    await expect(polymarketPerpsAdapter.parseInput('some_trader')).rejects.toThrow(
      InvalidInputError,
    );
    await expect(polymarketPerpsAdapter.parseInput('some_trader')).rejects.toThrow(
      /has not been verified/,
    );
  });

  it('refuses an ENS name with no resolver rather than inventing one', async () => {
    await expect(polymarketPerpsAdapter.parseInput('trader.eth')).rejects.toThrow(
      /ENS resolution is not wired up/,
    );
  });
});

describe('fetchFills — option A (SPEC §4.4.1)', () => {
  it('reads the open positions from the portfolio, then their cycles', async () => {
    const seen: string[] = [];
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({ fetch: createPerpsFixtureFetch(store, { onRequest: (p) => seen.push(p) }) }),
    });

    expect(seen).toContain('/v1/info/public-portfolio');
    expect(seen.filter((p) => p === '/v1/info/position-fills')).toHaveLength(2);
    expect(fills.length).toBeGreaterThan(0);
  });

  it('always warns that only open positions are retrievable', async () => {
    const warnings: AdapterWarning[] = [];
    await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx({ onWarning: (w) => warnings.push(w) }));

    // The limitation is the product's, not the user's mistake — it has to be stated
    // every time, not only when the result is empty.
    expect(warnings.map((w) => w.kind)).toContain('perps_open_positions_only');
  });

  it('says so plainly when the account is flat', async () => {
    const warnings: AdapterWarning[] = [];
    const empty = { ...store, portfolio: { positions: [] } };
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({ fetch: createPerpsFixtureFetch(empty), onWarning: (w) => warnings.push(w) }),
    });

    expect(fills).toEqual([]);
    expect(warnings[0]!.message).toMatch(/cannot be replayed at all/);
  });

  it('warns rather than crashing on an instrument missing from the venue list', async () => {
    const warnings: AdapterWarning[] = [];
    const odd = {
      ...store,
      portfolio: { positions: [{ instrument_id: 999, size: '1.0' }] },
    };
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({ fetch: createPerpsFixtureFetch(odd), onWarning: (w) => warnings.push(w) }),
    });

    expect(fills).toEqual([]);
    expect(warnings.map((w) => w.kind)).toContain('unknown_instrument');
  });
});

/**
 * SPEC §4.4.3's gift: "previous_size + previous_entry_price give the exact position
 * state *before* each fill. This is a direct oracle for our reconstruction (§5): assert
 * our computed netSize/avgEntry equals these on every fill. Better validation than
 * anything Hyperliquid offers."
 *
 * `EpisodeStep` was built in M1 for precisely this.
 */
describe('the previous_size oracle', () => {
  it('agrees with our fold on every fill', async () => {
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const episodes = buildEpisodes(fills, { venue: 'polymarket-perps' });

    let checked = 0;
    for (const episode of episodes) {
      for (const step of episode.steps) {
        const raw = step.fill.raw as { previous_size: string; previous_entry_price: string };
        expect(step.netSizeBefore, `size before ${step.fill.id}`).toBeCloseTo(
          Number(raw.previous_size),
          6,
        );
        expect(step.avgEntryBefore, `entry before ${step.fill.id}`).toBeCloseTo(
          Number(raw.previous_entry_price),
          4,
        );
        checked++;
      }
    }

    expect(checked, 'no fills were actually cross-checked').toBeGreaterThan(3);
  });

  it('agrees with the venue pnl on every closing fill', async () => {
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const episodes = buildEpisodes(fills, { venue: 'polymarket-perps' });

    expect(episodes.flatMap((e) => e.reconciliation)).toHaveLength(0);
  });

  it('leaves every episode open, because that is all option A can see', async () => {
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const episodes = buildEpisodes(fills, { venue: 'polymarket-perps' });

    expect(episodes.length).toBeGreaterThanOrEqual(2);
    for (const episode of episodes) expect(episode.closedAt).toBeNull();
  });

  it('surfaces the liquidation flag through to the episode', async () => {
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const liquidated = fills.filter((f) => f.liquidation);

    expect(liquidated).toHaveLength(1);
    expect(liquidated[0]!.displayName).toBe('BTC-PERP');
  });
});

describe('fetchSeries', () => {
  it('serves klines for a normal interval', async () => {
    const series = await polymarketPerpsAdapter.fetchSeries(
      { instrument: 'pm:1', interval: '1h', from: 0, to: Number.MAX_SAFE_INTEGER },
      ctx(),
    );

    expect(series.kind).toBe('ohlcv');
    if (series.kind !== 'ohlcv') throw new Error('unreachable');
    expect(series.candles.length).toBeGreaterThan(20);
    for (let i = 1; i < series.candles.length; i++) {
      expect(series.candles[i]!.t).toBeGreaterThan(series.candles[i - 1]!.t);
    }
  });

  it('serves forward-filled mark history at 1s (SPEC §11 case 6)', async () => {
    const series = await polymarketPerpsAdapter.fetchSeries(
      { instrument: 'pm:1', interval: '1s', from: 0, to: Number.MAX_SAFE_INTEGER },
      ctx(),
    );

    expect(series.kind).toBe('line');
    if (series.kind !== 'line') throw new Error('unreachable');
    // The recording is deliberately sparse; forward-filling makes it evenly spaced.
    const gaps = series.points.slice(1).map((p, i) => p.t - series.points[i]!.t);
    expect(new Set(gaps)).toEqual(new Set([1_000]));
  });

  it('picks 1s for a position too short for candles', () => {
    // §11 case 6: 90 seconds has no useful number of 1m bars, but 1s does.
    expect(pickInterval(90_000, PM_INTERVALS).interval).toBe('1s');
  });

  it('rejects a Hyperliquid instrument reaching this adapter', async () => {
    await expect(
      polymarketPerpsAdapter.fetchSeries(
        { instrument: 'HYPE-PERP', interval: '1h', from: 0, to: 1 },
        ctx(),
      ),
    ).rejects.toThrow(SeriesUnavailableError);
  });

  it('errors clearly when the venue has no data (§11 case 8)', async () => {
    await expect(
      polymarketPerpsAdapter.fetchSeries(
        { instrument: 'pm:404', interval: '1h', from: 0, to: 1 },
        ctx(),
      ),
    ).rejects.toThrow(SeriesUnavailableError);
  });
});

describe('error handling (SPEC §4.4.4)', () => {
  it('treats 413 as history too old, not a generic failure', async () => {
    // §4.4.1: "Handle 413 as 'history too old', not as a generic failure."
    const fetch = createPerpsFixtureFetch(store, {
      failWith: (path) => (path === '/v1/info/position-fills' ? 413 : undefined),
    });

    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx({ fetch })),
    ).rejects.toThrow(HistoryTooOldError);
  });

  it('does not retry a 413', async () => {
    let calls = 0;
    const fetch = createPerpsFixtureFetch(store, {
      failWith: (path) => {
        if (path !== '/v1/info/position-fills') return undefined;
        calls++;
        return 413;
      },
    });

    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx({ fetch })),
    ).rejects.toThrow(HistoryTooOldError);
    expect(calls).toBe(1);
  });

  it('surfaces a schema mismatch with the keys it actually received', async () => {
    const wrong = { ...store, instruments: [{ id: 1, ticker: 'BTC' }] };
    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
        ...ctx({ fetch: createPerpsFixtureFetch(wrong) }),
      }),
    ).rejects.toThrow(PerpsContractError);
    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
        ...ctx({ fetch: createPerpsFixtureFetch(wrong) }),
      }),
    ).rejects.toThrow(/keys received: id, ticker/);
  });
});

describe('the adapter contract', () => {
  it('exposes its own interval table rather than borrowing one', () => {
    expect(polymarketPerpsAdapter.intervals).toBe(PM_INTERVALS);
    expect(polymarketPerpsAdapter.id).toBe('polymarket-perps');
  });

  it('offers no fetchFunding, because the venue cannot answer it', () => {
    // §4.4.2: per-account funding charges are authenticated-only. An estimate presented
    // where a fact is expected is what CLAUDE.md forbids.
    expect(polymarketPerpsAdapter.fetchFunding).toBeUndefined();
  });
});
