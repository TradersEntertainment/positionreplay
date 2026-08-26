import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpisodes } from '@trade-replay/core';
import { describe, expect, it } from 'vitest';
import { createFixtureFetch } from './fixtureFetch.js';
import { loadFixtureStore } from './fixtureStore.node.js';
import { HL_FILL_HISTORY_LIMIT, hyperliquidAdapter } from './index.js';
import { actionForDir } from './map.js';
import { VenueContractError } from './schemas.js';
import type { AdapterContext, AdapterWarning, FetchLike, HttpResponse } from '../types.js';
import { InvalidInputError, SeriesUnavailableError } from '../types.js';
import { createUnlimitedLimiter } from '../limiter.js';

const FIXTURE_DIR = join(
  fileURLToPath(new URL('../../../../', import.meta.url)),
  'fixtures/hyperliquid/synthetic',
);

const fixture = loadFixtureStore(FIXTURE_DIR);
const ADDRESS = '0x393d0b87ed38fc779fd9611144ae649ba6082109';

function ctxWithFixture(extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    fetch: createFixtureFetch(fixture),
    sleep: async () => undefined,
    limiter: createUnlimitedLimiter(),
    ...extra,
  };
}

/** Minimal HL-shaped fill, for the pagination stubs. */
function stubFill(tid: number, time: number) {
  return {
    coin: 'HYPE',
    px: '10',
    sz: '1',
    side: tid % 2 === 0 ? 'B' : 'A',
    time,
    tid,
    fee: '0.01',
    feeToken: 'USDC',
    dir: tid % 2 === 0 ? 'Open Long' : 'Close Long',
    closedPnl: '0',
  };
}

function jsonResponse(data: unknown): HttpResponse {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(data) };
}

describe('parseInput (SPEC §4.5)', () => {
  it('accepts a 0x address and normalizes its case', async () => {
    const input = await hyperliquidAdapter.parseInput(`  ${ADDRESS.toUpperCase().replace('0X', '0x')}  `);
    expect(input.address).toBe(ADDRESS);
    expect(input.venue).toBe('hyperliquid');
  });

  it('rejects an ENS name when no resolver is supplied, rather than guessing', async () => {
    await expect(hyperliquidAdapter.parseInput('vitalik.eth')).rejects.toThrow(InvalidInputError);
    await expect(hyperliquidAdapter.parseInput('vitalik.eth')).rejects.toThrow(/ENS resolution is not wired up/);
  });

  it('uses an injected ENS resolver when one is supplied', async () => {
    const input = await hyperliquidAdapter.parseInput('trader.eth', {
      resolveEns: async () => ADDRESS,
    });
    expect(input.address).toBe(ADDRESS);
    expect(input.label).toBe('trader.eth');
  });

  it('reports an unresolvable ENS name distinctly (§11 case 10)', async () => {
    await expect(
      hyperliquidAdapter.parseInput('nope.eth', { resolveEns: async () => null }),
    ).rejects.toThrow(/does not resolve/);
  });

  it('says plainly that Hyperliquid has no usernames (§4.5)', async () => {
    await expect(hyperliquidAdapter.parseInput('some_trader')).rejects.toThrow(
      /has no username system/,
    );
  });
});

describe('fetchFills against a recorded fixture', () => {
  it('returns every recorded fill, normalized', async () => {
    const fills = await hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, ctxWithFixture());

    expect(fills).toHaveLength(fixture.fills.length);
    expect(new Set(fills.map((f) => f.instrument))).toEqual(new Set(['HYPE-PERP', 'BTC-PERP']));
    for (const f of fills) {
      expect(Number.isFinite(f.price)).toBe(true);
      expect(f.size).toBeGreaterThan(0);
      expect(['buy', 'sell']).toContain(f.side);
    }
  });

  it('respects an explicit time range', async () => {
    const all = await hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, ctxWithFixture());
    const sorted = [...all].sort((a, b) => a.ts - b.ts);
    const cutoff = sorted[3]!.ts;

    const ranged = await hyperliquidAdapter.fetchFills(
      { venue: 'hyperliquid', address: ADDRESS },
      { from: cutoff, to: Number.MAX_SAFE_INTEGER },
      ctxWithFixture(),
    );

    expect(ranged.length).toBeLessThan(all.length);
    expect(Math.min(...ranged.map((f) => f.ts))).toBeGreaterThanOrEqual(cutoff);
  });
});

