/**
 * Unpadded base64url, hand-rolled.
 *
 * Shared by `replayId.ts` and `manual.ts`, both of which put a payload in a URL path
 * segment. Hand-rolled rather than `Buffer`/`btoa` because this package runs in the
 * browser, in Node and under `@napi-rs/canvas` in the render worker, and only one of
 * those three has each of those.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET[i]!] = i;

/** Unpadded base64url — safe in a path segment with nothing to percent-encode. */
export function bytesToBase64Url(bytes: Uint8Array): string {
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

export function base64UrlToBytes(text: string): Uint8Array | null {
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
