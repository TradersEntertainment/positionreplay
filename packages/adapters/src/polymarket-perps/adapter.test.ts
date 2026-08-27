import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpisodes, pickInterval } from '@trade-replay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUnlimitedLimiter } from '../limiter.js';
import {
  HistoryTooOldError,
  InvalidInputError,
  SeriesUnavailableError,
  UnknownAccountError,
} from '../types.js';
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

  it('refuses a username, and says the mapping was checked and does not work', async () => {
    // §4.5 called the Gamma-to-Perps mapping an unverified assumption. It has since been
    // checked against the live API: the Predictions proxy wallet answers 400 "account not
    // found". So the refusal states a measured fact, not a caution.
    await expect(polymarketPerpsAdapter.parseInput('some_trader')).rejects.toThrow(
      InvalidInputError,
    );
    await expect(polymarketPerpsAdapter.parseInput('some_trader')).rejects.toThrow(
      /separate account system/i,
    );
  });

  it('recognises a Polymarket profile link and names the address it carries', async () => {
    // Someone who pastes a profile URL has done the reasonable thing. Telling them the
    // link was understood, and which address it holds, is the difference between an
    // explanation and a rejection.
    const url = 'https://polymarket.com/profile/0x6a151b00837bb18526c64d7ff4ffc54bdde2b4c6';

    await expect(polymarketPerpsAdapter.parseInput(url)).rejects.toThrow(InvalidInputError);
    await expect(polymarketPerpsAdapter.parseInput(url)).rejects.toThrow(/0x6a151b/);
    await expect(polymarketPerpsAdapter.parseInput(url)).rejects.toThrow(/proxy wallet/i);
  });

  it('recognises a profile link that carries a name rather than an address', async () => {
    await expect(polymarketPerpsAdapter.parseInput('polymarket.com/@ShadowPixel47')).rejects.toThrow(
      /ShadowPixel47/,
    );
  });

  it('does not mistake some other site\'s link for a Polymarket profile', async () => {
    // The message names Polymarket specifically, so it must not be shown for a URL that
    // has nothing to do with it — that would be a confident wrong explanation.
    await expect(polymarketPerpsAdapter.parseInput('https://example.com/@someone')).rejects.toThrow(
      /separate account system/i,
    );
    await expect(
      polymarketPerpsAdapter.parseInput('https://example.com/@someone'),
    ).rejects.not.toThrow(/proxy wallet/i);
  });

  it('still accepts a bare address, because only the venue can judge one', async () => {
    // A Perps address and a Predictions proxy wallet are both 40 hex characters. Nothing
    // here can tell them apart, so the venue does — a wrong one comes back as
    // UnknownAccountError from the fills call, with its own explanation.
    await expect(
      polymarketPerpsAdapter.parseInput('0x6a151b00837bb18526c64d7ff4ffc54bdde2b4c6'),
    ).resolves.toMatchObject({ address: '0x6a151b00837bb18526c64d7ff4ffc54bdde2b4c6' });
  });

  it('refuses an ENS name with no resolver rather than inventing one', async () => {
    await expect(polymarketPerpsAdapter.parseInput('trader.eth')).rejects.toThrow(
      /ENS resolution is not wired up/,
    );
  });
});

