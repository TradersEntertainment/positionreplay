/**
 * SPEC §4.6's mapping UI.
 *
 *   "Accept a permissive CSV, map columns via a UI step (don't hard-require header
 *    names). … Provide a symbol-mapping step (BTC -> BTCUSDT). If mapping fails or the
 *    symbol is unknown, fall back to letting the user upload their own OHLCV CSV."
 *
 * Two steps on one page: columns first, then — once the required ones are mapped and
 * the symbols are therefore known — a price source per symbol. Plain forms, so the
 * flow works without JavaScript and reads the same to a person and to a test.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CSV_FIELDS, REQUIRED_FIELDS } from '@trade-replay/adapters';
import type { CsvField } from '@trade-replay/adapters';
import { CSV_FORM_FIELDS, getDocument, viewFor } from '../../../lib/csv';

export const dynamic = 'force-dynamic';

const FIELD_HELP: Record<CsvField, string> = {
  timestamp: 'When the fill happened',
  symbol: 'The market traded',
  side: 'buy / sell, long / short, "Open Long" — all understood',
  price: 'Fill price',
  size: 'Quantity, in base units. A sign here is ignored; side carries the direction',
  fee: 'Optional. Missing means fees are counted as zero, which will understate costs',
  leverage: 'Optional. Only drawn if present — never derived (SPEC §4.3)',
  note: 'Optional. Shown on the marker label',
};

export default async function CsvMappingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const document = await getDocument(id);
  if (!document) notFound();

  const view = viewFor(document);
  const columnsDone = view.missing.length === 0;

  return (
    <main className="mx-auto max-w-5xl p-8" data-testid="csv-mapping">
      <p className="text-xs text-tr-dim">
        <Link href="/" className="underline hover:text-tr-text">
          trade-replay
        </Link>{' '}
        / CSV upload
      </p>
      <h1 className="mt-2 text-2xl font-bold" data-testid="csv-filename">
        {document.filename}
      </h1>
      <p className="mt-1 text-sm text-tr-dim">
        {view.table.rows.length} row{view.table.rows.length === 1 ? '' : 's'} ·{' '}
        {view.table.header.length} columns · delimiter{' '}
        <code>{view.table.delimiter === '\t' ? '\\t' : view.table.delimiter}</code> ·{' '}
        {view.table.hasHeader ? 'header detected' : 'no header row detected'}
      </p>

      {error ? (
        <p
          className="mt-4 border border-tr-down/40 bg-tr-down/10 p-2 text-sm text-tr-down"
          data-testid="csv-error"
        >
          {error}
        </p>
      ) : null}

      {/* Preview first: a mapping is a claim about these columns, so they have to be
          visible while it is being made. */}
      <div className="mt-6 overflow-x-auto border border-tr-line">
        <table className="w-full text-xs" data-testid="csv-preview">
          <tbody>
            {view.preview.map((row, r) => (
              <tr key={r} className={r === 0 ? 'bg-tr-panel font-bold' : 'border-t border-tr-line/50'}>
                {row.map((cell, c) => (
                  <td key={c} className="whitespace-nowrap px-2 py-1">
                    {cell === '' ? <span className="text-tr-dim">—</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form method="POST" action="/api/csv/mapping" className="mt-8" data-testid="column-form">
        <input type="hidden" name="id" value={document.id} />
        <h2 className="text-sm font-bold">1. Columns</h2>
        <p className="mt-1 text-xs text-tr-dim">
          Guessed from the header and from what the values look like. Change anything
          that is wrong — nothing here is required to be named a particular way.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {CSV_FORM_FIELDS.map((field) => {
            const required = REQUIRED_FIELDS.includes(field);
            return (
              <label key={field} className="block text-xs">
                <span className="font-bold uppercase tracking-wide">
                  {field}
                  {required ? <span className="ml-1 text-tr-notice">required</span> : null}
                </span>
                <select
                  name={`column.${field}`}
                  defaultValue={document.mapping.columns[field] ?? ''}
                  data-testid={`column-${field}`}
                  className="mt-1 w-full border border-tr-line bg-tr-panel px-2 py-1 text-sm outline-none focus:border-tr-up"
                >
                  <option value="">{required ? '— pick a column —' : 'not in this file'}</option>
                  {view.table.header.map((name, index) => (
                    <option key={index} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-tr-dim">{FIELD_HELP[field]}</span>
              </label>
            );
          })}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="font-bold uppercase tracking-wide">Timestamp format</span>
            <select
              name="timestampFormat"
              defaultValue={document.mapping.timestampFormat}
              data-testid="timestamp-format"
              className="mt-1 w-full border border-tr-line bg-tr-panel px-2 py-1 text-sm outline-none focus:border-tr-up"
            >
              <option value="epoch_ms">Epoch milliseconds</option>
              <option value="epoch_s">Epoch seconds</option>
              <option value="iso8601">ISO 8601</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-bold uppercase tracking-wide">Decimal separator</span>
            <select
              name="numberFormat"
              defaultValue={document.mapping.numberFormat}
              data-testid="number-format"
              className="mt-1 w-full border border-tr-line bg-tr-panel px-2 py-1 text-sm outline-none focus:border-tr-up"
            >
              <option value="dot">1234.56</option>
              <option value="comma">1234,56</option>
            </select>
          </label>
        </div>

        <button
          type="submit"
          data-testid="column-submit"
          className="mt-4 border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
        >
          Apply mapping
        </button>
      </form>

      {columnsDone ? (
        <form method="POST" action="/api/csv/symbols" encType="multipart/form-data" className="mt-10">
          <h2 className="text-sm font-bold">2. Price data</h2>
          <p className="mt-1 text-xs text-tr-dim">
            Candles come from Binance public klines, so each symbol in the file needs a
            Binance symbol. If Binance does not list it, upload your own OHLCV file
            instead — time, open, high, low, close, and optionally volume.
          </p>
          <input type="hidden" name="id" value={document.id} />

          {view.rejectedRows > 0 ? (
            <p className="mt-3 text-xs text-tr-notice" data-testid="rejected-rows">
              {view.rejectedRows} row{view.rejectedRows === 1 ? '' : 's'} cannot be read with
              this mapping and will not be in the reconstruction.
            </p>
          ) : null}

          <div className="mt-4 space-y-4">
            {view.symbols.map((symbol) => {
              const source = document.symbols[symbol];
              return (
                <div
                  key={symbol}
                  className="border border-tr-line p-3"
                  data-testid="symbol-row"
                  data-symbol={symbol}
                >
                  <p className="text-sm font-bold">{symbol}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs">
                      <span className="text-tr-dim">Binance symbol</span>
                      <input
                        type="text"
                        name={`binance.${symbol}`}
                        list={`candidates-${symbol}`}
                        defaultValue={
                          source?.kind === 'binance'
                            ? source.symbol
                            : (view.candidates[symbol]?.[0] ?? '')
                        }
                        data-testid={`binance-${symbol}`}
                        className="mt-1 w-full border border-tr-line bg-tr-panel px-2 py-1 text-sm outline-none focus:border-tr-up"
                      />
                      <datalist id={`candidates-${symbol}`}>
                        {(view.candidates[symbol] ?? []).map((candidate) => (
                          <option key={candidate} value={candidate} />
                        ))}
                      </datalist>
                    </label>
                    <label className="block text-xs">
                      <span className="text-tr-dim">…or an OHLCV file for it</span>
                      <input
                        type="file"
                        name={`ohlcv.${symbol}`}
                        accept=".csv,text/csv"
                        data-testid={`ohlcv-${symbol}`}
                        className="mt-1 w-full border border-tr-line bg-tr-panel px-2 py-1 text-sm file:mr-2 file:border-0 file:bg-transparent file:text-tr-text"
                      />
                      {source?.kind === 'ohlcv' ? (
                        <span className="mt-1 block text-tr-dim">
                          Using {source.filename ?? 'an uploaded file'}. Leave empty to keep it.
                        </span>
                      ) : null}
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="submit"
            data-testid="symbols-submit"
            className="mt-4 border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
          >
            Load episodes
          </button>
        </form>
      ) : (
        <p className="mt-10 text-xs text-tr-notice" data-testid="missing-fields">
          Still to map: {view.missing.join(', ')}. SPEC §4.6 needs{' '}
          {REQUIRED_FIELDS.join(', ')} before a position can be reconstructed.
        </p>
      )}

      <p className="mt-10 text-xs text-tr-dim">
        {CSV_FIELDS.length} fields recognised. This file is stored server-side under the
        id <code data-testid="csv-id">{document.id}</code>, which is what makes the
        replay link shareable.
      </p>
    </main>
  );
}
