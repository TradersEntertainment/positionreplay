/**
 * CSV tokenizer. SPEC §4.6: "Accept a permissive CSV".
 *
 * Permissive means the shapes real exports actually have, not "anything goes": a
 * Windows-authored file with a BOM and CRLF endings, quoted fields containing the
 * delimiter, doubled quotes inside a quoted field, a trailing newline, and a
 * delimiter that might be a semicolon because the exporter ran in a locale where
 * that is the convention.
 *
 * Written by hand rather than pulled from npm because the whole parser is ~80 lines
 * and the failure mode of a wrong one is a misread price, which is the class of bug
 * CLAUDE.md is most emphatic about.
 */

export interface CsvTable {
  /** The first row, if `hasHeader`. Otherwise synthesised as "Column 1", … */
  header: string[];
  /** Data rows, header excluded. Ragged rows are padded/truncated to header length. */
  rows: string[][];
  /** Whether the first line looked like names rather than values. */
  hasHeader: boolean;
  delimiter: string;
  /** Rows whose field count disagreed with the header, by 0-based data-row index. */
  raggedRows: number[];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Guess the delimiter by which one yields the most *consistent* field count.
 *
 * Counting occurrences alone picks the wrong character on a file whose text fields
 * contain prose: one "note" column full of commas outvotes the real semicolons.
 * Consistency across lines is the property a delimiter actually has.
 */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const first = counts[0] ?? 1;
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    // Field count breaks ties: with one column of prose, ";" and "," can both be
    // perfectly consistent, and the one that actually splits the row is the answer.
    const score = consistent * 100 + Math.min(first, 20);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/** One line, respecting quotes. Used only by the delimiter sniffer. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * Does the first row name columns or hold data?
 *
 * The test is whether any cell parses as a number: "price" does not, "92000.5" does.
 * A header of pure text with a data row containing at least one number is the
 * overwhelmingly common case, and getting it wrong only costs the user one click in
 * the mapping UI — which is why §4.6 says not to hard-require header names.
 */
export function looksLikeHeader(first: string[], second: string[] | undefined): boolean {
  const numeric = (cells: string[]): number =>
    cells.filter((c) => c.trim() !== '' && Number.isFinite(Number(c.trim()))).length;

  if (first.every((c) => c.trim() === '')) return false;
  if (numeric(first) > 0) return false;
  if (!second) return true;
  return numeric(second) > 0 || second.length === first.length;
}

export function parseCsv(input: string, forcedDelimiter?: string): CsvTable {
  // A UTF-8 BOM survives every spreadsheet export and would otherwise become part
  // of the first header name, so the column "timestamp" never matches anything.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === '') throw new CsvParseError('The file is empty.');

  const delimiter = forcedDelimiter ?? sniffDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let sawField = false;

  const endField = (): void => {
    record.push(field);
    field = '';
    sawField = false;
  };
  const endRecord = (): void => {
    endField();
    // A trailing newline yields one empty record; that is punctuation, not a row.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"' && !sawField) {
      quoted = true;
      sawField = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += ch;
      sawField = true;
    }
  }

  if (quoted) throw new CsvParseError('The file ends inside an unclosed quoted field.');
  if (field !== '' || record.length > 0) endRecord();

  if (records.length === 0) throw new CsvParseError('The file has no rows.');

  const trimmed = records.map((r) => r.map((c) => c.trim()));
  const first = trimmed[0]!;
  const hasHeader = looksLikeHeader(first, trimmed[1]);

  const header = hasHeader
    ? first.map((name, i) => (name === '' ? `Column ${i + 1}` : name))
    : first.map((_, i) => `Column ${i + 1}`);

  const body = hasHeader ? trimmed.slice(1) : trimmed;

  const raggedRows: number[] = [];
  const rows = body.map((row, index) => {
    if (row.length !== header.length) raggedRows.push(index);
    const padded = row.slice(0, header.length);
    while (padded.length < header.length) padded.push('');
    return padded;
  });

  if (rows.length === 0) throw new CsvParseError('The file has a header but no data rows.');

  return { header, rows, hasHeader, delimiter, raggedRows };
}
