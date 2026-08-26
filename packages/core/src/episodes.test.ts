import { describe, expect, it } from 'vitest';
import { buildEpisodes } from './episodes.js';
import { fill, funding, mulberry32 } from './test-helpers.js';
import { SIZE_EPS } from './types.js';

const HL = { venue: 'hyperliquid' } as const;

describe('buildEpisodes — basic shapes', () => {
  it('reconstructs a simple long open -> close', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 2_000, side: 'sell', price: 110, size: 10 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(1);
    const e = eps[0]!;
    expect(e.direction).toBe('long');
    expect(e.openedAt).toBe(1_000);
    expect(e.closedAt).toBe(2_000);
    expect(e.avgEntry).toBeCloseTo(100, 12);
    expect(e.realizedPnl).toBeCloseTo(100, 12);
    expect(e.peakSize).toBeCloseTo(10, 12);
    expect(e.boughtNotional).toBeCloseTo(1_000, 12);
    expect(e.soldNotional).toBeCloseTo(1_100, 12);
    expect(e.closingNetSize).toBe(0);
  });

  it('reconstructs a simple short open -> close, profiting on a fall', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'sell', price: 100, size: 4 }),
        fill({ ts: 2_000, side: 'buy', price: 90, size: 4 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(1);
    const e = eps[0]!;
    expect(e.direction).toBe('short');
    expect(e.realizedPnl).toBeCloseTo(40, 12);
    expect(e.closedAt).toBe(2_000);
  });

  it('weights average entry by size on a scale-in', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 1 }),
        fill({ ts: 1_500, side: 'buy', price: 200, size: 9 }),
        fill({ ts: 2_000, side: 'sell', price: 200, size: 10 }),
      ],
      HL,
    );

    const e = eps[0]!;
    expect(e.avgEntry).toBeCloseTo(190, 12);
    expect(e.realizedPnl).toBeCloseTo(100, 12);
    expect(e.peakSize).toBeCloseTo(10, 12);
  });

  it('leaves closedAt null while the position is still open (§11 case 1)', () => {
    const eps = buildEpisodes([fill({ ts: 1_000, side: 'buy', price: 100, size: 10 })], HL);

    expect(eps).toHaveLength(1);
    expect(eps[0]!.closedAt).toBeNull();
    expect(eps[0]!.closingNetSize).toBeCloseTo(10, 12);
  });
});

describe('buildEpisodes — §11 edge cases', () => {
  it('handles a scale-in AFTER a partial close (§11 case 3)', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 2_000, side: 'sell', price: 120, size: 4 }), // partial close: +80
        fill({ ts: 3_000, side: 'buy', price: 150, size: 4 }), // scale back in
        fill({ ts: 4_000, side: 'sell', price: 200, size: 10 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(1);
    const e = eps[0]!;
    // A partial close must NOT move average entry: still 100 over the remaining 6.
    // Then 6 @ 100 + 4 @ 150 -> 120.
    expect(e.avgEntry).toBeCloseTo(120, 12);
    // 80 from the partial close, plus (200-120)*10 = 800.
    expect(e.realizedPnl).toBeCloseTo(880, 12);
    expect(e.peakSize).toBeCloseTo(10, 12);
    expect(e.closedAt).toBe(4_000);
  });

  it('splits a single flip fill into two episodes at the same timestamp (§11 case 2)', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        // sell 15: closes the 10-long and opens a 5-short, all at 120
        fill({ ts: 2_000, side: 'sell', price: 120, size: 15, dir: 'Long > Short' }),
        fill({ ts: 3_000, side: 'buy', price: 110, size: 5 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(2);
    const [long, short] = eps as [(typeof eps)[number], (typeof eps)[number]];

    expect(long.direction).toBe('long');
    expect(long.closedAt).toBe(2_000);
    expect(long.realizedPnl).toBeCloseTo(200, 12);

    expect(short.direction).toBe('short');
    expect(short.openedAt).toBe(2_000);
    expect(short.avgEntry).toBeCloseTo(120, 12);
    expect(short.realizedPnl).toBeCloseTo(50, 12);
    expect(short.closedAt).toBe(3_000);

    // Both episodes must be addressable — a flip means two episodes share openedAt/instrument.
    expect(long.id).not.toBe(short.id);
  });

  it('splits the flip fill notional between the two episodes', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 2_000, side: 'sell', price: 120, size: 15, fee: 3 }),
      ],
      HL,
    );

    const [long, short] = eps as [(typeof eps)[number], (typeof eps)[number]];
    // 15 sold @120 = 1800 notional: 10/15 closes the long, 5/15 opens the short.
    expect(long.soldNotional).toBeCloseTo(1_200, 12);
    expect(short.soldNotional).toBeCloseTo(600, 12);
    // Fee splits on the same proportion.
    expect(long.totalFees).toBeCloseTo(2, 12);
    expect(short.totalFees).toBeCloseTo(1, 12);
  });

  it('keeps two episodes on the same instrument separate even within one candle (§11 case 4)', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 1 }),
        fill({ ts: 1_010, side: 'sell', price: 101, size: 1 }),
        fill({ ts: 1_020, side: 'buy', price: 102, size: 1 }),
        fill({ ts: 1_030, side: 'sell', price: 103, size: 1 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(2);
    expect(eps[0]!.id).not.toBe(eps[1]!.id);
    expect(eps[0]!.realizedPnl).toBeCloseTo(1, 12);
    expect(eps[1]!.realizedPnl).toBeCloseTo(1, 12);
  });
});

