/**
 * The uploaded document, and its identity.
 *
 * Every other venue is addressed by a wallet: `/a/hyperliquid/0x…` is a URL anyone can
 * re-open. A CSV has no such handle, and an app that keeps the upload only in browser
 * memory cannot share a replay or survive a refresh — SPEC §9's shareable deep link
 * assumes the account identifier is in the URL.
 *
 * So a document is identified by a hash of its own content plus the mapping applied to
 * it, and that hash takes the address slot for the `csv` venue. Same file, same
 * mapping, same id: re-uploading is idempotent rather than accumulating duplicates.
 */

import type { ColumnMapping } from './mapping.js';

/** Where a symbol's price history comes from. */
export type CsvSymbolSource =
  | { kind: 'binance'; symbol: string }
  /** SPEC §4.6's fallback: the user's own OHLCV file, kept verbatim. */
  | { kind: 'ohlcv'; text: string; filename?: string };

export interface CsvDocument {
  /** Content hash; the `address` for venue `csv`. */
  id: string;
  filename: string;
  /** The trades file, exactly as uploaded. */
  text: string;
  mapping: ColumnMapping;
  /** Normalized CSV symbol → price source. A symbol absent here has no series yet. */
  symbols: Record<string, CsvSymbolSource>;
  createdAt: number;
}

/** What the adapter needs from its host to find an uploaded document again. */
export interface CsvDocumentStore {
  get(id: string): Promise<CsvDocument | null>;
  put(document: CsvDocument): Promise<void>;
}

/**
 * FNV-1a, 64-bit, hex.
 *
 * Not a cryptographic hash and not used as one: it names a cache entry, and the
 * threat model for "someone crafts a second CSV colliding with mine" is that they see
 * their own upload. Hand-rolled to keep `packages/adapters` dependency-free and
 * runnable unchanged in the browser, where `node:crypto` is not available and
 * `crypto.subtle` is async.
 */
export function contentHash(...parts: string[]): string {
  let hi = 0x811c9dc5;
  let lo = 0xcbf29ce4;

  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      lo ^= code & 0xff;
      hi ^= (code >>> 8) & 0xff;
      // Two independent 32-bit FNV lanes; concatenated they give 64 bits of id.
      lo = Math.imul(lo, 0x01000193) >>> 0;
      hi = Math.imul(hi, 0x01000193) >>> 0;
    }
    // Length-delimit so ("ab","c") and ("a","bc") cannot hash alike.
    lo = Math.imul(lo ^ part.length, 0x01000193) >>> 0;
    hi = Math.imul(hi ^ 0x9e3779b9, 0x01000193) >>> 0;
  }

  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** The id a document with this content and mapping will have. */
export function documentIdFor(text: string, mapping: ColumnMapping): string {
  return contentHash(text, JSON.stringify(mapping.columns), mapping.timestampFormat, mapping.numberFormat);
}

/** Ids are hex, so a malformed one is rejected before it reaches the store. */
export const CSV_DOCUMENT_ID = /^[0-9a-f]{16}$/;