describe('fetchFills — full history (/v1/info/fills)', () => {
  it('walks the cursor to the end of the history', async () => {
    const seen: { path: string; cursor: string | null }[] = [];
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({
        fetch: createPerpsFixtureFetch(store, {
          onRequest: (path, params) => seen.push({ path, cursor: params.get('cursor') }),
        }),
      }),
    });

    const pages = seen.filter((r) => r.path === '/v1/info/fills');
    // The fixture is three pages. One request would mean `more` was ignored and most of
    // the account's history silently dropped — which is exactly how a replay ends up
    // showing a position that appears to open out of nowhere.
    expect(pages).toHaveLength(3);
    expect(pages[0]!.cursor).toBeNull();
    expect(pages.slice(1).map((r) => r.cursor)).toEqual(['cursor-1', 'cursor-2']);
    expect(fills).toHaveLength(8);
  });

  it('does not read the portfolio at all', async () => {
    // The old option-A path started there. If it comes back, a closed position becomes
    // invisible again without a single test failing on the numbers.
    const seen: string[] = [];
    await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({ fetch: createPerpsFixtureFetch(store, { onRequest: (p) => seen.push(p) }) }),
    });

    expect(seen).not.toContain('/v1/info/public-portfolio');
    expect(seen).not.toContain('/v1/info/position-fills');
  });

  it('returns fills oldest first, whatever order the venue sends', async () => {
    // The venue answers `sort=desc`. §5's fold is a running position, so reading it
    // backwards produces a different and wrong answer rather than an obvious error.
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    for (let i = 1; i < fills.length; i++) {
      expect(fills[i]!.ts).toBeGreaterThanOrEqual(fills[i - 1]!.ts);
    }
  });

  it('stops paging when a page repeats its cursor', async () => {
    // A cursor that does not advance is the one shape that pages forever. `more` says
    // to keep going, so only the repeat detects it.
    const stuck = new Map(store.history);
    stuck.set('', { data: [], more: true, cursor: '' });
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({ fetch: createPerpsFixtureFetch({ ...store, history: stuck }) }),
    });

    expect(fills).toEqual([]);
  });

  it('honours a time range without paging to the beginning of time', async () => {
    const all = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const from = all[all.length - 2]!.ts;

    const seen: string[] = [];
    const recent = await polymarketPerpsAdapter.fetchFills(
      INPUT,
      { from, to: Number.MAX_SAFE_INTEGER },
      { ...ctx({ fetch: createPerpsFixtureFetch(store, { onRequest: (p) => seen.push(p) }) }) },
    );

    expect(recent.every((f) => f.ts >= from)).toBe(true);
    // A descending walk that has already passed `from` can only go further back.
    expect(seen.filter((p) => p === '/v1/info/fills').length).toBeLessThan(3);
  });

  it('warns rather than crashing on an instrument missing from the venue list', async () => {
    const warnings: AdapterWarning[] = [];
    const odd = new Map(store.history);
    odd.set('', {
      data: [
        {
          trade_id: '1',
          instrument_id: 999,
          side: 'long',
          price: '1',
          quantity: '1',
          fee: '0',
          timestamp: 1,
          previous_size: '0',
          previous_entry_price: '0',
        },
      ],
      more: false,
    });

    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, {
      ...ctx({
        fetch: createPerpsFixtureFetch({ ...store, history: odd }),
        onWarning: (w) => warnings.push(w),
      }),
    });

    expect(fills).toEqual([]);
    expect(warnings.map((w) => w.kind)).toContain('unknown_instrument');
  });

  it('explains a wrong address space instead of reporting an empty account', async () => {
    // SPEC §4.5: "Do not ship a resolver that silently returns 'no positions' for a
    // valid trader — that reads as a bug in our app, not as an address mismatch."
    // Probed live, a Polymarket proxy wallet gets exactly this 400 from Perps.
    const fetchNotFound = createPerpsFixtureFetch(store, {
      failWith: (path) => (path === '/v1/info/fills' ? 400 : undefined),
      body: () => JSON.stringify({ status: 'err', error: 'account not found' }),
    });

    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx({ fetch: fetchNotFound })),
    ).rejects.toThrow(UnknownAccountError);
    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx({ fetch: fetchNotFound })),
    ).rejects.toThrow(/proxy wallet/);
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

  it('reconstructs a position that has already closed', async () => {
    // The whole point of moving off option A. Under it this episode did not exist at
    // all: `position-fills` serves only the current open cycle.
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const episodes = buildEpisodes(fills, { venue: 'polymarket-perps' });

    const closed = episodes.filter((e) => e.closedAt !== null);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[0]!.instrument).toContain('pm:');
    expect(episodes.some((e) => e.closedAt === null)).toBe(true);
  });

  it('surfaces the liquidation flag through to the episode', async () => {
    const fills = await polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx());
    const liquidated = fills.filter((f) => f.liquidation);

    expect(liquidated).toHaveLength(1);
    expect(liquidated[0]!.displayName).toBe('BTC-PERP');
  });
});

describe('listInstruments', () => {
  it('lists every market the venue serves', async () => {
    const listed = await polymarketPerpsAdapter.listInstruments!(ctx());

    expect(listed.length).toBeGreaterThanOrEqual(3);
    expect(listed.map((i) => i.displayName)).toContain('BTC-PERP');
  });

  it('returns the instrument key fetchSeries actually takes', async () => {
    // A picker that hands back a display name would produce a replay that 404s at the
    // venue. Round-tripping one entry through fetchSeries is the only way to know.
    const listed = await polymarketPerpsAdapter.listInstruments!(ctx());
    const btc = listed.find((i) => i.displayName === 'BTC-PERP')!;

    expect(btc.instrument).toMatch(/^pm:\d+$/);
    await expect(
      polymarketPerpsAdapter.fetchSeries(
        { instrument: btc.instrument, interval: '1h', from: 0, to: Number.MAX_SAFE_INTEGER },
        ctx(),
      ),
    ).resolves.toBeDefined();
  });

  it('is sorted by name, because 67 markets in id order is not a picker', async () => {
    const names = (await polymarketPerpsAdapter.listInstruments!(ctx())).map((i) => i.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
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
      failWith: (path) => (path === '/v1/info/fills' ? 413 : undefined),
    });

    await expect(
      polymarketPerpsAdapter.fetchFills(INPUT, undefined, ctx({ fetch })),
    ).rejects.toThrow(HistoryTooOldError);
  });

  it('does not retry a 413', async () => {
    let calls = 0;
    const fetch = createPerpsFixtureFetch(store, {
      failWith: (path) => {
        if (path !== '/v1/info/fills') return undefined;
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
