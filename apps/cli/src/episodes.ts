/**
 * M1 demo: reconstruct and print an address's position episodes.
 *
 *   pnpm episodes 0x393d0b87ed38fc779fd9611144ae649ba6082109
 *   pnpm episodes 0x393d... --fixture synthetic
 *   pnpm episodes 0x393d... --json
 *
 * SPEC §12 M1: "A CLI script: `pnpm episodes 0x082e…` prints a table of reconstructed
 * episodes with PnL. Done when: the numbers match what Hyperliquid's own UI shows."
 * That last check needs live data — see docs/VERIFYING-M1.md.
 */

import { parseArgs } from 'node:util';
import { hyperliquidAdapter } from '@trade-replay/adapters';
import { HttpError, VenueUnreachableError } from '@trade-replay/adapters';
import { buildEpisodes } from '@trade-replay/core';
import type { PositionEpisode } from '@trade-replay/core';
import { bold, cyan, date, dim, duration, num, red, signed, table, usd, yellow } from './format.js';
import { createSource } from '@trade-replay/adapters/source';

const USAGE = `
${bold('pnpm episodes')} <address> [options]

  --fixture [name]   Replay a recorded fixture instead of calling the venue.
                     Defaults to "synthetic". Accepts a name under fixtures/hyperliquid/
                     or a path.
  --instrument <k>   Show only one instrument, e.g. HYPE-PERP
  --open-only        Show only positions that are still open
  --json             Emit JSON instead of a table
  --help             This message
`;

interface Options {
  address: string;
  fixture?: string | undefined;
  instrument?: string | undefined;
  openOnly: boolean;
  json: boolean;
}

type ParseResult = { kind: 'run'; options: Options } | { kind: 'usage'; exitCode: number };

function parseOptions(argv: string[]): ParseResult {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fixture: { type: 'string' },
      instrument: { type: 'string' },
      'open-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) return { kind: 'usage', exitCode: 0 };
  if (positionals.length === 0) return { kind: 'usage', exitCode: 1 };

  return {
    kind: 'run',
    options: {
      address: positionals[0]!,
    // `--fixture` with no value arrives as an empty string; treat that as the default.
      fixture: values.fixture === '' ? 'synthetic' : values.fixture,
      instrument: values.instrument,
      openOnly: values['open-only'] ?? false,
      json: values.json ?? false,
    },
  };
}

/** Distinguishes an egress-policy denial from a venue-side rejection. */
function isEgressBlock(error: unknown): error is Error {
  return (
    error instanceof HttpError &&
    (error.status === 403 || error.status === 407) &&
    /allowlist|egress|proxy|blocked/i.test(error.message)
  );
}

function netOf(e: PositionEpisode): number {
  return e.realizedPnl - e.totalFees + e.totalFunding;
}

function renderTable(episodes: PositionEpisode[]): string {
  const rows = episodes.map((e, i) => [
    String(i),
    e.displayName,
    e.direction === 'long' ? 'LONG' : 'SHORT',
    date(e.openedAt),
    e.closedAt === null ? yellow('OPEN') : date(e.closedAt),
    duration((e.closedAt ?? Date.now()) - e.openedAt),
    num(e.peakSize),
    num(e.avgEntry, 4),
    signed(e.realizedPnl),
    usd(e.totalFees),
    signed(e.totalFunding),
    bold(signed(netOf(e))),
  ]);

  return table(
    ['#', 'INSTRUMENT', 'DIR', 'OPENED', 'CLOSED', 'HELD', 'PEAK', 'AVG ENTRY', 'REALIZED', 'FEES', 'FUNDING', 'NET'],
    rows,
    ['right', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

async function main(): Promise<number> {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.kind === 'usage') {
    console.log(USAGE);
    return parsed.exitCode;
  }
  const { options } = parsed;

  const source = createSource(options.fixture);
  const input = await hyperliquidAdapter.parseInput(options.address, source.ctx);

  if (!options.json) {
    console.log(`${dim('source  ')} ${source.label}`);
    console.log(`${dim('address ')} ${cyan(input.address)}`);
  }

  const fills = await hyperliquidAdapter.fetchFills(input, undefined, source.ctx);

  if (fills.length === 0) {
    // SPEC §11 case 10: an address with zero fills is a real answer, not an error.
    console.log(`\nNo fills found for ${input.address}.`);
    console.log(
      dim(
        '  If this address definitely trades, check that it is the MAIN account and not an\n' +
          '  agent/API wallet — those return empty data (SPEC §4.3).',
      ),
    );
    return 0;
  }

  const range = {
    from: Math.min(...fills.map((f) => f.ts)),
    to: Math.max(...fills.map((f) => f.ts)),
  };
  const funding = (await hyperliquidAdapter.fetchFunding?.(input, range, source.ctx)) ?? [];

  let episodes = buildEpisodes(fills, { venue: 'hyperliquid', funding });
  if (options.instrument) {
    episodes = episodes.filter((e) => e.instrument === options.instrument);
  }
  if (options.openOnly) {
    episodes = episodes.filter((e) => e.closedAt === null);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { address: input.address, source: source.label, warnings: source.warnings, episodes },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`${dim('fills   ')} ${fills.length}   ${dim('funding')} ${funding.length}\n`);
  console.log(renderTable(episodes));

  const totalNet = episodes.reduce((sum, e) => sum + netOf(e), 0);
  const totalFees = episodes.reduce((sum, e) => sum + e.totalFees, 0);
  const totalFunding = episodes.reduce((sum, e) => sum + e.totalFunding, 0);
  console.log(
    `\n${dim('episodes')} ${episodes.length}   ${dim('fees')} ${usd(totalFees)}   ` +
      `${dim('funding')} ${signed(totalFunding)}   ${dim('net')} ${bold(signed(totalNet))}`,
  );

  // SPEC §14: a disagreement with the venue is logged, never silently resolved.
  const notes = episodes.flatMap((e) => e.reconciliation);
  if (notes.length > 0) {
    console.log(`\n${yellow('PnL reconciliation')} — venue value used, our value shown for comparison:`);
    for (const n of notes) {
      console.log(
        `  ${n.fillId}: ours ${usd(Number(n.ours))} vs venue ${usd(Number(n.venue))} ` +
          `(${((n.relativeDelta ?? 0) * 100).toFixed(2)}% apart)`,
      );
    }
  }

  if (source.warnings.length > 0) {
    console.log(`\n${yellow('Warnings')}`);
    for (const w of source.warnings) console.log(`  [${w.kind}] ${w.message}`);
  }

  if (source.provenanceWarning) {
    console.log(`\n${red('NOT REAL DATA')} ${dim(source.provenanceWarning)}`);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof VenueUnreachableError) {
      console.error(`\n${red('Cannot reach Hyperliquid.')}\n${error.message}`);
    } else if (isEgressBlock(error)) {
      // A 403 from a corporate/sandbox egress proxy is not the venue rejecting us.
      // Saying "request failed" here sends people hunting for a bug in the adapter.
      console.error(
        `\n${red('Blocked by network policy, not by Hyperliquid.')}\n  ${error.message}\n\n` +
          dim(
            '  Allow api.hyperliquid.xyz in this environment, or work from a recording:\n' +
              '    pnpm capture:hl <address>   (where the network is open)\n' +
              '    pnpm episodes <address> --fixture <name>',
          ),
      );
    } else {
      console.error(`\n${red('Failed:')} ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });
