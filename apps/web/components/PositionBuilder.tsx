'use client';

/**
 * Build a position by hand: pick a market, say what you remember, replay it.
 *
 * You are not asked to know both halves of a row. People remember prices, not
 * timestamps — "I bought at 86,000 and sold at 91,000" — so **Estimate** resolves every
 * blank against the venue's real candles (`estimateRows` in packages/core). The rule and
 * its refusals live there; this file only collects the input and shows the result.
 *
 * The chart is the venue's real one; the position is a construction. That is stated here,
 * on the replay page, and in the exported image — see `RenderLayout.constructed` for why
 * it is drawn into the pixels rather than only onto the page.
 *
 * There is no submit endpoint. The whole spec is encoded into the URL, so the link is
 * shareable with nothing stored behind it, and a "what if I had bought here" is exactly
 * the kind of thing people send to each other.
 */

import {
  MANUAL_MAX_LEGS,
  ManualSpecError,
  encodeManualSpec,
  estimateRows,
} from '@trade-replay/core';
import type { Candle, ManualLeg } from '@trade-replay/core';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface BuilderVenue {
  id: string;
  label: string;
}

interface Row {
  /** `YYYY-MM-DD HH:mm`, read as UTC. See `toEpoch`. */
  when: string;
  side: 'buy' | 'sell';
  size: string;
  price: string;
  /** Which of this row's fields Estimate supplied, so the form can say so. */
  estimated: ('ts' | 'price')[];
}

const EMPTY: Row = { when: '', side: 'buy', size: '', price: '', estimated: [] };

/** A buy then a sell: the shape almost every position has. */
function initialRows(): Row[] {
  return [{ ...EMPTY }, { ...EMPTY, side: 'sell' }];
}

const WHEN_FORMAT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

/**
 * `YYYY-MM-DD HH:mm` to epoch milliseconds, as UTC.
 *
 * A plain text field rather than `datetime-local`, for two reasons. The native control
 * renders its placeholder and calendar in the *browser's* language, which no attribute or
 * stylesheet can override — that is where the Turkish on an otherwise English page came
 * from. And SPEC §7.3 asks for "a terminal, not a dashboard": a monospace field you type
 * a timestamp into is more that than a picker widget.
 *
 * UTC rather than local, because every timestamp the app displays is UTC — the HUD, the
 * axis, the episode table. Parsing this one as local time would put a trade an hour or
 * ten from where the chart shows it, silently.
 */
