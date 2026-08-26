/**
 * Deep-link identifiers. SPEC.md §8.
 *
 * "Deep link encodes `{venue, address, instrument, openedAt}` -> resolves to the same
 * episode later. Do NOT use array indices in URLs."
 *
 * An ordinal rides along because a flip leaves two episodes sharing
 * (instrument, openedAt) — see episodes.ts, which disambiguates them the same way.
 * Without it a shared link would resolve to whichever of the two was found first.
 *
 * base64url is implemented here rather than reached for from Node's Buffer or the
 * browser's btoa: this package has zero dependencies and must run unchanged in a
 * browser, in Node, and in the M8 export worker.
 */

import type { PositionEpisode, VenueId } from './types.js';

export interface ReplayRef {
  venue: VenueId;
  address: string;
  instrument: string;
  openedAt: number;
  /** Disambiguates episodes sharing (instrument, openedAt) — i.e. the halves of a flip. */
  ordinal: number;
}

const SEPARATOR = '|';
const VENUES: readonly string[] = ['hyperliquid', 'polymarket-perps', 'csv'];
/**
 * Venues whose accounts are EVM addresses.
 *
 * CSV has no wallet at all, so it takes the looser form; everything else must look
 * like an address before this value is handed to an adapter.
 */
const EVM_VENUES: readonly string[] = ['hyperliquid', 'polymarket-perps'];
const EVM_ADDRESS = /^0x[a-f0-9]{40}$/;
const GENERIC_ACCOUNT = /^[a-zA-Z0-9.:_-]{1,128}$/;
const INSTRUMENT = /^[\x20-\x7e]{1,128}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET[i]!] = i;

/** Unpadded base64url — safe in a path segment with nothing to percent-encode. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

function base64UrlToBytes(text: string): Uint8Array | null {
  if (text.length === 0) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of text) {
    const value = REVERSE[char];
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}

export function encodeReplayId(ref: ReplayRef): string {
  const payload = [
    ref.venue,
    // Address case is cosmetic on EVM chains; normalizing means two spellings of the
    // same wallet produce one link rather than two that look different but aren't.
    ref.address.toLowerCase(),
    ref.instrument,
    String(Math.trunc(ref.openedAt)),
    String(Math.trunc(ref.ordinal)),
  ].join(SEPARATOR);

  return bytesToBase64Url(new TextEncoder().encode(payload));
}

/**
 * Decode a replay id.
 *
 * Returns null on anything malformed rather than throwing: this value comes straight
 * out of a URL, so it is attacker-controlled and a route handler must be able to treat
 * a bad one as a 404 rather than a 500.
 */
export function decodeReplayId(id: string): ReplayRef | null {
  const bytes = base64UrlToBytes(id);
  if (!bytes) return null;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  const parts = text.split(SEPARATOR);
  if (parts.length < 5) return null;

  // Take the fixed fields from both ends so an instrument containing the separator
  // still parses rather than silently truncating.
  const venue = parts[0]!;
  const address = parts[1]!;
  const ordinal = Number(parts[parts.length - 1]);
  const openedAt = Number(parts[parts.length - 2]);
  const instrument = parts.slice(2, parts.length - 2).join(SEPARATOR);

  if (!VENUES.includes(venue)) return null;
  if (!INSTRUMENT.test(instrument)) return null;
  if (!Number.isSafeInteger(openedAt) || openedAt < 0) return null;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return null;

  const addressOk = EVM_VENUES.includes(venue)
    ? EVM_ADDRESS.test(address)
    : GENERIC_ACCOUNT.test(address);
  if (!addressOk) return null;

  return { venue: venue as VenueId, address, instrument, openedAt, ordinal };
}

/** The ordinal episodes.ts appended to this episode's id. */
export function ordinalOf(episode: PositionEpisode): number {
  const hash = episode.id.lastIndexOf('#');
  if (hash === -1) return 0;
  const ordinal = Number(episode.id.slice(hash + 1));
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
}

export function replayIdForEpisode(episode: PositionEpisode, address: string): string {
  return encodeReplayId({
    venue: episode.venue,
    address,
    instrument: episode.instrument,
    openedAt: episode.openedAt,
    ordinal: ordinalOf(episode),
  });
}

/** Resolve a decoded ref back to its episode. Returns null when nothing matches. */
export function findEpisodeByRef(
  episodes: readonly PositionEpisode[],
  ref: ReplayRef,
): PositionEpisode | null {
  return (
    episodes.find(
      (e) =>
        e.venue === ref.venue &&
        e.instrument === ref.instrument &&
        e.openedAt === ref.openedAt &&
        ordinalOf(e) === ref.ordinal,
    ) ?? null
  );
}
