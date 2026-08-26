/**
 * M8 acceptance check.
 *
 *   pnpm verify:m8
 *
 * SPEC §12 M8: "server MP4 render worker."
 *
 * The payoff SPEC §9 claims is specific — "Because renderFrame is shared, server output
 * is pixel-identical to the browser preview. That's the whole payoff of §7." So this
 * does not stop at "an .mp4 downloaded": it pulls a frame back out of the encoded video
 * and compares it against the same frame drawn in the browser.
 *
 * Needs a web server AND a worker already running, plus ffmpeg on PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Download } from 'playwright';

const BASE = process.env['PLAYER_URL'] ?? 'http://127.0.0.1:3100';
const ADDRESS = process.env['VERIFY_ADDRESS'] ?? '0x393d0b87ed38fc779fd9611144ae649ba6082109';
const SHOTS = process.env['VERIFY_SHOT_DIR'] ?? '.';
const CHROME = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';

const checks: { name: string; passed: boolean; detail: string }[] = [];
const dir = mkdtempSync(join(tmpdir(), 'trade-replay-m8-'));

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
}

async function saveDownload(download: Download, name: string): Promise<string> {
  const path = join(dir, name);
  await download.saveAs(path);
  return path;
}

/** One field from ffprobe, so a claim about the file comes from a decoder. */
function probe(path: string, entries: string): Record<string, string> {
  const output = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', entries, '-of', 'default=noprint_wrappers=1', path],
    { encoding: 'utf8' },
  );
  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
}

