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
import { FeaturedTraders } from '@/components/FeaturedTraders';
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
        From open to close, as a chart that plays. Pick a trader below, paste an address, or
        upload your own fills.
      </p>

      {/* First, because it is the only thing here that works for someone who arrived
          knowing nobody. Every other entry point starts from something you have to
          already have: an address, a market and a memory, or a file. */}
      <FeaturedTraders />

      {/* flex-wrap because this row does not fit a phone: the select, a 42-character
          address placeholder and the button came to 516px against a 390px viewport, and
          the whole page scrolled sideways. SPEC §13 asks only that mobile not be
          broken, and a front page you have to swipe to read is broken. */}
      <form method="GET" className="mt-8 flex flex-wrap gap-2">
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
          // min-w-0 so the placeholder's intrinsic width cannot stop it shrinking; the
          // basis keeps it on its own row on a phone and beside the select on a desktop.
          className="min-w-0 flex-1 basis-64 border border-tr-line bg-tr-panel px-3 py-2 text-sm outline-none focus:border-tr-up"
        />
        <button
          type="submit"
          data-testid="address-submit"
          className="border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
        >
          Load
        </button>
      </form>

      <p className="mt-2 text-xs text-tr-dim" data-testid="address-hint">
        A 0x… address — neither venue has a username lookup.{' '}
        {chosen === 'polymarket-perps' ? (
          // Said before the attempt, not only after it fails. Pasting the address from a
          // polymarket.com profile is the obvious thing to try, and it is the one thing
          // that cannot work: Predictions and Perps are separate account systems, and
          // the Perps API rejects a proxy wallet outright.
          <span className="text-tr-notice">
            For Perps this must be the trader&apos;s <strong>Perps</strong> address. The one
            in a polymarket.com profile link is their Predictions proxy wallet, which the
            Perps API does not recognise.
          </span>
        ) : null}
      </p>

      {/* The builder, as a panel rather than a line of link text below two banners. It
          used to be the only entry point that needed no address at all; the featured
          traders above are now the other one, and the better answer for someone who has
          not traded themselves. This one is for a trade you remember making. */}
      <div className="mt-8 border border-tr-up/40 bg-tr-up/5 p-4">
        <p className="text-sm font-bold">…or build a position by hand</p>
        <p className="mt-1 text-xs text-tr-dim">
          Pick a market and say what you remember — &ldquo;bought at 86,000, sold at
          91,000&rdquo;. The dates are filled in from the real chart. No address needed.
        </p>
        <Link
          href="/build"
          data-testid="build-link"
          className="mt-3 inline-block border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
        >
          Open the builder
        </Link>
      </div>

      {/* SPEC §8's CSV drop zone. The native file input is hidden behind our own label:
          its button text and "no file chosen" are rendered by the browser in the
          browser's language, which is where Turkish appeared on an otherwise English
          page. The input element itself stays, so this still submits without JavaScript
          and is still reachable by keyboard. */}
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
          <label className="flex flex-1 cursor-pointer items-center gap-3 border border-tr-line bg-tr-panel px-3 py-2 text-sm hover:border-tr-up">
            <span className="border border-tr-line px-3 py-1 text-xs">Choose a file</span>
            <span className="text-xs text-tr-dim">CSV or TSV, any exchange</span>
            <input
              type="file"
              name="file"
              accept=".csv,.txt,text/csv,text/plain"
              aria-label="Trades CSV"
              data-testid="csv-input"
              className="sr-only"
            />
          </label>
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

    </main>
  );
}