describe('fetchFills pagination (SPEC §4.3)', () => {
  it('pages by advancing startTime past the last fill', async () => {
    const requests: Record<string, unknown>[] = [];
    const page1 = Array.from({ length: 2000 }, (_, i) => stubFill(i, 1_000 + i));
    const page2 = Array.from({ length: 500 }, (_, i) => stubFill(2000 + i, 3_001 + i));

    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      return jsonResponse(Number(body['startTime']) <= 1_000 ? page1 : page2);
    };

    const fills = await hyperliquidAdapter.fetchFills(
      { venue: 'hyperliquid', address: ADDRESS },
      { from: 1_000, to: 10_000 },
      { fetch, sleep: async () => undefined, limiter: createUnlimitedLimiter() },
    );

    expect(fills).toHaveLength(2500);
    expect(requests).toHaveLength(2);
    // Second request must resume at lastFill.time + 1, not re-request the same window.
    expect(requests[1]!['startTime']).toBe(1_000 + 1999 + 1);
  });

  it('stops after a short page rather than requesting forever', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return jsonResponse([stubFill(1, 1_000)]);
    };

    await hyperliquidAdapter.fetchFills(
      { venue: 'hyperliquid', address: ADDRESS },
      { from: 0, to: 10_000 },
      { fetch, sleep: async () => undefined, limiter: createUnlimitedLimiter() },
    );

    expect(calls).toBe(1);
  });

  it('warns when a full page shares one millisecond and fills may be lost', async () => {
    const warnings: AdapterWarning[] = [];
    const collided = Array.from({ length: 2000 }, (_, i) => stubFill(i, 5_000));
    let served = false;

    const fetch: FetchLike = async () => {
      if (served) return jsonResponse([]);
      served = true;
      return jsonResponse(collided);
    };

    await hyperliquidAdapter.fetchFills(
      { venue: 'hyperliquid', address: ADDRESS },
      { from: 0, to: 10_000 },
      { fetch, sleep: async () => undefined, limiter: createUnlimitedLimiter(), onWarning: (w) => warnings.push(w) },
    );

    expect(warnings.map((w) => w.kind)).toContain('pagination_collision');
  });

  it('warns when history hits the venue ceiling (§11 case 9)', async () => {
    const warnings: AdapterWarning[] = [];
    let cursor = 0;

    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const start = Number(body['startTime']);
      if (cursor >= HL_FILL_HISTORY_LIMIT) return jsonResponse([]);
      const page = Array.from({ length: 2000 }, (_, i) => stubFill(cursor + i, start + i));
      cursor += 2000;
      return jsonResponse(page);
    };

    await hyperliquidAdapter.fetchFills(
      { venue: 'hyperliquid', address: ADDRESS },
      { from: 0, to: Number.MAX_SAFE_INTEGER },
      { fetch, sleep: async () => undefined, limiter: createUnlimitedLimiter(), onWarning: (w) => warnings.push(w) },
    );

    const truncation = warnings.find((w) => w.kind === 'fill_history_truncated');
    expect(truncation).toBeDefined();
    expect(truncation!.message).toMatch(/Fill history unavailable before/);
  });

  it('does NOT cry truncation for a wallet that simply traded little', async () => {
    const warnings: AdapterWarning[] = [];
    await hyperliquidAdapter.fetchFills(
      { venue: 'hyperliquid', address: ADDRESS },
      undefined,
      ctxWithFixture({ onWarning: (w) => warnings.push(w) }),
    );
    expect(warnings.filter((w) => w.kind === 'fill_history_truncated')).toHaveLength(0);
  });
});

describe('fetchSeries', () => {
  it('returns an ohlcv series for a recorded interval', async () => {
    const series = await hyperliquidAdapter.fetchSeries(
      { instrument: 'HYPE-PERP', interval: '1h', from: 0, to: Number.MAX_SAFE_INTEGER },
      ctxWithFixture(),
    );

    expect(series.kind).toBe('ohlcv');
    if (series.kind !== 'ohlcv') throw new Error('unreachable');
    expect(series.candles.length).toBeGreaterThan(100);
    for (let i = 1; i < series.candles.length; i++) {
      expect(series.candles[i]!.t).toBeGreaterThan(series.candles[i - 1]!.t);
    }
  });

  it('throws a clear error when the venue has no candles (§11 case 8)', async () => {
    await expect(
      hyperliquidAdapter.fetchSeries(
        { instrument: 'DELISTED-PERP', interval: '1h', from: 0, to: 10_000 },
        ctxWithFixture(),
      ),
    ).rejects.toThrow(SeriesUnavailableError);
  });

  it('asks the venue for the un-suffixed coin, HIP-3 prefix intact', async () => {
    const seen: Record<string, unknown>[] = [];
    const fetch = createFixtureFetch(fixture, { onRequest: (b) => seen.push(b) });

    await hyperliquidAdapter
      .fetchSeries({ instrument: 'HYPE-PERP', interval: '1h', from: 0, to: 1 }, { fetch, sleep: async () => undefined, limiter: createUnlimitedLimiter() })
      .catch(() => undefined);

    expect((seen[0]!['req'] as Record<string, unknown>)['coin']).toBe('HYPE');
  });
});

