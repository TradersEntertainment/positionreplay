import { buildEpisodes } from '@trade-replay/core';
import { describe, expect, it } from 'vitest';
import {
  forwardFill,
  instrumentKeyFor,
  instrumentIdFor,
  mapKlines,
  mapMarkHistory,
  mapPerpsFill,
} from './map.js';
import { PmInstrumentsSchema, PmKlinesSchema, PmMarkHistorySchema } from './schemas.js';
import type { PmFill, PmInstrument } from './schemas.js';

const BTC: PmInstrument = {
  instrument_id: 1,
  symbol: 'BTC-PERP',
  quantity_decimals: 4,
  price_decimals: 1,
};

const base: PmFill = {
  trade_id: '900',
  instrument_id: 1,
  side: 'long',
  price: 92_000,
  quantity: 0.5,
  fee: 4.6,
  timestamp: 1_762_000_000_000,
  previous_size: 0,
  previous_entry_price: 0,
  pnl: 0,
};

describe('PmInstrumentSchema', () => {
  /**
   * The exact key set the live endpoint returned, from the error that took Perps down
   * in production. Values for the unread keys are stand-ins on purpose: the point is
   * that this parses whatever they are.
   */
  const live = {
    instrument_id: 7,
    instrument_type: 'perpetual',
    category: 'crypto',
    isolated_only: false,
    symbol: 'ETH-PERP',
    base_asset: 'ETH',
    quote_asset: 'pUSD',
    funding_interval: '1h',
    quantity_decimals: 4,
    price_decimals: 1,
    price_bounds: { min: '0.1', max: '900000' },
    liquidation_fee: '0.015',
    max_order_count: 200,
    min_notional: '10',
    max_market_notional: '250000',
    max_limit_notional: '1000000',
    max_leverage: '20',
    risk_tiers: [{ tier: 1, max_notional: '50000' }],
    ui_live_time: '2026-01-01T00:00:00Z',
  };

  it('parses the live payload, including keys it does not model', () => {
    const parsed = PmInstrumentsSchema.parse([live]);
    expect(parsed[0]).toMatchObject({
      instrument_id: 7,
      symbol: 'ETH-PERP',
      quantity_decimals: 4,
      price_decimals: 1,
    });
  });

  it('does not fail on a field no code path reads', () => {
    // This is the regression. `funding_interval` was declared as an integer, came back
    // as something else, and failed the parse for all 67 instruments — so every Perps
    // replay died over a value that is never used for anything.
    for (const funding_interval of ['1h', 3.5, null, { seconds: 3600 }, undefined]) {
      expect(() => PmInstrumentsSchema.parse([{ ...live, funding_interval }])).not.toThrow();
    }
  });

  it('still refuses an instrument missing something the fold depends on', () => {
    // The other half of the rule. These four round every price and size that reaches
    // §5, so a missing one is a wrong number rather than a missing decoration.
    for (const key of ['instrument_id', 'symbol', 'quantity_decimals', 'price_decimals']) {
      const broken: Record<string, unknown> = { ...live };
      delete broken[key];
      expect(() => PmInstrumentsSchema.parse([broken]), key).toThrow();
    }
  });

  it('refuses a decimal count that is not a whole number', () => {
    expect(() => PmInstrumentsSchema.parse([{ ...live, price_decimals: 1.5 }])).toThrow();
  });
});

describe('the kline and mark-history tuples', () => {
  const row = [1_762_000_000_000, 92_000, 92_500, 91_800, 92_100, 1_200];

  it('accepts a row with the documented trailing trade count', () => {
    expect(() => PmKlinesSchema.parse({ data: [[...row, 87]], more: false })).not.toThrow();
  });

  it('accepts a row with more or fewer trailing columns than documented', () => {
    // Same lesson as the instruments schema: a strict tuple turns an extra column the
    // renderer never reads into a dead venue.
    expect(() => PmKlinesSchema.parse({ data: [row], more: false })).not.toThrow();
    expect(() => PmKlinesSchema.parse({ data: [[...row, 87, 'x', null]] })).not.toThrow();
  });

  it('still refuses a row missing a value the candle is drawn from', () => {
    expect(() => PmKlinesSchema.parse({ data: [row.slice(0, 5)] })).toThrow();
  });

  it('reads mark history as bucket and price, whatever trails them', () => {
    const parsed = PmMarkHistorySchema.parse({ data: [[1_762_000_000_000, 92_000, 'extra']] });
    expect(parsed.data[0]!.slice(0, 2)).toEqual([1_762_000_000_000, 92_000]);
  });
});