describe('buildEpisodes — input hygiene', () => {
  it('sorts unsorted input before folding', () => {
    const eps = buildEpisodes(
      [
        fill({ id: 'b', ts: 2_000, side: 'sell', price: 110, size: 10 }),
        fill({ id: 'a', ts: 1_000, side: 'buy', price: 100, size: 10 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(1);
    expect(eps[0]!.direction).toBe('long');
    expect(eps[0]!.realizedPnl).toBeCloseTo(100, 12);
  });

  it('breaks ties on equal timestamps by id, deterministically', () => {
    const build = (order: string[]) =>
      buildEpisodes(
        order.map((id) =>
          id === 'a'
            ? fill({ id: 'a', ts: 1_000, side: 'buy', price: 100, size: 10 })
            : fill({ id: 'b', ts: 1_000, side: 'sell', price: 110, size: 10 }),
        ),
        HL,
      );

    expect(build(['a', 'b'])[0]!.realizedPnl).toBeCloseTo(build(['b', 'a'])[0]!.realizedPnl, 12);
  });

  it('dedupes by fill id', () => {
    const eps = buildEpisodes(
      [
        fill({ id: 'dup', ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ id: 'dup', ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ id: 'close', ts: 2_000, side: 'sell', price: 110, size: 10 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(1);
    expect(eps[0]!.fills).toHaveLength(2);
    expect(eps[0]!.closedAt).toBe(2_000);
  });

  it('groups by instrument so two symbols never merge', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10, instrument: 'HYPE-PERP' }),
        fill({ ts: 1_100, side: 'buy', price: 50, size: 2, instrument: 'BTC-PERP' }),
        fill({ ts: 2_000, side: 'sell', price: 110, size: 10, instrument: 'HYPE-PERP' }),
        fill({ ts: 2_100, side: 'sell', price: 60, size: 2, instrument: 'BTC-PERP' }),
      ],
      HL,
    );

    expect(eps).toHaveLength(2);
    expect(eps.map((e) => e.instrument).sort()).toEqual(['BTC-PERP', 'HYPE-PERP']);
  });
});

describe('buildEpisodes — fees and funding', () => {
  it('attributes each fee to the episode open when the fill landed', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 1, fee: 1 }),
        fill({ ts: 2_000, side: 'sell', price: 100, size: 1, fee: 2 }),
        fill({ ts: 3_000, side: 'buy', price: 100, size: 1, fee: 4 }),
        fill({ ts: 4_000, side: 'sell', price: 100, size: 1, fee: 8 }),
      ],
      HL,
    );

    expect(eps).toHaveLength(2);
    expect(eps[0]!.totalFees).toBeCloseTo(3, 12);
    expect(eps[1]!.totalFees).toBeCloseTo(12, 12);
  });

  it('attributes funding to whichever episode was open at that timestamp', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 1 }),
        fill({ ts: 3_000, side: 'sell', price: 100, size: 1 }),
        fill({ ts: 5_000, side: 'buy', price: 100, size: 1 }),
        fill({ ts: 7_000, side: 'sell', price: 100, size: 1 }),
      ],
      {
        ...HL,
        funding: [
          funding({ ts: 2_000, amount: -5 }), // paid, inside episode 1
          funding({ ts: 4_000, amount: -99 }), // between episodes -> dropped
          funding({ ts: 6_000, amount: 7 }), // received, inside episode 2
        ],
      },
    );

    expect(eps[0]!.totalFunding).toBeCloseTo(-5, 12);
    expect(eps[1]!.totalFunding).toBeCloseTo(7, 12);
    expect(eps[0]!.funding).toHaveLength(1);
    expect(eps[1]!.funding).toHaveLength(1);
  });

  it('includes funding landing exactly on the open and close boundaries', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 1 }),
        fill({ ts: 3_000, side: 'sell', price: 100, size: 1 }),
      ],
      {
        ...HL,
        funding: [funding({ ts: 1_000, amount: -1 }), funding({ ts: 3_000, amount: -2 })],
      },
    );

    expect(eps[0]!.totalFunding).toBeCloseTo(-3, 12);
  });

  it('attributes funding to a still-open episode with no end bound', () => {
    const eps = buildEpisodes([fill({ ts: 1_000, side: 'buy', price: 100, size: 1 })], {
      ...HL,
      funding: [funding({ ts: 9_000_000, amount: -3 })],
    });

    expect(eps[0]!.totalFunding).toBeCloseTo(-3, 12);
  });

  it('only attributes funding for the matching instrument', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 1, instrument: 'HYPE-PERP' }),
        fill({ ts: 3_000, side: 'sell', price: 100, size: 1, instrument: 'HYPE-PERP' }),
      ],
      { ...HL, funding: [funding({ ts: 2_000, amount: -5, instrument: 'BTC-PERP' })] },
    );

    expect(eps[0]!.totalFunding).toBe(0);
  });
});

