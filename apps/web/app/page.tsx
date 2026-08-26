/**
 * SPEC §8 `/` — the input.
 *
 * The episode list lives at `/a/[venue]/[address]`, so this only routes there. Venue is
 * hardcoded because Hyperliquid is the only adapter that exists; a toggle implying
 * otherwise would be a UI affordance for something that does not work (SPEC §4.5 makes
 * the same point about usernames).
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const EXAMPLE = '0x393d0b87ed38fc779fd9611144ae649ba6082109';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ address?: string }>;
}) {
  const { address } = await searchParams;
  if (address && address.trim()) {
    redirect(`/a/hyperliquid/${encodeURIComponent(address.trim())}`);
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">trade-replay</h1>
      <p className="mt-1 text-sm text-tr-dim">
        Replay a trader&apos;s position from open to close.
      </p>

      <form method="GET" className="mt-6 flex gap-2">
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
        Hyperliquid address or ENS name. Hyperliquid has no username system.
      </p>

      <p className="mt-8 text-sm text-tr-dim">
        Try{' '}
        <Link href={`/a/hyperliquid/${EXAMPLE}`} className="underline hover:text-tr-text">
          {EXAMPLE}
        </Link>
      </p>
    </main>
  );
}