describe('instrument keys', () => {
  it('uses the integer id, which every other Perps call needs', () => {
    // SPEC §4.2 specifies "pm:1" as the instrument key for Perps.
    expect(instrumentKeyFor(BTC)).toEqual({ instrument: 'pm:1', displayName: 'BTC-PERP' });
  });

  it('round-trips back to the id', () => {
    expect(instrumentIdFor('pm:1')).toBe(1);
    expect(instrumentIdFor('pm:42')).toBe(42);
  });

  it('refuses a key that is not a Perps instrument', () => {
    expect(instrumentIdFor('HYPE-PERP')).toBeNull();
    expect(instrumentIdFor('pm:notanumber')).toBeNull();
  });
});

/**
 * SPEC §4.4.3: side is "long"/"short", not buy/sell — "and be careful: a `long` fill
 * can be *closing* a short."
 */
describe('mapPerpsFill — side', () => {
  it('maps long to buy and short to sell', () => {
    expect(mapPerpsFill({ ...base, side: 'long' }, BTC).side).toBe('buy');
    expect(mapPerpsFill({ ...base, side: 'short' }, BTC).side).toBe('sell');
  });

  it('does not treat side as open-versus-close', () => {
    // A "long" fill against a short position is a close. The fold decides that from
    // net size; the mapping only records the trade's direction.
    const closingAShort = mapPerpsFill(
      { ...base, side: 'long', previous_size: -0.5, previous_entry_price: 95_000 },
      BTC,
    );
    expect(closingAShort.side).toBe('buy');

    const episodes = buildEpisodes(
      [
        mapPerpsFill(
          { ...base, trade_id: '1', side: 'short', price: 95_000, quantity: 0.5 },
          BTC,
        ),
        mapPerpsFill(
          {
            ...base,
            trade_id: '2',
            side: 'long',
            price: 92_000,
            quantity: 0.5,
            timestamp: base.timestamp + 60_000,
            previous_size: -0.5,
            previous_entry_price: 95_000,
            pnl: 1_500,
          },
          BTC,
        ),
      ],
      { venue: 'polymarket-perps' },
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.direction).toBe('short');
    expect(episodes[0]!.realizedPnl).toBeCloseTo(1_500, 6);
  });
});

describe('mapPerpsFill — fields', () => {
  it('carries price, size, fee and the venue pnl across', () => {
    const fill = mapPerpsFill({ ...base, pnl: -12.5 }, BTC);
    expect(fill.price).toBe(92_000);
    expect(fill.size).toBe(0.5);
    expect(fill.fee).toBe(4.6);
    expect(fill.closedPnl).toBe(-12.5);
    expect(fill.instrument).toBe('pm:1');
    expect(fill.displayName).toBe('BTC-PERP');
  });

  it('uses the venue trade id as the dedupe key', () => {
    expect(mapPerpsFill(base, BTC).id).toBe('pm:900');
  });

  it('keeps size absolute for a short', () => {
    expect(mapPerpsFill({ ...base, side: 'short' }, BTC).size).toBe(0.5);
  });

  it('rounds to the instrument decimals rather than carrying float noise', () => {
    // §4.4.3: "Prices and quantities are decimal strings. Parse deliberately (respect
    // price_decimals / quantity_decimals from the instrument)."
    const fill = mapPerpsFill({ ...base, price: 92_000.06789, quantity: 0.123456789 }, BTC);
    expect(fill.price).toBe(92_000.1);
    expect(fill.size).toBe(0.1235);
  });

  it('carries the liquidation and adl flags (§4.4.3)', () => {
    expect(mapPerpsFill({ ...base, liquidation: true }, BTC).liquidation).toBe(true);
    expect(mapPerpsFill({ ...base, adl: true }, BTC).adl).toBe(true);
    // Absent means absent, not false-by-fabrication.
    expect(mapPerpsFill(base, BTC).liquidation).toBeUndefined();
  });

  it('keeps the raw payload for the previous_size oracle', () => {
    expect(mapPerpsFill(base, BTC).raw).toEqual(base);
  });
});

