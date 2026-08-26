/**
 * SPEC §8 `/` — the input: "wallet address, venue toggle …, or CSV drop zone".
 *
 * The episode list lives at `/a/[venue]/[address]`, so this only routes there. A CSV
 * has no address to route by, so it posts to /api/csv/upload and goes through the
 * mapping step at /csv/<id> first.
 *
 * §8 offers "auto-detect from address format" as a nice-to-have, but both wallet
 * venues use plain 0x accounts, so nothing in the string distinguishes them. A toggle
 * is the honest affordance; guessing would send people to the wrong venue silently.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { SUPPORTED_VENUES, VENUE_LABELS, VENUE_LIMITATIONS, isSupportedVenue } from '@trade-replay/adapters';
import { MAX_UPLOAD_BYTES } from '../lib/csv';

/** The CSV venue is reached by uploading a file, not by typing an account. */
const WALLET_VENUES = SUPPORTED_VENUES.filter((v) => v !== 'csv');

export const dynamic = 'force-dynamic';

const EXAMPLE = '0x393d0b87ed38fc779fd9611144ae649ba6082109';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ address?: string; venue?: string; csvError?: string }>;
}) {
  const { address, venue, csvError } = await searchParams;
  const chosen = venue && isSupportedVenue(venue) ? venue : 'hyperliquid';

  if (address && address.trim()) {
    redirect(`/a/${chosen}/${encodeURIComponent(address.trim())}`);
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Replay a trader&apos;s position</h1>
      <p className="mt-1 text-sm text-tr-dim">
        From open to close, as a chart that plays. Paste an address, or upload your own
        fills.
      </p>

      <form method="GET" className="mt-6 flex gap-2">
        <select
          name="venue"
          // Remounted when the choice changes. React ignores a new `defaultValue` on an
          // input that is already mounted, so arriving here from a header chip by
          // client-side navigation left the select showing the previous venue.
          key={chosen}
          defaultValue={chosen}
          aria-label="Venue"
          data-testid="venue-select"
          className="border border-tr-line bg-tr-panel px-3 py-2 text-sm text-tr-text outline-none focus:border-tr-up"
        >
          {WALLET_VENUES.map((option) => (
            <option key={option} value={option}>
              {VENUE_LABELS[option] ?? option}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="address"
          placeholder={EXAMPLE}
          aria-label="Wallet address"
          data-testid="address-input"
          className="flex-1 border border-tr-line bg-tr-panel px-3 py-2 text-sm outline-none focus:border-tr-up"
        />
        <button
          type="submit"
          data-testid="address-submit"
          className="border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
        >
          Load
        </button>
      </form>

      <p className="mt-2 text-xs text-tr-dim">
        A 0x… address. Neither venue supports username lookup here.
      </p>

      {/* SPEC §8's CSV drop zone. A plain file input: it is the drop target browsers
          already give for free, it works without JavaScript, and it is the same thing
          a keyboard user reaches. */}
      <form
        method="POST"
        action="/api/csv/upload"
        encType="multipart/form-data"
        className="mt-8 border border-dashed border-tr-line p-4"
        data-testid="csv-form"
      >
        <p className="text-sm font-bold">…or replay a CSV of your own fills</p>
        <p className="mt-1 text-xs text-tr-dim">
          Any exchange export. You map the columns on the next screen — no particular
          header names are required. Up to {MAX_UPLOAD_BYTES / 1_048_576} MB.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="file"
            name="file"
            accept=".csv,.txt,text/csv,text/plain"
            aria-label="Trades CSV"
            data-testid="csv-input"
            className="flex-1 border border-tr-line bg-tr-panel px-3 py-2 text-sm file:mr-3 file:border-0 file:bg-transparent file:text-tr-text"
          />
          <button
            type="submit"
            data-testid="csv-submit"
            className="border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
          >
            Upload
          </button>
        </div>
        {csvError ? (
          <p className="mt-2 text-xs text-tr-down" data-testid="csv-upload-error">
            {csvError}
          </p>
        ) : null}
      </form>

      <ul className="mt-6 space-y-2 text-xs text-tr-dim">
        {SUPPORTED_VENUES.map((option) => {
          const limitation = VENUE_LIMITATIONS[option];
          return limitation ? (
            <li key={option} className="border border-tr-notice/30 bg-tr-notice/5 p-2 text-tr-notice">
              <span className="font-bold">{VENUE_LABELS[option] ?? option}:</span>{' '}
              {limitation.detail}
            </li>
          ) : null;
        })}
      </ul>

      <p className="mt-8 text-sm text-tr-dim">
        …or{' '}
        <Link href="/build" className="underline hover:text-tr-text" data-testid="build-link">
          build a position by hand
        </Link>{' '}
        — pick a market, type the entries and exits, and watch it play against the real
        chart.
      </p>

      <p className="mt-4 text-sm text-tr-dim">
        Try{' '}
        <Link href={`/a/hyperliquid/${EXAMPLE}`} className="underline hover:text-tr-text">
          {EXAMPLE}
        </Link>
      </p>
    </main>
  );
}
