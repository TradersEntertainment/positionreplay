/**
 * M1 acceptance check.
 *
 *   pnpm verify:m1 0x393d0b87ed38fc779fd9611144ae649ba6082109
 *   pnpm verify:m1 0x393d... --fixture 0x393d...
 *
 * SPEC §12 M1: "Done when: the numbers match what Hyperliquid's own UI shows for
 * that wallet." A machine cannot see Hyperliquid's UI, so this does the two checks
 * that CAN be made mechanically — SPEC §5's sanity assertions — and then prints the
 * table a human compares against the venue.
 *
 * Exits non-zero if any mechanical check fails.
 */

import { parseArgs } from 'node:util';
import { hyperliquidAdapter } from '@trade-replay/adapters';
import { HttpError, VenueUnreachableError } from '@trade-replay/adapters';
import { actionForDir } from '@trade-replay/adapters/hyperliquid';
import { buildEpisodes } from '@trade-replay/core';
import type { PositionEpisode } from '@trade-replay/core';
import { bold, cyan, date, dim, green, num, red, signed, table, usd, yellow } from './format.js';
import { createSource } from '@trade-replay/adapters/source';

const CLOSED_PNL_TOLERANCE = 0.005; // SPEC §5: 0.5%

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function checkDirLabels(episodes: PositionEpisode[]): Check {
  let checked = 0;
  const mismatches: string[] = [];

  for (const episode of episodes) {
    for (const step of episode.steps) {
      const permitted = actionForDir(step.fill.dir);
      if (!permitted) continue;
      checked++;
      if (!permitted.includes(step.action)) {
        mismatches.push(`${step.fill.id}: venue dir="${step.fill.dir}" but we derived "${step.action}"`);
      }
    }
  }

  if (checked === 0) {
    return {
      name: 'dir cross-check (SPEC §4.3)',
      passed: false,
      detail: 'no venue dir labels were present to check against — cannot confirm agreement',
    };
  }

  return {
    name: 'dir cross-check (SPEC §4.3)',
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${checked} fills agree with the venue's own open/close/flip labels`
        : mismatches.slice(0, 10).join('\n      '),
  };
}

function checkClosedPnl(episodes: PositionEpisode[]): Check {
  const notes = episodes.flatMap((e) => e.reconciliation.map((n) => ({ episode: e, note: n })));

  return {
    name: `closedPnl reconciliation (within ${(CLOSED_PNL_TOLERANCE * 100).toFixed(1)}%)`,
    passed: notes.length === 0,
    detail:
      notes.length === 0
        ? 'our realized PnL matches the venue value on every closing fill'
        : notes
            .slice(0, 10)
            .map(
              ({ note }) =>
                `${note.fillId}: ours ${usd(Number(note.ours))} vs venue ${usd(Number(note.venue))} ` +
                `(${((note.relativeDelta ?? 0) * 100).toFixed(2)}%)`,
            )
            .join('\n      '),
  };
}

/**
 * SPEC §5: "boughtNotional - soldNotional reconciles with realized + holding value."
 * For a closed episode there is no holding value left, so the two sides must agree
 * up to fees.
 */
function checkNotional(episodes: PositionEpisode[]): Check {
  const bad: string[] = [];

  for (const e of episodes) {
    if (e.closedAt === null) continue;
    const flow = e.soldNotional - e.boughtNotional;
    const scale = Math.max(Math.abs(flow), Math.abs(e.realizedPnl), 1);
    if (Math.abs(flow - e.realizedPnl) / scale > CLOSED_PNL_TOLERANCE) {
      bad.push(
        `${e.id}: sold-bought ${usd(flow)} vs realized ${usd(e.realizedPnl)}`,
      );
    }
  }

  return {
    name: 'notional reconciliation (SPEC §5)',
    passed: bad.length === 0,
    detail:
      bad.length === 0
        ? 'sold minus bought equals realized PnL on every closed episode'
        : bad.slice(0, 10).join('\n      '),
  };
}

function checkAllClosed(episodes: PositionEpisode[]): Check {
  const open = episodes.filter((e) => e.closedAt === null);
  return {
    name: 'episode closure',
    passed: true, // Informational: an open position is legitimate (§11 case 1).
    detail:
      open.length === 0
        ? 'every episode reconstructed back to flat'
        : `${open.length} still open (expected if the account holds a position right now)`,
  };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { fixture: { type: 'string' }, help: { type: 'boolean', default: false } },
  });

  if (values.help || positionals.length === 0) {
    console.log(`
pnpm verify:m1 <address> [--fixture <name>]

  Runs SPEC §5's sanity assertions against real venue data and prints the episode
  table to compare with Hyperliquid's own UI.
`);
    return values.help ? 0 : 1;
  }

  const source = createSource(values.fixture === '' ? 'synthetic' : values.fixture);
  const input = await hyperliquidAdapter.parseInput(positionals[0]!, source.ctx);

  console.log(bold('M1 verification'));
  console.log(`${dim('source  ')} ${source.label}`);
  console.log(`${dim('address ')} ${cyan(input.address)}\n`);

  const fills = await hyperliquidAdapter.fetchFills(input, undefined, source.ctx);
  if (fills.length === 0) {
    console.error(red('No fills for this address — nothing to verify.'));
    return 1;
  }

  const range = {
    from: Math.min(...fills.map((f) => f.ts)),
    to: Math.max(...fills.map((f) => f.ts)),
  };
  const funding = (await hyperliquidAdapter.fetchFunding?.(input, range, source.ctx)) ?? [];
  const episodes = buildEpisodes(fills, { venue: 'hyperliquid', funding });

  console.log(
    `${dim('fills')} ${fills.length}   ${dim('funding')} ${funding.length}   ${dim('episodes')} ${episodes.length}\n`,
  );

  const checks = [
    checkDirLabels(episodes),
    checkClosedPnl(episodes),
    checkNotional(episodes),
    checkAllClosed(episodes),
  ];

  for (const check of checks) {
    const mark = check.passed ? green('PASS') : red('FAIL');
    console.log(`  ${mark}  ${check.name}`);
    console.log(`        ${dim(check.detail)}`);
  }

  console.log(`\n${bold('Episodes')} ${dim('— compare these against the wallet in Hyperliquid’s UI')}`);
  console.log(
    table(
      ['INSTRUMENT', 'DIR', 'OPENED', 'CLOSED', 'AVG ENTRY', 'REALIZED', 'FEES', 'FUNDING', 'NET'],
      episodes.map((e) => [
        e.displayName,
        e.direction === 'long' ? 'LONG' : 'SHORT',
        date(e.openedAt),
        e.closedAt === null ? yellow('OPEN') : date(e.closedAt),
        num(e.avgEntry, 4),
        signed(e.realizedPnl),
        usd(e.totalFees),
        signed(e.totalFunding),
        bold(signed(e.realizedPnl - e.totalFees + e.totalFunding)),
      ]),
      ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
    ),
  );

  if (source.warnings.length > 0) {
    console.log(`\n${yellow('Warnings')} ${dim('— these change how the numbers should be read')}`);
    for (const w of source.warnings) console.log(`  [${w.kind}] ${w.message}`);
  }

  if (source.provenanceWarning) {
    console.log(
      `\n${red('NOT REAL DATA')} — this run proves the plumbing works, not that the numbers are right.`,
    );
    console.log(dim(`  ${source.provenanceWarning}`));
    console.log(dim('  Capture real data first:  pnpm capture:hl <address>'));
  }

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    console.log(`\n${red(`${failed.length} check(s) failed.`)} M1 is not done.`);
    return 1;
  }

  console.log(
    `\n${green('Mechanical checks pass.')} M1 is done once the table above matches Hyperliquid’s UI.`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof VenueUnreachableError) {
      console.error(`\n${red('Cannot reach Hyperliquid.')}\n${error.message}`);
    } else if (error instanceof HttpError && (error.status === 403 || error.status === 407)) {
      console.error(
        `\n${red('Blocked by network policy, not by Hyperliquid.')}\n  ${error.message}\n\n` +
          dim('  Allow api.hyperliquid.xyz here, or capture a fixture where the network is open.'),
      );
    } else {
      console.error(`\n${red('Failed:')} ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });
