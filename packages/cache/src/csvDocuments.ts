/**
 * Storage for uploaded CSVs. SPEC §4.6.
 *
 * Every other venue's account identifier is a wallet the user already has. A CSV has
 * none, so the upload is stored server-side under a content hash and that hash takes
 * the address slot — which is what lets `/a/csv/<id>` and a replay deep link survive a
 * page reload and be shared, as SPEC §9 requires of every replay.
 */

import { eq, sql } from 'drizzle-orm';
import type { ColumnMapping, CsvDocument, CsvDocumentStore, CsvSymbolSource } from '@trade-replay/adapters';
import type { CacheDb } from './db.js';
import { csvDocuments } from './schema.js';

export function createCsvDocumentStore(db: CacheDb): CsvDocumentStore {
  return {
    async get(id) {
      const row = db.select().from(csvDocuments).where(eq(csvDocuments.id, id)).get();
      if (!row) return null;
      return {
        id: row.id,
        filename: row.filename,
        text: row.text,
        // Drizzle's json mode hands back `unknown`; these were written by `put` from
        // typed values, and a hand-edited database is not a threat model worth a
        // second schema.
        mapping: row.mapping as ColumnMapping,
        symbols: row.symbols as Record<string, CsvSymbolSource>,
        createdAt: row.createdAt,
      };
    },

    async put(document: CsvDocument) {
      db.insert(csvDocuments)
        .values({
          id: document.id,
          filename: document.filename,
          text: document.text,
          mapping: document.mapping,
          symbols: document.symbols,
          createdAt: document.createdAt,
        })
        // The id covers the file and its mapping, so a re-upload is the same document.
        // Only `symbols` can legitimately change afterwards — that is the mapping step
        // the user completes after the file is already stored.
        .onConflictDoUpdate({
          target: csvDocuments.id,
          set: { symbols: sql`excluded.symbols`, filename: sql`excluded.filename` },
        })
        .run();
    },
  };
}
