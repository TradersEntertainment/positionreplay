/**
 * SPEC §8 `/` — the input.
 *
 * The episode list lives at `/a/[venue]/[address]`, so this only routes there.
 *
 * §8 offers "auto-detect from address format" as a nice-to-have, but both venues use
 * plain 0x accounts, so nothing in the string distinguishes them. A toggle is the
 * honest affordance; guessing would send people to the wrong venue silently.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { SUPPORTED_VENUES, VENUE_LABELS, VENUE_LIMITATIONS, isSupportedVenue } from '@trade-replay/adapters';

export const dynamic = 'force-dynamic';

const EXAMPLE = '0x393d0b87ed38fc779fd9611144ae649ba6082109';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ address?: string; venue?: string }>;
}) {
  const { address, venue } = await searchParams;
  const chosen = venue && isSupportedVenue(venue) ? venue : 'hyperliquid';

  if (address && address.trim()) {
    redirect(`/a/${chosen}/${encodeURIComponent(address.trim())}`);
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">trade-replay</h1>
      <p className="mt-1 text-sm text-tr-dim">
        Replay a trader&apos;s position from open to close.
      </p>

      <form method="GET" className="mt-6 flex gap-2">
        <select
          name="venue"
          defaultValue={chosen}
          aria-label="Venue"
          data-testid="venue-select"
          className="border border-tr-line bg-tr-panel px-3 py-2 text-sm text-tr-text outline-none focus:border-tr-up"
        >
          {SUPPORTED_VENUES.map((option) => (
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

      <ul className="mt-6 space-y-2 text-xs text-tr-dim">
        {SUPPORTED_VENUES.map((option) => {
          const limitation = VENUE_LIMITATIONS[option];
          return limitation ? (
            <li key={option} className="border border-tr-notice/30 bg-tr-notice/5 p-2 text-tr-notice">
              <span className="font-bold">{VENUE_LABELS[option] ?? option}:</span> {limitation}
            </li>
          ) : null;
        })}
      </ul>

      <p className="mt-8 text-sm text-tr-dim">
        Try{' '}
        <Link href={`/a/hyperliquid/${EXAMPLE}`} className="underline hover:text-tr-text">
          {EXAMPLE}
        </Link>
      </p>
    </main>
  );
}
