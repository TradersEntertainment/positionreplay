/**
 * Ask a venue, on the record, whether it will serve one trader's fills to a stranger.
 *
 *   pnpm probe:venue lighter <l1-address>
 *   pnpm probe:venue aster   <address>
 *
 * CLAUDE.md: "Never guess at a venue's API contract. If the docs are unclear, write a
 * small script and check against the live endpoint before building on it." This is that
 * script, and it exists because the docs for both venues are ambiguous in the one way
 * that decides whether an adapter is possible at all.
 *
 * The question is narrow and it is not "does the API work". Hyperliquid and Polymarket
 * serve any address's history to anyone, which is what lets this product replay a
 * trader you are not. If Lighter and Aster only serve *your own* fills against an API
 * key, then no adapter can replay someone else's positions there, and no amount of
 * code changes that.
 *
 * Read-only. It sends no key, signs nothing, and writes nothing.
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

interface Probe {
  /** What we are hoping this proves. */
  question: string;
  url: string;
}

const VENUES: Record<string, (account: string) => Probe[]> = {
  lighter: (account) => [
    {
      question: 'Is an account resolvable from an L1 address without a key?',
      url: `https://mainnet.zklighter.elliot.ai/api/v1/account?by=l1_address&value=${account}`,
    },
    {
      question: 'PUBLIC MARKET trades — expected to work, and not what we need.',
      url: 'https://mainnet.zklighter.elliot.ai/api/v1/trades?market_id=0&limit=2',
    },
    {
      question: 'THE ONE THAT MATTERS: this account\'s own fills, unauthenticated.',
      url: `https://mainnet.zklighter.elliot.ai/api/v1/trades?account_index=${account}&limit=2`,
    },
    {
      question: 'Candles for a replay series.',
      url: 'https://mainnet.zklighter.elliot.ai/api/v1/candlesticks?market_id=0&resolution=1h&count_back=2',
    },
  ],
  aster: (account) => [
    {
      question: 'Public market data — expected to work.',
      url: 'https://fapi.asterdex.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2',
    },
    {
      question: 'Does the venue list its symbols publicly?',
      url: 'https://fapi.asterdex.com/fapi/v1/exchangeInfo',
    },
    {
      question: "THE ONE THAT MATTERS: an address's fills without a key or signature.",
      url: `https://fapi.asterdex.com/fapi/v1/userTrades?symbol=BTCUSDT&address=${account}`,
    },
    {
      question: 'Is there a public per-address position view?',
      url: `https://fapi.asterdex.com/fapi/v2/positionRisk?address=${account}`,
    },
  ],
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: 'string' }, help: { type: 'boolean', default: false } },
});

async function main(): Promise<number> {
  const venue = positionals[0];
  const account = positionals[1];

  if (values.help || !venue || !account || !VENUES[venue]) {
    console.log(`
pnpm probe:venue <${Object.keys(VENUES).join('|')}> <account> [--out probe.json]

  Prints, per endpoint, the status and the first slice of the body, so the contract can
  be written from what the venue actually returns rather than from what its docs imply.
`);
    return values.help ? 0 : 1;
  }

  const results: unknown[] = [];

  for (const probe of VENUES[venue]!(account)) {
    process.stdout.write(`\n${probe.question}\n  GET ${probe.url}\n`);

    try {
      const started = Date.now();
      const response = await fetch(probe.url, { headers: { Accept: 'application/json' } });
      const text = await response.text();
      const took = Date.now() - started;

      console.log(`  -> ${response.status} ${response.statusText} (${took}ms)`);
      console.log(`     ${text.slice(0, 400).replace(/\n/g, ' ')}`);
      results.push({ ...probe, status: response.status, body: text.slice(0, 4000) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  -> UNREACHABLE: ${message}`);
      results.push({ ...probe, error: message });
    }
  }

  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nWrote ${values.out}`);
  }

  console.log(
    `\nWhat to look for: the probe marked "THE ONE THAT MATTERS". A 200 with this\n` +
      `account's own trades in it means an adapter is possible. A 401/403, or a 200\n` +
      `holding someone else's trades, means it is not — and that is a product answer,\n` +
      `not a bug to work around.`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