describe('buildEpisodes — venue reconciliation (SPEC §14)', () => {
  it('prefers the venue closedPnl over our computed value', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        // We would compute 100; the venue says 97.5 (funding/rounding on its side).
        fill({ ts: 2_000, side: 'sell', price: 110, size: 10, closedPnl: 97.5 }),
      ],
      HL,
    );

    expect(eps[0]!.realizedPnl).toBeCloseTo(97.5, 12);
  });

  it('records a reconciliation note when the delta exceeds 0.5%', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ id: 'x', ts: 2_000, side: 'sell', price: 110, size: 10, closedPnl: 50 }),
      ],
      HL,
    );

    const notes = eps[0]!.reconciliation;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('closed_pnl_mismatch');
    expect(notes[0]!.fillId).toBe('x');
    expect(notes[0]!.ours).toBeCloseTo(100, 12);
    expect(notes[0]!.venue).toBe(50);
  });

  it('stays quiet when the venue agrees within tolerance', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 2_000, side: 'sell', price: 110, size: 10, closedPnl: 100.2 }),
      ],
      HL,
    );

    expect(eps[0]!.reconciliation).toHaveLength(0);
  });
});

describe('buildEpisodes — steps (the reconstruction oracle)', () => {
  it('labels each fill with the action it performed', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 1_500, side: 'buy', price: 100, size: 5 }),
        fill({ ts: 2_000, side: 'sell', price: 100, size: 5 }),
        fill({ ts: 2_500, side: 'sell', price: 100, size: 20 }),
      ],
      HL,
    );

    expect(eps[0]!.steps.map((s) => s.action)).toEqual(['open', 'scale_in', 'reduce', 'flip_out']);
    expect(eps[1]!.steps.map((s) => s.action)).toEqual(['flip_in']);
  });

  it('exposes the position state before each fill, for venue cross-checks', () => {
    // Polymarket Perps hands us previous_size / previous_entry_price per fill (§4.4.3);
    // these fields are what we assert against.
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 1_500, side: 'buy', price: 200, size: 10 }),
      ],
      HL,
    );

    const [first, second] = eps[0]!.steps as [
      (typeof eps)[number]['steps'][number],
      (typeof eps)[number]['steps'][number],
    ];
    expect(first.netSizeBefore).toBe(0);
    expect(first.netSizeAfter).toBeCloseTo(10, 12);
    expect(second.netSizeBefore).toBeCloseTo(10, 12);
    expect(second.avgEntryBefore).toBeCloseTo(100, 12);
    expect(second.avgEntryAfter).toBeCloseTo(150, 12);
  });
});

describe('buildEpisodes — float safety (SPEC §5)', () => {
  it('closes a position built from values that do not sum exactly in binary float', () => {
    const eps = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 0.1 }),
        fill({ ts: 1_100, side: 'buy', price: 100, size: 0.2 }),
        fill({ ts: 2_000, side: 'sell', price: 100, size: 0.3 }),
      ],
      HL,
    );

    // 0.1 + 0.2 - 0.3 === 5.55e-17, not 0. An `=== 0` check reports this as open forever.
    expect(eps).toHaveLength(1);
    expect(eps[0]!.closedAt).toBe(2_000);
    expect(Math.abs(eps[0]!.closingNetSize)).toBeLessThan(SIZE_EPS);
  });

  it('fuzz: random fill sequences always return to flat and reconcile', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = mulberry32(seed);
      const fills = [];
      let net = 0;
      let ts = 1_000;

      const legs = 2 + Math.floor(rand() * 10);
      for (let i = 0; i < legs; i++) {
        ts += 1 + Math.floor(rand() * 1_000);
        const size = Math.round((0.01 + rand() * 5) * 100) / 100;
        const side = rand() > 0.5 ? 'buy' : 'sell';
        fills.push(fill({ ts, side, price: 10 + Math.round(rand() * 1_000) / 10, size }));
        net += side === 'buy' ? size : -size;
      }
      // Force the book flat with one final leg.
      if (Math.abs(net) > SIZE_EPS) {
        ts += 100;
        fills.push(
          fill({
            ts,
            side: net > 0 ? 'sell' : 'buy',
            price: 10 + Math.round(rand() * 1_000) / 10,
            size: Math.abs(net),
          }),
        );
      }

      const eps = buildEpisodes(fills, HL);

      expect(eps.length, `seed ${seed}`).toBeGreaterThan(0);
      // Every episode must be closed, and every net size back to flat.
      for (const e of eps) {
        expect(e.closedAt, `seed ${seed} episode ${e.id}`).not.toBeNull();
        expect(Math.abs(e.closingNetSize), `seed ${seed}`).toBeLessThan(SIZE_EPS);
      }
      // Every input fill is accounted for exactly once across the episodes
      // (a flip fill belongs to both legs, so count distinct ids).
      const seen = new Set(eps.flatMap((e) => e.fills.map((f) => f.id)));
      expect(seen.size, `seed ${seed}`).toBe(fills.length);
    }
  });
});