async function run(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(`${BASE}/a/hyperliquid/${ADDRESS}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="episode-table"]');
  await page.getByTestId('episode-link').first().click();
  await page.waitForSelector('[data-testid="player"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });

  const frameCount = Number(await page.getByTestId('player').getAttribute('data-frame-count'));

  // --- the button is no longer a placeholder ---
  const label = (await page.getByTestId('export-mp4').textContent()) ?? '';
  record(
    'the MP4 button is real, not the M8 placeholder',
    !(await page.getByTestId('export-mp4').isDisabled()) && !/not built yet/.test(label),
    `label "${label.trim()}"`,
  );

  // --- queue a render and let the worker do it ---
  const started = Date.now();
  const downloadWait = page.waitForEvent('download', { timeout: 600_000 });
  await page.getByTestId('export-mp4').click();

  // Progress has to be visible: an encode takes tens of seconds and a frozen button
  // is indistinguishable from a broken one.
  await page.waitForFunction(
    () => /Queued|Rendering/.test(document.querySelector('[data-testid="export-status"]')?.textContent ?? ''),
    { timeout: 60_000 },
  );
  const progressText = (await page.getByTestId('export-status').textContent()) ?? '';
  record('the server render reports progress while it runs', progressText !== '', progressText.trim());
  writeFileSync(join(SHOTS, 'm8-01-rendering.png'), await page.screenshot());

  // A job that stays queued means nothing is reading the queue. Naming the database
  // beats waiting ten minutes for a download event that cannot arrive.
  //
  // Raced against the download, not waited on alone: an identical render already on
  // disk is handed back immediately (the request key is idempotent), and that job goes
  // from queued to done without ever passing through "Rendering".
  const rendering = page
    .waitForFunction(
      () => /Rendering/.test(document.querySelector('[data-testid="export-status"]')?.textContent ?? ''),
      { timeout: 45_000 },
    )
    .then(() => 'rendered' as const);

  const outcome = await Promise.race([
    rendering,
    downloadWait.then(() => 'reused' as const),
  ]).catch(async () => {
    const health = (await (await fetch(`${BASE}/api/health`)).json()) as { database?: string };
    throw new Error(
      `The job stayed queued: nothing claimed it within 45s.\n` +
        `  web is using   ${health.database ?? '(unknown)'}\n` +
        `  the worker must reach the same queue. Either point it at that file:\n` +
        `    DATABASE_URL=file:${health.database ?? '.data/cache.db'} WEB_URL=${BASE} pnpm worker\n` +
        `  or run it over HTTP with the token web was started with:\n` +
        `    RENDER_TRANSPORT=http RENDER_WORKER_TOKEN=… WEB_URL=${BASE} pnpm worker`,
    );
  });

  const mp4 = await saveDownload(await downloadWait, 'replay.mp4');
  const took = (Date.now() - started) / 1000;

  const magic = readFileSync(mp4).subarray(4, 8).toString('ascii');
  record(
    'the download is a real MP4 container',
    existsSync(mp4) && magic === 'ftyp',
    `${mp4.split('/').pop()} · box "${magic}" · ${(readFileSync(mp4).length / 1024).toFixed(0)} KB · ` +
      `${took.toFixed(0)}s · ${outcome === 'rendered' ? 'rendered by the worker' : 'served from an earlier render'}`,
  );

  // Idempotency is not a nicety here: SPEC §15 asks for it explicitly, and without it
  // a double-clicked button is two ffmpeg processes competing for one machine.
  const repeatStarted = Date.now();
  const repeatWait = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('export-mp4').click();
  const repeat = await saveDownload(await repeatWait, 'replay-again.mp4');
  const repeatSeconds = (Date.now() - repeatStarted) / 1000;
  record(
    'asking again returns the same file instead of re-encoding it',
    readFileSync(repeat).equals(readFileSync(mp4)) && repeatSeconds < 30,
    `identical bytes, returned in ${repeatSeconds.toFixed(1)}s`,
  );

  // --- SPEC §9: H.264 + yuv420p, "required for X/Twitter" ---
  const stream = probe(mp4, 'stream=codec_name,pix_fmt,width,height,nb_frames,r_frame_rate');
  record(
    'H.264 with yuv420p, which is what X accepts',
    stream['codec_name'] === 'h264' && stream['pix_fmt'] === 'yuv420p',
    `${stream['codec_name']} ${stream['pix_fmt']} ${stream['width']}x${stream['height']} @ ${stream['r_frame_rate']}`,
  );

  record(
    'the square preset SPEC §9 names is what was rendered',
    stream['width'] === '1080' && stream['height'] === '1080',
    `${stream['width']}x${stream['height']}`,
  );

  // SPEC §6.3: 24 frames of replay per second. A 30fps video of N timeline frames is
  // N/24 seconds long — if it were N/30, the export would be running fast.
  const format = probe(mp4, 'format=duration');
  const duration = Number(format['duration']);
  record(
    'the video runs at replay speed, not at the container frame rate',
    Math.abs(duration - frameCount / 24) < 0.5,
    `${duration.toFixed(2)}s for ${frameCount} frames; ${(frameCount / 24).toFixed(2)}s expected`,
  );

  // --- the §9 payoff: the server drew the same picture the browser did ---
  //
  // The comparison is against the WebM, not against a screenshot: the WebM is recorded
  // from `canvas.captureStream()` at the same 1080x1080 preset, so it *is* the browser's
  // own render of the same layout. Nothing test-only has to be exposed by the app for
  // this to work, and a layout or scale difference between the two renderers would be
  // impossible to miss.
  const webmWait = page.waitForEvent('download', { timeout: 600_000 });
  await page.getByTestId('export-video').click();
  const webm = await saveDownload(await webmWait, 'replay.webm');

  // The last frame: both files end on it and both hold it, so this is the one moment
  // where their timings cannot disagree.
  for (const [file, out] of [
    [mp4, 'last-server.png'],
    [webm, 'last-browser.png'],
  ] as const) {
    execFileSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-0.15', '-i', file, '-update', '1', '-q:v', '2', join(dir, out)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  writeFileSync(join(SHOTS, 'm8-02-server-frame.png'), readFileSync(join(dir, 'last-server.png')));
  writeFileSync(join(SHOTS, 'm8-03-browser-frame.png'), readFileSync(join(dir, 'last-browser.png')));

  const difference = compareImages(join(dir, 'last-server.png'), join(dir, 'last-browser.png'));
  record(
    'the server render is the same picture as the browser preview (SPEC §9)',
    // Not zero: one file is VP9 from a live capture and the other 4:2:0 H.264 at crf
    // 18, so chroma subsampling and quantisation move pixels a little. A layout or
    // scale difference would move them by far more than this.
    difference.meanAbs < 6,
    `mean channel difference ${difference.meanAbs.toFixed(2)}/255 across ${difference.pixels} pixels`,
  );

  record('no console errors', errors.length === 0, errors.length === 0 ? 'clean' : errors.join('\n        '));

  await page.close();
}

/** Mean absolute per-channel difference, via ffmpeg so no image library is needed. */
function compareImages(a: string, b: string): { meanAbs: number; pixels: number } {
  const output = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      // blend=difference then signalstats: MAX/AVG of the difference image.
      'blend=all_mode=difference,signalstats,metadata=print:file=-',
      '-f',
      'null',
      '-',
    ],
    // stderr piped, not inherited: ffmpeg narrates every filter graph it builds, and
    // that narration would bury the PASS/FAIL lines this script exists to print.
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const avgs = [...output.matchAll(/lavfi\.signalstats\.(Y|U|V)AVG=([\d.]+)/g)].map((m) =>
    Number(m[2]),
  );
  if (avgs.length === 0) throw new Error(`Could not read a difference from ffmpeg:\n${output.slice(0, 400)}`);

  const dimensions = probe(a, 'stream=width,height');
  return {
    meanAbs: avgs.reduce((sum, v) => sum + v, 0) / avgs.length,
    pixels: Number(dimensions['width']) * Number(dimensions['height']),
  };
}

async function main(): Promise<number> {
  console.log('M8 verification');
  console.log(`  target ${BASE}\n`);

  try {
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
  } catch {
    console.error(
      `ffprobe is not on PATH. M8's output can only be checked by decoding it, so this\n` +
        `verification cannot run without it. Install ffmpeg (SPEC §15).`,
    );
    return 1;
  }

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log('');
  if (failed.length > 0) {
    console.log(`${failed.length} of ${checks.length} checks failed. M8 is not done.`);
    return 1;
  }
  console.log(`All ${checks.length} checks pass. Files in ${dir}, screenshots in ${SHOTS}.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\nVerification could not run: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
