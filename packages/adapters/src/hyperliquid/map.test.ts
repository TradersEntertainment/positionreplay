import { describe, expect, it } from 'vitest';
import {
  coinForInstrument,
  instrumentKeyFor,
  mapCandles,
  mapFill,
  mapFunding,
  actionForDir,
} from './map.js';
import type { HlCandle, HlFill, HlFundingEntry } from './schemas.js';
import type { AdapterWarning } from '../types.js';

const baseFill: HlFill = {
  coin: 'HYPE',
  px: 13.9,
  sz: 100,
  side: 'B',
  time: 1_700_000_000_000,
  tid: 12345,
  fee: 0.5,
  feeToken: 'USDC',
  dir: 'Open Long',
  closedPnl: 0,
};

describe('instrument naming', () => {
  it('maps a plain coin to a PERP instrument key', () => {
    expect(instrumentKeyFor('HYPE')).toEqual({
      instrument: 'HYPE-PERP',
      displayName: 'HYPE PERP',
    });
  });

  it('preserves a HIP-3 dex prefix (SPEC §4.3)', () => {
    expect(instrumentKeyFor('xyz:XYZ100')).toEqual({
      instrument: 'xyz:XYZ100-PERP',
      displayName: 'XYZ100 PERP (xyz)',
    });
  });

  it('round-trips back to the coin the venue expects for candle requests', () => {
    for (const coin of ['HYPE', 'BTC', 'xyz:XYZ100']) {
      expect(coinForInstrument(instrumentKeyFor(coin).instrument)).toBe(coin);
    }
  });
});

describe('mapFill — side (SPEC §4.3: "A"=sell/ask, "B"=buy/bid)', () => {
  it('maps B to buy', () => {
    expect(mapFill({ ...baseFill, side: 'B' }).side).toBe('buy');
  });

  it('maps A to sell', () => {
    expect(mapFill({ ...baseFill, side: 'A' }).side).toBe('sell');
  });
});

describe('mapFill — fields', () => {
  it('carries price, size, timestamp, fee and the venue dir label across', () => {
    const f = mapFill(baseFill);
    expect(f.price).toBe(13.9);
    expect(f.size).toBe(100);
    expect(f.ts).toBe(1_700_000_000_000);
    expect(f.fee).toBe(0.5);
    expect(f.dir).toBe('Open Long');
    expect(f.instrument).toBe('HYPE-PERP');
    expect(f.raw).toEqual(baseFill);
  });

  it('uses the venue trade id as the dedupe key', () => {
    expect(mapFill(baseFill).id).toBe('hl:12345');
  });

  it('keeps size absolute even for a sell', () => {
    expect(mapFill({ ...baseFill, side: 'A' }).size).toBe(100);
  });

  it('omits closedPnl when the venue did not report one', () => {
    const { closedPnl: _drop, ...withoutPnl } = baseFill;
    expect(mapFill(withoutPnl).closedPnl).toBeUndefined();
  });

  it('keeps a reported closedPnl, including a negative one', () => {
    expect(mapFill({ ...baseFill, closedPnl: -42.5 }).closedPnl).toBe(-42.5);
  });
});

describe('mapFill — non-USD fees (SPEC §11 case 11)', () => {
  it('keeps a USDC fee as-is and warns about nothing', () => {
    const warnings: AdapterWarning[] = [];
    const f = mapFill({ ...baseFill, feeToken: 'USDC' }, (w) => warnings.push(w));
    expect(f.fee).toBe(0.5);
    expect(warnings).toHaveLength(0);
  });

  it('excludes a fee paid in another token and says so', () => {
    const warnings: AdapterWarning[] = [];
    const f = mapFill({ ...baseFill, feeToken: 'HYPE', fee: 0.5 }, (w) => warnings.push(w));

    // No FX source is in scope, so the honest option is to exclude and label it
    // rather than silently mix a HYPE amount into a USD total.
    expect(f.fee).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('non_usd_fee');
    expect(warnings[0]!.detail).toMatchObject({ feeToken: 'HYPE', excludedFee: 0.5 });
  });

  it('treats a missing feeToken as USDC, the venue default', () => {
    const warnings: AdapterWarning[] = [];
    const { feeToken: _drop, ...noToken } = baseFill;
    expect(mapFill(noToken, (w) => warnings.push(w)).fee).toBe(0.5);
    expect(warnings).toHaveLength(0);
  });
});

describe('actionForDir — the §5 cross-check', () => {
  it('translates every dir string Hyperliquid emits into a neutral action', () => {
    expect(actionForDir('Open Long')).toEqual(['open', 'scale_in']);
    expect(actionForDir('Open Short')).toEqual(['open', 'scale_in']);
    expect(actionForDir('Close Long')).toEqual(['close', 'reduce']);
    expect(actionForDir('Close Short')).toEqual(['close', 'reduce']);
    expect(actionForDir('Long > Short')).toEqual(['flip_out', 'flip_in']);
    expect(actionForDir('Short > Long')).toEqual(['flip_out', 'flip_in']);
  });

  it('returns null for a label it does not recognise rather than guessing', () => {
    expect(actionForDir('Spot Dust Conversion')).toBeNull();
    expect(actionForDir(undefined)).toBeNull();
  });
});

describe('mapCandles', () => {
  const candles: HlCandle[] = [
    { t: 1_000, o: 10, h: 12, l: 9, c: 11, v: 100 },
    { t: 2_000, o: 11, h: 13, l: 10, c: 12, v: 120 },
  ];

  it('produces an ohlcv PriceSeries in bar order', () => {
    const series = mapCandles('HYPE-PERP', '1m', candles);
    expect(series.kind).toBe('ohlcv');
    if (series.kind !== 'ohlcv') throw new Error('unreachable');
    expect(series.candles).toHaveLength(2);
    expect(series.candles[0]).toEqual({ t: 1_000, o: 10, h: 12, l: 9, c: 11, v: 100 });
    expect(series.interval).toBe('1m');
  });

  it('sorts and dedupes bars by open time', () => {
    const series = mapCandles('HYPE-PERP', '1m', [candles[1]!, candles[0]!, candles[0]!]);
    if (series.kind !== 'ohlcv') throw new Error('unreachable');
    expect(series.candles.map((c) => c.t)).toEqual([1_000, 2_000]);
  });
});

describe('mapFunding', () => {
  const entry: HlFundingEntry = {
    time: 1_700_000_000_000,
    hash: '0xabc',
    delta: { type: 'funding', coin: 'HYPE', usdc: -1.25, szi: 100, fundingRate: 0.0000125 },
  };

  it('preserves the venue sign: negative usdc means the trader paid', () => {
    const [event] = mapFunding([entry]);
    expect(event!.amount).toBe(-1.25);
    expect(event!.instrument).toBe('HYPE-PERP');
  });

  it('preserves a positive amount as funding received', () => {
    const [event] = mapFunding([{ ...entry, delta: { ...entry.delta, usdc: 0.75 } }]);
    expect(event!.amount).toBe(0.75);
  });

  it('marks Hyperliquid funding as actual, not estimated', () => {
    // Unlike Polymarket Perps (SPEC §4.4.2), HL reports the account's real charges.
    expect(mapFunding([entry])[0]!.isEstimate).toBe(false);
  });
});