export function toEpoch(value: string): number {
  const match = WHEN_FORMAT.exec(value.trim());
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

/** Epoch back to the same format, for writing an estimate into the field. */
export function fromEpoch(ts: number): string {
  const iso = new Date(ts).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** A blank field is a question for Estimate; a filled one is an anchor. */
function blank(value: string): boolean {
  return value.trim() === '';
}

export function PositionBuilder({ venues }: { venues: BuilderVenue[] }) {
  const router = useRouter();

  const [venue, setVenue] = useState(venues[0]?.id ?? '');
  const [instruments, setInstruments] = useState<{ instrument: string; displayName: string }[]>([]);
  const [instrument, setInstrument] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [error, setError] = useState<string | null>(null);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(false);

  // The instrument list comes from the venue itself, so a market that cannot be charted
  // cannot be picked.
  useEffect(() => {
    if (venue === '') return;
    let cancelled = false;
    setLoading(true);
    setListError(null);

    fetch(`/api/instruments?venue=${encodeURIComponent(venue)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The venue's market list is unavailable (${response.status}).`);
        return response.json() as Promise<{ instruments: { instrument: string; displayName: string }[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setInstruments(data.instruments);
        // Only auto-pick when nothing is chosen, so switching venue and back does not
        // silently discard a selection.
        setInstrument((current) =>
          data.instruments.some((i) => i.instrument === current)
            ? current
            : (data.instruments[0]?.instrument ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setListError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [venue]);

  // Candles are fetched once per market, so estimating is instant and repeatable. A
  // request per keystroke would be slower for the user and heavier on the venue.
  useEffect(() => {
    if (venue === '' || instrument === '') {
      setCandles([]);
      return;
    }
    let cancelled = false;
    setCandlesLoading(true);

    fetch(
      `/api/candles?venue=${encodeURIComponent(venue)}&instrument=${encodeURIComponent(instrument)}`,
    )
      .then(async (response) => {
        const data = (await response.json()) as { candles?: Candle[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? `Candles unavailable (${response.status}).`);
        return data.candles ?? [];
      })
      .then((next) => {
        if (!cancelled) setCandles(next);
      })
      .catch(() => {
        // Not surfaced as an error on its own: the form still works if you type both
        // halves of every row. Estimate says so when it is pressed with nothing to work
        // from, which is the moment it actually matters.
        if (!cancelled) setCandles([]);
      })
      .finally(() => {
        if (!cancelled) setCandlesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [venue, instrument]);

  const displayName = useMemo(
    () => instruments.find((i) => i.instrument === instrument)?.displayName ?? '',
    [instruments, instrument],
  );

  const update = useCallback((index: number, patch: Partial<Row>) => {
    setRows((current) =>
      current.map((row, i) =>
        i === index
          ? {
              ...row,
              ...patch,
              // Editing a field makes it yours, so it stops being reported as estimated
              // and becomes an anchor the next Estimate resolves around.
              estimated: row.estimated.filter(
                (field) =>
                  !(field === 'ts' && patch.when !== undefined) &&
                  !(field === 'price' && patch.price !== undefined),
              ),
            }
          : row,
      ),
    );
  }, []);

  /**
   * Indices of the rows that carry anything at all.
   *
   * Indices rather than the rows themselves, because both callers have to map results
   * back onto the full list — and a predicate re-evaluated later could match a different
   * set than the one that was estimated.
   */
  const filledIndices = useCallback(
    (source: Row[]): number[] =>
      source.reduce<number[]>((out, row, i) => {
        if (!blank(row.when) || !blank(row.size) || !blank(row.price)) out.push(i);
        return out;
      }, []),
    [],
  );

  const estimate = useCallback(() => {
    setError(null);

    if (candles.length === 0) {
      setError(
        candlesLoading
          ? 'Still loading this market’s candles — try again in a moment.'
          : 'No candles for this market, so there is nothing to estimate from.',
      );
      return;
    }

    const indices = filledIndices(rows);
    if (indices.length === 0) {
      setError('Enter a price or a date on at least one row first.');
      return;
    }

    const outcome = estimateRows(
      indices.map((i) => {
        const row = rows[i]!;
        return {
          ts: blank(row.when) ? null : toEpoch(row.when),
          price: blank(row.price) ? null : Number(row.price),
        };
      }),
      candles,
    );

    if (!outcome.ok) {
      // Core counts the rows it was given; the form counts every row on screen. The row
      // number a person can act on is this one.
      setError(`Row ${(indices[outcome.rowIndex] ?? 0) + 1}: ${outcome.reason}`);
      return;
    }

    // Keyed by the row's real index, and computed here rather than inside the updater.
    // A `setRows` callback must be pure — React may call it more than once — and a
    // counter incremented inside one silently stops filling anything on the second call.
    const byIndex = new Map(indices.map((rowIndex, k) => [rowIndex, outcome.rows[k]!]));

    setRows((current) =>
      current.map((row, i) => {
        const resolved = byIndex.get(i);
        if (!resolved) return row;
        return {
          ...row,
          when: resolved.estimated.includes('ts') ? fromEpoch(resolved.ts) : row.when,
          price: resolved.estimated.includes('price') ? String(resolved.price) : row.price,
          estimated: resolved.estimated,
        };
      }),
    );
  }, [candles, candlesLoading, rows, filledIndices]);

  const submit = useCallback(() => {
    setError(null);

    const legs: ManualLeg[] = filledIndices(rows).map((i) => {
      const row = rows[i]!;
      return {
        ts: toEpoch(row.when),
        side: row.side,
        size: Number(row.size),
        price: Number(row.price),
      };
    });

    try {
      const encoded = encodeManualSpec({
        venue: venue as never,
        instrument,
        displayName,
        legs,
      });
      router.push(`/b/${encoded}`);
    } catch (cause) {
      // ManualSpecError carries a sentence written for this form; anything else is a bug
      // and should not be dressed up as advice.
      setError(cause instanceof ManualSpecError ? cause.message : 'Could not build that position.');
    }
  }, [rows, venue, instrument, displayName, router, filledIndices]);

  const field =
    'border border-tr-line bg-tr-panel px-2 py-1.5 text-sm text-tr-text outline-none focus:border-tr-up';
  /** An estimated value is shown in the notice colour, so you can see what you typed. */
  const fieldFor = (row: Row, which: 'ts' | 'price'): string =>
    row.estimated.includes(which) ? `${field} text-tr-notice` : field;

  return (
    <div
      className="space-y-4"
      data-testid="position-builder"
      // How many bars Estimate has to work with. Surfaced because "nothing happened" and
      // "the candles have not arrived yet" look identical from outside, and a test that
      // clicks before they land is testing the wrong thing.
      data-candles={candles.length}
    >
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-xs text-tr-dim">
          Venue
          <select
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            data-testid="builder-venue"
            className={field}
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-1 flex-col gap-1 text-xs text-tr-dim">
          Market {loading ? '· loading…' : `· ${instruments.length}`}
          <select
            value={instrument}
            onChange={(e) => setInstrument(e.target.value)}
            disabled={instruments.length === 0}
            data-testid="builder-instrument"
            className={field}
          >
            {instruments.map((i) => (
              <option key={i.instrument} value={i.instrument}>
                {i.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {listError ? (
        <p className="text-xs text-tr-down" data-testid="builder-list-error">
          {listError}
        </p>
      ) : null}

      <table className="w-full border border-tr-line text-sm">
        <thead>
          <tr className="border-b border-tr-line text-left text-xs text-tr-dim">
            <th className="p-2">When (UTC)</th>
            <th className="p-2">Side</th>
            <th className="p-2">Size</th>
            <th className="p-2">Price</th>
            <th className="p-2" />
          </tr>
        </thead>
        <tbody data-testid="builder-rows">
          {rows.map((row, index) => (
            // Index as key is normally a bug; here rows have no identity of their own
            // and are only ever appended or removed from the end.
            <tr key={index} className="border-b border-tr-line/50" data-testid="builder-row">
              <td className="p-2">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2026-08-20 14:00"
                  value={row.when}
                  onChange={(e) => update(index, { when: e.target.value })}
                  aria-label={`Row ${index + 1} date and time, UTC`}
                  data-testid={`builder-when-${index}`}
                  data-estimated={row.estimated.includes('ts') ? 'true' : 'false'}
                  className={`${fieldFor(row, 'ts')} w-full`}
                />
              </td>
              <td className="p-2">
                <select
                  value={row.side}
                  onChange={(e) => update(index, { side: e.target.value as 'buy' | 'sell' })}
                  aria-label={`Row ${index + 1} side`}
                  data-testid={`builder-side-${index}`}
                  className={field}
                >
                  <option value="buy">BUY</option>
                  <option value="sell">SELL</option>
                </select>
              </td>
              <td className="p-2">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={row.size}
                  onChange={(e) => update(index, { size: e.target.value })}
                  aria-label={`Row ${index + 1} size`}
                  data-testid={`builder-size-${index}`}
                  className={`${field} w-full`}
                />
              </td>
              <td className="p-2">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={row.price}
                  onChange={(e) => update(index, { price: e.target.value })}
                  aria-label={`Row ${index + 1} price`}
                  data-testid={`builder-price-${index}`}
                  data-estimated={row.estimated.includes('price') ? 'true' : 'false'}
                  className={`${fieldFor(row, 'price')} w-full`}
                />
              </td>
              <td className="p-2 text-right">
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    aria-label={`Remove row ${index + 1}`}
                    className="border border-tr-line px-2 py-1 text-xs text-tr-dim hover:border-tr-down hover:text-tr-down"
                  >
                    ×
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setRows((current) => [...current, { ...EMPTY }])}
          disabled={rows.length >= MANUAL_MAX_LEGS}
          data-testid="builder-add-row"
          className="border border-tr-line bg-tr-panel px-3 py-1.5 text-sm hover:border-tr-up disabled:opacity-40"
        >
          Add a row
        </button>
        <button
          type="button"
          onClick={estimate}
          disabled={instrument === ''}
          data-testid="builder-estimate"
          title="Fill in the blanks from this market's candles"
          className="border border-tr-notice/60 bg-tr-panel px-3 py-1.5 text-sm text-tr-notice hover:border-tr-notice disabled:opacity-40"
        >
          Estimate blanks
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={instrument === ''}
          data-testid="builder-submit"
          className="border border-tr-line bg-tr-panel px-4 py-1.5 text-sm hover:border-tr-up disabled:opacity-40"
        >
          Replay it
        </button>
      </div>

      <p className="text-xs text-tr-dim">
        Fill in whichever half you remember. <strong>Estimate blanks</strong> resolves a
        missing price from the candle at that time, and a missing date from the most recent
        time the market touched that price — working backwards so an exit never lands before
        its entry. Estimated values are shown in orange and stay editable.
      </p>

      {error ? (
        <p className="text-xs text-tr-down" data-testid="builder-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
