/**
 * Server-side helpers for SPEC §4.6's upload flow.
 *
 * The file never reaches an adapter as a File. It is parsed here, stored under a
 * content hash, and everything downstream addresses it by that hash — which is what
 * lets `/a/csv/<id>` and a replay deep link be shared and survive a reload (SPEC §9).
 */

import {
  applyMapping,
  documentIdFor,
  missingRequired,
  normalizeSymbol,
  parseCsv,
  suggestMapping,
  symbolCandidates,
  type ColumnMapping,
  type CsvDocument,
  type CsvField,
  type CsvSymbolSource,
  type CsvTable,
} from '@trade-replay/adapters';
import { csvStore } from './data.js';

/** Rows shown in the mapping preview. Enough to judge a column, short enough to scan. */
export const PREVIEW_ROWS = 6;

/**
 * The largest upload accepted.
 *
 * The whole file is held in memory and stored in one SQLite row, so this is a real
 * limit rather than a formality. 8 MB is a few hundred thousand fills — far beyond
 * any single trader's export, and small enough that a hostile upload cannot exhaust
 * the process.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

function store(): NonNullable<ReturnType<typeof csvStore>> {
  const found = csvStore();
  if (!found) {
    throw new UploadError(
      'Uploads need the database, and it could not be opened. Check DATABASE_URL and the ' +
        'volume it points at; the server log has the underlying error.',
    );
  }
  return found;
}

export async function getDocument(id: string): Promise<CsvDocument | null> {
  return store().get(id);
}

/**
 * Store a file under the id its content and mapping imply.
 *
 * Idempotent: the same file with the same mapping is the same document, so a user who
 * uploads twice gets one entry and one link rather than two.
 */
export async function putDocument(
  filename: string,
  text: string,
  mapping: ColumnMapping,
  symbols: Record<string, CsvSymbolSource>,
  now: number,
): Promise<CsvDocument> {
  const document: CsvDocument = {
    id: documentIdFor(text, mapping),
    filename,
    text,
    mapping,
    symbols,
    createdAt: now,
  };
  await store().put(document);
  return document;
}

export async function readUpload(file: unknown): Promise<{ filename: string; text: string }> {
  if (!(file instanceof File) || file.size === 0) {
    throw new UploadError('No file was uploaded.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `That file is ${(file.size / 1_048_576).toFixed(1)} MB; the limit is ` +
        `${MAX_UPLOAD_BYTES / 1_048_576} MB.`,
    );
  }
  return { filename: file.name || 'upload.csv', text: await file.text() };
}

export interface MappingView {
  document: CsvDocument;
  table: CsvTable;
  /** Header row plus the first few data rows, for the preview. */
  preview: string[][];
  missing: CsvField[];
  /** Distinct normalized symbols this mapping produces, once it is complete. */
  symbols: string[];
  /** Per symbol, the Binance symbols worth trying first. */
  candidates: Record<string, string[]>;
  /** Rows the mapping cannot read, so the count is visible before committing to it. */
  rejectedRows: number;
}

/**
 * Everything the mapping page renders, derived rather than stored.
 *
 * Recomputed per request on purpose: the mapping is cheap to apply, and a cached view
 * is one more thing that can disagree with the document it describes.
 */
export function viewFor(document: CsvDocument): MappingView {
  const table = parseCsv(document.text);
  const missing = missingRequired(document.mapping);

  let symbols: string[] = [];
  let rejectedRows = 0;
  if (missing.length === 0) {
    try {
      const { fills, issues } = applyMapping(table, document.mapping);
      symbols = [...new Set(fills.map((f) => f.instrument))].sort();
      rejectedRows = issues.length;
    } catch {
      // A mapping that reads nothing is a mapping problem, and the page says so by
      // showing no symbols rather than by failing to render.
      symbols = [];
      rejectedRows = table.rows.length;
    }
  }

  const candidates: Record<string, string[]> = {};
  for (const symbol of symbols) candidates[symbol] = symbolCandidates(symbol);

  return {
    document,
    table,
    preview: [table.header, ...table.rows.slice(0, PREVIEW_ROWS)],
    missing,
    symbols,
    candidates,
    rejectedRows,
  };
}

/** The mapping a fresh upload starts from. */
export function initialMapping(text: string): ColumnMapping {
  return suggestMapping(parseCsv(text));
}

/** The fields the mapping form offers, in the order SPEC §4.6 lists them. */
export const CSV_FORM_FIELDS: readonly CsvField[] = [
  'timestamp',
  'symbol',
  'side',
  'price',
  'size',
  'fee',
  'leverage',
  'note',
];

/**
 * Build a mapping from the form the user submitted.
 *
 * Every field arrives as a column index or the empty string; an unmapped optional
 * field is left out entirely rather than stored as -1, so `columns[field] === undefined`
 * keeps meaning exactly one thing.
 */
export function mappingFromForm(form: FormData, columnCount: number): ColumnMapping {
  const columns: Partial<Record<CsvField, number>> = {};

  for (const field of CSV_FORM_FIELDS) {
    const raw = form.get(`column.${field}`);
    if (typeof raw !== 'string' || raw === '') continue;
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= columnCount) continue;
    columns[field] = index;
  }

  const timestampFormat = form.get('timestampFormat');
  const numberFormat = form.get('numberFormat');

  return {
    columns,
    timestampFormat:
      timestampFormat === 'iso8601' || timestampFormat === 'epoch_s' ? timestampFormat : 'epoch_ms',
    numberFormat: numberFormat === 'comma' ? 'comma' : 'dot',
  };
}

/** Price sources from the symbol form: a Binance symbol, or an uploaded OHLCV file. */
export async function symbolsFromForm(
  form: FormData,
  symbols: readonly string[],
): Promise<Record<string, CsvSymbolSource>> {
  const out: Record<string, CsvSymbolSource> = {};

  for (const symbol of symbols) {
    const file = form.get(`ohlcv.${symbol}`);
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new UploadError(`The OHLCV file for ${symbol} is larger than the upload limit.`);
      }
      // SPEC §4.6's fallback wins when both are given: the user went out of their way
      // to supply this, so it is not the field to silently ignore.
      out[symbol] = { kind: 'ohlcv', text: await file.text(), filename: file.name };
      continue;
    }

    const binance = form.get(`binance.${symbol}`);
    if (typeof binance === 'string' && binance.trim() !== '') {
      out[symbol] = { kind: 'binance', symbol: normalizeSymbol(binance).replace(/-/g, '') };
    }
  }

  return out;
}