describe('mapKlines', () => {
  it('reads the tuple-array shape, not objects', () => {
    // SPEC §4.4.2: [[ts, o, h, l, c, volume, trades], ...] — unlike Hyperliquid.
    const series = mapKlines('pm:1', '1h', [
      [1_000, 10, 12, 9, 11, 100, 5],
      [2_000, 11, 13, 10, 12, 120, 6],
    ]);

    expect(series.kind).toBe('ohlcv');
    if (series.kind !== 'ohlcv') throw new Error('unreachable');
    expect(series.candles[0]).toEqual({ t: 1_000, o: 10, h: 12, l: 9, c: 11, v: 100 });
  });

  it('sorts and dedupes by bucket', () => {
    const series = mapKlines('pm:1', '1h', [
      [2_000, 11, 13, 10, 12, 120, 6],
      [1_000, 10, 12, 9, 11, 100, 5],
      [1_000, 10, 12, 9, 11, 100, 5],
    ]);
    if (series.kind !== 'ohlcv') throw new Error('unreachable');
    expect(series.candles.map((c) => c.t)).toEqual([1_000, 2_000]);
  });
});

/**
 * SPEC §4.4.2: "Only buckets containing at least one mark update are returned, so the
 * series is sparse: forward-fill before rendering."
 */
describe('forwardFill', () => {
  it('fills the gaps a sparse series leaves', () => {
    const filled = forwardFill(
      [
        [0, 100],
        [3_000, 105],
      ],
      1_000,
    );

    expect(filled).toEqual([
      { t: 0, p: 100 },
      { t: 1_000, p: 100 },
      { t: 2_000, p: 100 },
      { t: 3_000, p: 105 },
    ]);
  });

  it('leaves a dense series untouched', () => {
    const dense: [number, number][] = [
      [0, 100],
      [1_000, 101],
      [2_000, 102],
    ];
    expect(forwardFill(dense, 1_000)).toEqual([
      { t: 0, p: 100 },
      { t: 1_000, p: 101 },
      { t: 2_000, p: 102 },
    ]);
  });

  it('handles an empty or single-point series', () => {
    expect(forwardFill([], 1_000)).toEqual([]);
    expect(forwardFill([[5, 7]], 1_000)).toEqual([{ t: 5, p: 7 }]);
  });

  it('refuses to expand an absurd gap into millions of points', () => {
    // A one-second interval across a month would be 2.6 million points; a replay does
    // not need them and the browser cannot hold them.
    const filled = forwardFill(
      [
        [0, 100],
        [30 * 24 * 3_600_000, 200],
      ],
      1_000,
    );
    expect(filled.length).toBeLessThan(100_000);
    expect(filled.at(-1)).toEqual({ t: 30 * 24 * 3_600_000, p: 200 });
  });

  it('sorts before filling, since order is not guaranteed', () => {
    const filled = forwardFill(
      [
        [2_000, 102],
        [0, 100],
      ],
      1_000,
    );
    expect(filled.map((p) => p.t)).toEqual([0, 1_000, 2_000]);
  });
});

describe('mapMarkHistory', () => {
  it('produces a forward-filled line series', () => {
    const series = mapMarkHistory('pm:1', '1s', [[0, 100], [2_000, 102]], 1_000);
    expect(series.kind).toBe('line');
    if (series.kind !== 'line') throw new Error('unreachable');
    expect(series.points).toEqual([
      { t: 0, p: 100 },
      { t: 1_000, p: 100 },
      { t: 2_000, p: 102 },
    ]);
  });
});
