/**
 * Queue one render job by hand.
 *
 *   pnpm tsx scripts/enqueue-render.ts <replayId> [--size wide] [--db <url>]
 *
 * The web app queues jobs through /api/render; this exists so the worker can be
 * exercised on its own, without a browser, when something is wrong with one of them
 * and it is not yet clear which.
 */

import { parseArgs } from 'node:util';
import { openCache, createRenderJobStore } from '@trade-replay/cache';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    size: { type: 'string' },
    theme: { type: 'string' },
    fps: { type: 'string' },
    'slow-finish': { type: 'boolean', default: false },
    db: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

const SIZES: Record<string, [number, number]> = { square: [1080, 1080], wide: [1920, 1080] };

async function main(): Promise<number> {
  if (values.help || positionals.length === 0) {
    console.log(`
pnpm tsx scripts/enqueue-render.ts <replayId> [options]

  --size <s>       square (default) or wide
  --theme <t>      dark (default) or light
  --fps <n>        video frame rate (default 30)
  --slow-finish    SPEC §6.3's climax easing
  --db <url>       DATABASE_URL override
`);
    return values.help ? 0 : 1;
  }

  const [width, height] = SIZES[values.size ?? 'square'] ?? SIZES['square']!;
  const handle = openCache({ url: values.db ?? process.env['DATABASE_URL'] ?? 'file:.data/cache.db' });

  try {
    const jobs = createRenderJobStore(handle.db);
    const job = await jobs.enqueue(
      {
        replayId: positionals[0]!,
        width,
        height,
        fps: Number(values.fps ?? 30),
        theme: values.theme === 'light' ? 'light' : 'dark',
        slowFinish: values['slow-finish'] ?? false,
      },
      Date.now(),
    );
    console.log(`${job.status}  ${job.id}`);
    if (job.status === 'done') console.log(`already rendered: ${job.outputPath}`);
    return 0;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
