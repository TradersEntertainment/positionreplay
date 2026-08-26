/**
 * M2 demo: render one frame of an episode to a PNG, in plain Node.
 *
 *   pnpm render:still 0x393d... --fixture synthetic
 *   pnpm render:still 0x393d... --fixture synthetic --episode 0 --size 1920x1080
 *
 * SPEC §12 M2: "packages/renderer + a Node script that renders ONE frame (the final
 * frame of a chosen episode) to out.png. No animation, no browser."
 *
 * That this runs at all is the point of SPEC §7's purity rule: the same renderFrame
 * drives the browser player in M3 and the MP4 worker in M8.
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { adapterFor, isSupportedVenue, limitationText } from '@trade-replay/adapters';
import { HttpError, VenueUnreachableError } from '@trade-replay/adapters';
import { buildEpisodes, buildFrames, pickInterval, seriesRangeFor } from '@trade-replay/core';
import type { PositionEpisode } from '@trade-replay/core';
import { createSequenceRenderer, darkTheme, lightTheme } from '@trade-replay/renderer';
import type { Canvas2D } from '@trade-replay/renderer';
import { bold, cyan, dim, green, red, usd, yellow } from './format.js';
import { createCachedSource } from '@trade-replay/cache';

const require = createRequire(import.meta.url);

/**
 * SPEC §7.3: bundle the font, since both the browser and Node need it. Registering it
 * here rather than inside the renderer is what keeps renderFrame host-agnostic — the
 * host provides fonts, the renderer just names them.
 */
function registerFonts(): boolean {
  for (const [file, weight] of [
    ['jetbrains-mono-latin-400-normal.woff2', 400],
    ['jetbrains-mono-latin-700-normal.woff2', 700],
  ] as const) {
    try {
      GlobalFonts.registerFromPath(
        require.resolve(`@fontsource/jetbrains-mono/files/${file}`),
        'JetBrains Mono',
      );
    } catch {
      console.warn(yellow(`  could not register JetBrains Mono ${weight}; falling back to a system mono`));
      return false;
    }
  }
  return GlobalFonts.families.some((f) => f.family === 'JetBrains Mono');
}

const SIZES: Record<string, [number, number]> = {
  // SPEC §9: "1080x1080 (square, best for X timeline) and 1920x1080 presets."
  square: [1080, 1080],
  wide: [1920, 1080],
};

function parseSize(value: string | undefined): [number, number] {
  if (!value) return SIZES['square']!;
  const preset = SIZES[value];
  if (preset) return preset;

  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Bad --size "${value}". Use square, wide, or WIDTHxHEIGHT.`);
  }
  return [Number(match[1]), Number(match[2])];
}

/** Default to the episode with the largest absolute net PnL — the interesting one. */
function pickEpisode(episodes: PositionEpisode[], index: string | undefined): PositionEpisode {
  if (index !== undefined) {
    const chosen = episodes[Number(index)];
    if (!chosen) {
      throw new Error(`No episode at index ${index}. There are ${episodes.length}.`);
    }
    return chosen;
  }
  return episodes.reduce((best, e) =>
    Math.abs(e.realizedPnl - e.totalFees) > Math.abs(best.realizedPnl - best.totalFees) ? e : best,
  );
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      venue: { type: 'string' },
      fixture: { type: 'string' },
      episode: { type: 'string' },
      frame: { type: 'string' },
      size: { type: 'string' },
      interval: { type: 'string' },
      out: { type: 'string' },
      theme: { type: 'string' },
      leverage: { type: 'string' },
      'x-mode': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  // A CSV fixture's account is a content hash of the uploaded file, which nobody can
  // type; the fixture supplies it. Every other venue still needs an address.
  const fixtureCsv = values.venue === 'csv' && values.fixture !== undefined;
  if (values.help || (positionals.length === 0 && !fixtureCsv)) {
    console.log(`
pnpm render:still <address> [options]

  --venue <v>         hyperliquid (default), polymarket-perps or csv
                      (with --venue csv --fixture, <address> may be omitted)
  --fixture [name]    Replay a recorded fixture instead of calling the venue
  --episode <i>       Episode index (default: largest absolute PnL)
  --frame <i>         Frame index (default: the final frame)
  --size <s>          square (1080x1080), wide (1920x1080), or WIDTHxHEIGHT
  --interval <i>      Override the auto-selected candle interval
  --theme <t>         dark (default) or light
  --leverage <n>      Draw a leverage overlay. Never derived — SPEC §4.3
  --x-mode <m>        growing (default) or fixed. SPEC §7.2
  --out <path>        Output path (default: out.png)
`);
    return values.help ? 0 : 1;
  }

  const venue = values.venue ?? 'hyperliquid';
  if (!isSupportedVenue(venue)) {
    console.error(`${red('Unknown venue')} "${venue}".`);
    return 1;
  }
  const adapter = adapterFor(venue);
  const source = createCachedSource(values.fixture === '' ? 'synthetic' : values.fixture, {
    venue: adapter.id,
  });
  const input = await adapter.parseInput(
    positionals[0] ?? source.defaultAccount ?? '',
    source.ctx,
  );

  console.log(`${dim('source  ')} ${source.label}`);
  console.log(`${dim('address ')} ${cyan(input.address)}`);

  const fills = await adapter.fetchFills(input, undefined, source.ctx);
  if (fills.length === 0) {
    console.error(red('No fills for this address — nothing to render.'));
    return 1;
  }

  const fillRange = {
    from: Math.min(...fills.map((f) => f.ts)),
    to: Math.max(...fills.map((f) => f.ts)),
  };
  const funding = (await adapter.fetchFunding?.(input, fillRange, source.ctx)) ?? [];
  const episodes = buildEpisodes(fills, { venue: adapter.id, funding });

  const episode = pickEpisode(episodes, values.episode);
  const now = Date.now();
  const range = seriesRangeFor(episode, now);
  const picked = pickInterval((episode.closedAt ?? now) - episode.openedAt, adapter.intervals, {
    ...(values.interval ? { override: values.interval } : {}),
  });

  console.log(
    `${dim('episode ')} ${episode.displayName} ${episode.direction.toUpperCase()} ` +
      `${dim('net')} ${usd(episode.realizedPnl - episode.totalFees + episode.totalFunding)}`,
  );
  console.log(`${dim('interval')} ${picked.interval} ${dim(`(~${picked.count} bars)`)}`);

  const series = await adapter.fetchSeries(
    { instrument: episode.instrument, interval: picked.interval, from: range.from, to: range.to },
    source.ctx,
  );

  const frames = buildFrames(episode, series);
  if (frames.length === 0) {
    console.error(red('The series produced no frames — nothing to render.'));
    return 1;
  }

  const frameIndex = values.frame === undefined ? frames.length - 1 : Number(values.frame);
  const frame = frames[frameIndex];
  if (!frame) {
    console.error(red(`No frame at index ${frameIndex}. There are ${frames.length}.`));
    return 1;
  }

  const [width, height] = parseSize(values.size);
  const hasFont = registerFonts();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Notices must reach the image itself, not just the terminal: an export is a
  // screenshot someone posts as fact (CLAUDE.md).
  const limitation = limitationText(adapter.id);
  const notices = [
    ...(limitation ? [limitation] : []),
    ...source.warnings.map((w) => w.message),
    ...(picked.warning ? [picked.warning] : []),
    ...(source.provenanceWarning ? ['SYNTHETIC DATA — not a real position'] : []),
  ];

  // The same renderer the player, the browser export and M8's worker use. It replays
  // the easing up to this frame and supplies its energy, so the still is framed and
  // lit exactly as the animation would show it — which is the only reason this command
  // is a useful way to look at a change.
  const renderer = createSequenceRenderer(
    episode,
    series,
    frames,
    values.theme === 'light' ? lightTheme : darkTheme,
  );

  renderer.render(ctx as unknown as Canvas2D, frameIndex, {
      width,
      height,
      dpr: 1,
      address: input.address,
      watermark: 'trade-replay',
      interval: picked.interval,
      ...(values.leverage ? { leverage: Number(values.leverage) } : {}),
      // The venue has no per-account funding to give (SPEC §4.4.2); a $0.00 in the
      // exported image would assert that none was paid.
      ...(adapter.fetchFunding ? {} : { fundingUnavailable: true }),
    ...(values['x-mode'] === 'fixed' ? { xMode: 'fixed' as const } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  });

  const out = values.out ?? 'out.png';
  writeFileSync(out, canvas.toBuffer('image/png'));

  console.log(
    `${dim('frame   ')} ${frameIndex + 1}/${frames.length}   ${dim('font')} ` +
      `${hasFont ? 'JetBrains Mono' : yellow('system fallback')}`,
  );
  console.log(`\n${green('Wrote')} ${bold(out)} ${dim(`(${width}x${height})`)}`);
  if (notices.length > 0) {
    console.log(yellow(`  ${notices.length} notice(s) drawn onto the image`));
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
    } else if (error instanceof HttpError && (error.status === 403 || error.status === 407)) {
      console.error(
        `\n${red('Blocked by network policy, not by Hyperliquid.')}\n  ${error.message}\n\n` +
          dim('  Try --fixture synthetic, or capture real data where the network is open.'),
      );
    } else {
      console.error(`\n${red('Failed:')} ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });
