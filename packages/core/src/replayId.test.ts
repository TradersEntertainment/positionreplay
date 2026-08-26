import { describe, expect, it } from 'vitest';
import { buildEpisodes } from './episodes.js';
import { decodeReplayId, encodeReplayId, replayIdForEpisode } from './replayId.js';
import { fill } from './test-helpers.js';

const ADDRESS = '0x393d0b87ed38fc779fd9611144ae649ba6082109';

describe('replay ids (SPEC §8)', () => {
  it('round-trips the four identifying fields', () => {
    const ref = {
      venue: 'hyperliquid' as const,
      address: ADDRESS,
      instrument: 'HYPE-PERP',
      openedAt: 1_761_955_200_000,
      ordinal: 0,
    };
    expect(decodeReplayId(encodeReplayId(ref))).toEqual(ref);
  });

  it('round-trips a HIP-3 instrument, which contains a colon', () => {
    const ref = {
      venue: 'hyperliquid' as const,
      address: ADDRESS,
      instrument: 'xyz:XYZ100-PERP',
      openedAt: 1_761_955_200_000,
      ordinal: 1,
    };
    expect(decodeReplayId(encodeReplayId(ref))).toEqual(ref);
  });

  it('is URL-safe: no slash, plus or padding to escape', () => {
    for (const instrument of ['HYPE-PERP', 'xyz:XYZ100-PERP', 'BTC-PERP', 'k:PURR-PERP']) {
      const id = encodeReplayId({
        venue: 'hyperliquid',
        address: ADDRESS,
        instrument,
        openedAt: 1_761_955_200_000,
        ordinal: 0,
      });
      expect(id, instrument).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('normalizes address case so two spellings share one id', () => {
    const base = {
      venue: 'hyperliquid' as const,
      instrument: 'HYPE-PERP',
      openedAt: 1_000,
      ordinal: 0,
    };
    const lower = encodeReplayId({ ...base, address: ADDRESS });
    const upper = encodeReplayId({ ...base, address: `0x${ADDRESS.slice(2).toUpperCase()}` });

    expect(upper).toBe(lower);
    expect(decodeReplayId(upper)!.address).toBe(ADDRESS);
  });

  it('distinguishes the two episodes a flip produces', () => {
    // A flip leaves two episodes sharing (instrument, openedAt). Without the ordinal
    // a deep link would resolve to whichever one happened to be found first.
    const base = {
      venue: 'hyperliquid' as const,
      address: ADDRESS,
      instrument: 'HYPE-PERP',
      openedAt: 1_762_531_200_000,
    };
    expect(encodeReplayId({ ...base, ordinal: 0 })).not.toBe(
      encodeReplayId({ ...base, ordinal: 1 }),
    );
  });

  it('encodes no array index — SPEC §8 forbids it', () => {
    const episodes = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 2_000, side: 'sell', price: 120, size: 25 }),
        fill({ ts: 3_000, side: 'buy', price: 110, size: 15 }),
      ],
      { venue: 'hyperliquid' },
    );

    const ids = episodes.map((e) => replayIdForEpisode(e, ADDRESS));
    expect(new Set(ids).size).toBe(episodes.length);

    // Reordering the list must not change any id.
    const reversed = [...episodes].reverse().map((e) => replayIdForEpisode(e, ADDRESS));
    expect(new Set(reversed)).toEqual(new Set(ids));
  });

  it('resolves back to the episode it was built from', () => {
    const episodes = buildEpisodes(
      [
        fill({ ts: 1_000, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 2_000, side: 'sell', price: 120, size: 25 }),
        fill({ ts: 3_000, side: 'buy', price: 110, size: 15 }),
      ],
      { venue: 'hyperliquid' },
    );

    for (const episode of episodes) {
      const ref = decodeReplayId(replayIdForEpisode(episode, ADDRESS))!;
      const matches = episodes.filter(
        (e) =>
          e.instrument === ref.instrument &&
          e.openedAt === ref.openedAt &&
          e.id.endsWith(`#${ref.ordinal}`),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]!.id).toBe(episode.id);
    }
  });
});

describe('decodeReplayId — hostile input', () => {
  it('returns null rather than throwing, since these arrive from a URL', () => {
    for (const bad of [
      '',
      'not-base64!!',
      'aGVsbG8', // valid base64url, wrong shape
      encodeReplayId({
        venue: 'hyperliquid',
        address: ADDRESS,
        instrument: 'HYPE-PERP',
        openedAt: 1_000,
        ordinal: 0,
      }).slice(0, 5),
    ]) {
      expect(() => decodeReplayId(bad), bad).not.toThrow();
      expect(decodeReplayId(bad), bad).toBeNull();
    }
  });

  it('rejects an unknown venue instead of trusting the URL', () => {
    const forged = Buffer.from('evil|0xabc|X-PERP|1000|0', 'utf8').toString('base64url');
    expect(decodeReplayId(forged)).toBeNull();
  });

  it('rejects a non-numeric timestamp or ordinal', () => {
    for (const payload of [
      `hyperliquid|${ADDRESS}|HYPE-PERP|notanumber|0`,
      `hyperliquid|${ADDRESS}|HYPE-PERP|1000|NaN`,
      `hyperliquid|${ADDRESS}|HYPE-PERP|1000|-1`,
    ]) {
      expect(decodeReplayId(Buffer.from(payload, 'utf8').toString('base64url'))).toBeNull();
    }
  });

  it('holds Perps to the same address shape as Hyperliquid', () => {
    // Both venues are EVM accounts; only CSV has no wallet.
    const forged = Buffer.from('polymarket-perps|../../etc/passwd|pm:1|1000|0', 'utf8').toString(
      'base64url',
    );
    expect(decodeReplayId(forged)).toBeNull();

    const valid = encodeReplayId({
      venue: 'polymarket-perps',
      address: ADDRESS,
      instrument: 'pm:1',
      openedAt: 1_000,
      ordinal: 0,
    });
    expect(decodeReplayId(valid)).toMatchObject({ venue: 'polymarket-perps', instrument: 'pm:1' });
  });

  it('rejects an address that is not an address', () => {
    const forged = Buffer.from(`hyperliquid|../../etc/passwd|X-PERP|1000|0`, 'utf8').toString(
      'base64url',
    );
    expect(decodeReplayId(forged)).toBeNull();
  });
});