describe('fetchFunding', () => {
  it('maps recorded funding, preserving sign', async () => {
    const events = await hyperliquidAdapter.fetchFunding!(
      { venue: 'hyperliquid', address: ADDRESS },
      { from: 0, to: Number.MAX_SAFE_INTEGER },
      ctxWithFixture(),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.amount < 0)).toBe(true);
    for (const e of events) expect(e.isEstimate).toBe(false);
  });
});

describe('error handling', () => {
  it('surfaces a schema mismatch as a diagnostic VenueContractError', async () => {
    const fetch: FetchLike = async () => jsonResponse([{ coin: 'HYPE', px: 'not-a-number' }]);

    await expect(
      hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, {
        fetch,
        sleep: async () => undefined,
        limiter: createUnlimitedLimiter(),
      }),
    ).rejects.toThrow(VenueContractError);
  });

  it('names the keys it actually received, so a contract change is debuggable', async () => {
    const fetch: FetchLike = async () => jsonResponse([{ symbol: 'HYPE', price: '1' }]);

    await expect(
      hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, {
        fetch,
        sleep: async () => undefined,
        limiter: createUnlimitedLimiter(),
      }),
    ).rejects.toThrow(/keys received: symbol, price/);
  });

  it('does not retry a 4xx', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return { ok: false, status: 422, headers: { get: () => null }, text: async () => 'nope' };
    };

    await expect(
      hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, {
        fetch,
        sleep: async () => undefined,
        limiter: createUnlimitedLimiter(),
      }),
    ).rejects.toThrow(/422/);
    expect(calls).toBe(1);
  });
});

/**
 * SPEC §5 sanity assertions. §4.3: "`dir` is a free lunch: it already says
 * 'Open Long' / 'Close Long' / 'Long > Short'. Use it as a cross-check against our
 * own reconstruction, not as the source of truth — assert they agree in tests."
 *
 * HONESTY NOTE: against the *synthetic* fixture this check is partly circular — that
 * fixture's dir/closedPnl values were produced by folding the same way. What it
 * genuinely proves is that the plumbing works and that a regression in the fold would
 * be caught. The non-circular version of this check is `pnpm verify:m1`, which runs
 * it against real venue data. Point FIXTURE_DIR at a captured fixture and these same
 * assertions become a real cross-check.
 */
describe('reconstruction cross-checks against the venue', () => {
  it('agrees with the venue dir label on every fill', async () => {
    const fills = await hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, ctxWithFixture());
    const episodes = buildEpisodes(fills, { venue: 'hyperliquid' });

    let checked = 0;
    for (const episode of episodes) {
      for (const step of episode.steps) {
        const permitted = actionForDir(step.fill.dir);
        if (!permitted) continue;
        expect(
          permitted,
          `fill ${step.fill.id} dir="${step.fill.dir}" but we derived "${step.action}"`,
        ).toContain(step.action);
        checked++;
      }
    }

    expect(checked, 'no dir labels were actually cross-checked').toBeGreaterThan(0);
  });

  it('agrees with the venue closedPnl on every closing fill', async () => {
    const fills = await hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, ctxWithFixture());
    const episodes = buildEpisodes(fills, { venue: 'hyperliquid' });

    const notes = episodes.flatMap((e) => e.reconciliation);
    expect(notes, `unreconciled: ${JSON.stringify(notes)}`).toHaveLength(0);
  });

  it('reconstructs the flip in the fixture as two episodes at one timestamp', async () => {
    const fills = await hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, ctxWithFixture());
    const episodes = buildEpisodes(fills, { venue: 'hyperliquid' });

    const flipped = episodes.filter((e) => e.steps.some((s) => s.action === 'flip_out'));
    expect(flipped).toHaveLength(1);

    const flipOut = flipped[0]!;
    const flipIn = episodes.find(
      (e) => e.openedAt === flipOut.closedAt && e.instrument === flipOut.instrument && e.id !== flipOut.id,
    );
    expect(flipIn).toBeDefined();
    expect(flipIn!.direction).not.toBe(flipOut.direction);
  });

  it('closes every episode in the fixture', async () => {
    const fills = await hyperliquidAdapter.fetchFills({ venue: 'hyperliquid', address: ADDRESS }, undefined, ctxWithFixture());
    const episodes = buildEpisodes(fills, { venue: 'hyperliquid' });

    expect(episodes.length).toBeGreaterThanOrEqual(4);
    for (const e of episodes) expect(e.closedAt).not.toBeNull();
  });
});
