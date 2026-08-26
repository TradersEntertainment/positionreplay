'use client';

/**
 * Build a position by hand: pick a market, type the entries and exits, replay it.
 *
 * The chart is the venue's real one; the position is a construction. That is stated on
 * this form, on the replay page, and in the exported image — see `RenderLayout.constructed`
 * for why it is drawn into the pixels rather than only onto the page.
 *
 * There is no submit endpoint. The whole spec is encoded into the URL, so the link is
 * shareable with nothing stored behind it, and a "what if I had bought here" is exactly
 * the kind of thing people send to each other.
 */

import { MANUAL_MAX_LEGS, ManualSpecError, encodeManualSpec } from '@trade-replay/core';
import type { ManualLeg } from '@trade-replay/core';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface BuilderVenue {
  id: string;
  label: string;
}

interface Row {
  /** `datetime-local` value, in the viewer's own zone. */
  when: string;
  side: 'buy' | 'sell';
  size: string;
  price: string;
}

const EMPTY: Row = { when: '', side: 'buy', size: '', price: '' };

/** A buy then a sell: the shape almost every position has, pre-filled. */
function initialRows(): Row[] {
  return [{ ...EMPTY }, { ...EMPTY, side: 'sell' }];
}

/**
 * `datetime-local` to epoch milliseconds.
 *
 * The input has no zone, and `new Date("2026-01-02T12:00")` is read as *local* time by
 * every browser — which is what someone typing a chart time means. Returning NaN for an
 * unparseable value keeps the check in one place, in core's normalizer.
 */
function toEpoch(value: string): number {
  return value === '' ? Number.NaN : new Date(value).getTime();
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

  // The instrument list comes from the venue itself, so a market that cannot be
  // charted cannot be picked.
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

  const displayName = useMemo(
    () => instruments.find((i) => i.instrument === instrument)?.displayName ?? '',
    [instruments, instrument],
  );

  const update = useCallback((index: number, patch: Partial<Row>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const submit = useCallback(() => {
    setError(null);

    const legs: ManualLeg[] = rows
      // A blank row is someone who added one and changed their mind, not an error.
      .filter((row) => row.when !== '' || row.size !== '' || row.price !== '')
      .map((row) => ({
        ts: toEpoch(row.when),
        side: row.side,
        size: Number(row.size),
        price: Number(row.price),
      }));

    try {
      const encoded = encodeManualSpec({
        venue: venue as never,
        instrument,
        displayName,
        legs,
      });
      router.push(`/b/${encoded}`);
    } catch (cause) {
      // ManualSpecError carries a sentence written for this form; anything else is a
      // bug and should not be dressed up as advice.
      setError(cause instanceof ManualSpecError ? cause.message : 'Could not build that position.');
    }
  }, [rows, venue, instrument, displayName, router]);

  const field =
    'border border-tr-line bg-tr-panel px-2 py-1.5 text-sm text-tr-text outline-none focus:border-tr-up';

  return (
    <div className="space-y-4" data-testid="position-builder">
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
            <th className="p-2">When</th>
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
                  type="datetime-local"
                  value={row.when}
                  onChange={(e) => update(index, { when: e.target.value })}
                  aria-label={`Row ${index + 1} date and time`}
                  data-testid={`builder-when-${index}`}
                  className={`${field} w-full`}
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
                  className={`${field} w-full`}
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
          onClick={submit}
          disabled={instrument === ''}
          data-testid="builder-submit"
          className="border border-tr-line bg-tr-panel px-4 py-1.5 text-sm hover:border-tr-up disabled:opacity-40"
        >
          Replay it
        </button>
        <span className="text-xs text-tr-dim">
          Leave the last row empty to replay a position that is still open.
        </span>
      </div>

      {error ? (
        <p className="text-xs text-tr-down" data-testid="builder-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
