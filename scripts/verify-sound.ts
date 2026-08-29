/**
 * Acceptance check for the venue header and the replay's audio.
 *
 *   pnpm verify:sound
 *
 * Neither of these is a SPEC milestone, so they get their own script rather than being
 * bolted onto verify:m3 or m5. What they share is that both are easy to *look* correct
 * and hard to be correct: a header can advertise a venue the app cannot actually load,
 * and an export can claim an audio codec while carrying a silent or absent track. Both
 * failures are invisible until someone else hits them.
 *
 * Assumes a server is already up (see PLAYER_URL).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env['PLAYER_URL'] ?? 'http://127.0.0.1:3100';
const ADDRESS = process.env['VERIFY_ADDRESS'] ?? '0x393d0b87ed38fc779fd9611144ae649ba6082109';
const SHOTS = process.env['VERIFY_SHOT_DIR'] ?? '.';
const CHROME = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const checks: { name: string; passed: boolean; detail: string }[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
}

function ffprobe(path: string, ...args: string[]): string {
  return execFileSync('ffprobe', ['-v', 'error', ...args, path], { encoding: 'utf8' }).trim();
}

async function openPlayer(page: Page): Promise<void> {
  await page.goto(`${BASE}/a/hyperliquid/${ADDRESS}`, { waitUntil: 'networkidle' });
  await page.getByTestId('episode-link').first().click();
  await page.waitForSelector('[data-testid="export-panel"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });
}

async function run(browser: Browser): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // --- the venue header ---
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="venue-bar"]');
  writeShot(await page.screenshot(), 'sound-01-home.png');

  const chips = await page.locator('[data-testid^="venue-chip-"]').all();
  const states = new Map<string, string>();
  for (const chip of chips) {
    const id = (await chip.getAttribute('data-testid')) ?? '';
    states.set(id.replace('venue-chip-', ''), (await chip.getAttribute('data-venue-state')) ?? '');
  }

  record(
    'every venue we name is in the header',
    ['hyperliquid', 'polymarket-perps', 'lighter', 'aster', 'csv'].every((v) => states.has(v)),
    [...states].map(([k, v]) => `${k}=${v}`).join(' '),
  );

  // The point of deriving the state from the adapter registry: the header cannot
  // advertise something that then fails when it is clicked.
  record(
    'a venue is shown as live only if it has an adapter',
    states.get('hyperliquid') === 'live' &&
      states.get('polymarket-perps') === 'live' &&
      states.get('csv') === 'live' &&
      states.get('lighter') === 'planned' &&
      states.get('aster') === 'planned',
    'lighter and aster are marked planned, the three built venues are live',
  );

  const soonCount = await page.getByText('SOON', { exact: true }).count();
  record(
    'the unbuilt venues say so in words, not only in colour',
    soonCount === 2,
    `${soonCount} chips carry a SOON label`,
  );

  // A live chip has to actually route somewhere. Clicking Perps must land on the form
  // with Perps selected, not 404 and not silently do nothing.
  await page.getByTestId('venue-chip-polymarket-perps').click();
  // A next/link click is a client-side navigation, so there is no load event to wait
  // for — `networkidle` resolves immediately and reads the previous page's select.
  await page.waitForURL(/venue=polymarket-perps/, { timeout: 15_000 });
  await page
    .waitForFunction(
      () =>
        document.querySelector<HTMLSelectElement>('[data-testid="venue-select"]')?.value ===
        'polymarket-perps',
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  const selected = await page.getByTestId('venue-select').inputValue();
  record('a live chip selects that venue on the form', selected === 'polymarket-perps', `venue-select = ${selected}`);

  // --- the player's sound ---
  await openPlayer(page);
  writeShot(await page.screenshot(), 'sound-02-player.png');

  const muteLabel = ((await page.getByTestId('mute-toggle').textContent()) ?? '').trim();
  record('the player has a sound control', muteLabel.length > 0, `"${muteLabel}"`);

  // Muting must survive a reload. Being asked to mute twice is the thing that makes a
  // page with audio unbearable.
  await page.getByTestId('mute-toggle').click();
  const mutedLabel = ((await page.getByTestId('mute-toggle').textContent()) ?? '').trim();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="mute-toggle"]');
  const afterReload = ((await page.getByTestId('mute-toggle').textContent()) ?? '').trim();
  record(
    'the mute choice is remembered across a reload',
    /off/i.test(mutedLabel) && afterReload === mutedLabel,
    `clicked -> "${mutedLabel}", after reload "${afterReload}"`,
  );

  // Back on, so the export below records something.
  await page.getByTestId('mute-toggle').click();
  record(
    'sound can be turned back on',
    /on/i.test(((await page.getByTestId('mute-toggle').textContent()) ?? '').trim()),
    'toggled back',
  );

  // --- the exported clip carries the audio ---
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });

  const wait = page.waitForEvent('download', { timeout: 240_000 });
  await page.getByTestId('export-video').click();
  const download = await wait;
  const path = join(SHOTS, 'sound-export.webm');
  await download.saveAs(path);
  const bytes = readFileSync(path);

  const streams = ffprobe(path, '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0');
  record(
    'the exported video has an audio stream',
    /audio/.test(streams),
    `${bytes.length} bytes — ${streams.replace(/\n/g, ' | ')}`,
  );

  // A track that exists and is silent would pass the check above and fail the only test
  // that matters, so measure the actual level. volumedetect reports -91dB for digital
  // silence; anything a listener would call audible is far above that.
  // volumedetect writes its summary to stderr, like every other ffmpeg filter report.
  // Reading stdout here returned an empty string and looked exactly like silence.
  const probe = spawnSync(
    'ffmpeg',
    ['-v', 'info', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr ?? '')?.[1];
  record(
    'the audio is not silence',
    peak !== undefined && Number(peak) > -40,
    peak === undefined ? 'ffmpeg reported no level' : `peak ${peak} dB`,
  );

  record('no console errors', errors.length === 0, errors.length === 0 ? 'clean' : errors.join('\n        '));

  await page.close();
}

function writeShot(buffer: Buffer, name: string): void {
  writeFileSync(join(SHOTS, name), buffer);
}

/**
 * The player, in a browser with no autoplay override.
 *
 * This is the run that matters, and its absence is why a silent player shipped. The
 * other browser below is launched with `--autoplay-policy=no-user-gesture-required`,
 * which starts every AudioContext already `running` — suppressing exactly the mechanism
 * that was failing. Its checks (an Opus track in the exported file) were true and
 * irrelevant: the export drives its own graph and can carry audio while the live player
 * is mute.
 *
 * So this one presses Play like a person does and asks the page itself what happened.
 */
async function runRealBrowser(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await openPlayer(page);

  const before = await audioProbe(page);
  record(
    'the audio graph exists before anything is pressed',
    before !== null,
    before === null ? 'no graph' : `state ${before.state}, ${before.strikes} strikes`,
  );

  // A real click, which is the gesture browsers require.
  await page.getByTestId('play-toggle').click();

  // The context resumes asynchronously; a person would wait about this long too.
  await page
    .waitForFunction(
      () =>
        (window as unknown as { __replayAudio?: () => { state: string } })
          .__replayAudio?.().state === 'running',
      undefined,
      { timeout: 8_000 },
    )
    .catch(() => undefined);

  const running = await audioProbe(page);
  record(
    'pressing Play actually starts the audio context',
    running?.state === 'running',
    `state ${running?.state ?? 'unknown'}`,
  );

  // Let the replay play far enough to cross several notes.
  await page.waitForTimeout(2500);
  const played = await audioProbe(page);
  record(
    'the player itself strikes notes, not just the exporter',
    (played?.strikes ?? 0) > 3,
    `${played?.strikes ?? 0} notes struck`,
  );

  record(
    'nothing claims audio is blocked when it is not',
    (await page.getByTestId('audio-blocked').count()) === 0,
    'no blocked notice while running',
  );

  // Muting has to actually stop it, not just relabel the button.
  //
  // The count is read *after* the click, not before: the render loop keeps striking
  // while Playwright moves the mouse and dispatches, so a before/after comparison
  // straddling the click measures the gap rather than the mute. The invariant is that
  // the count stops growing once muted.
  await page.getByTestId('mute-toggle').click();
  await page.waitForTimeout(300);
  const atMute = (await audioProbe(page))?.strikes ?? 0;
  await page.waitForTimeout(1500);
  const afterMute = (await audioProbe(page))?.strikes ?? 0;
  record(
    'muting stops the notes',
    afterMute === atMute,
    `${atMute} at mute, ${afterMute} a second and a half later`,
  );

  await page.close();
}

/** What the live graph reports, or null when the player has not mounted one. */
async function audioProbe(page: Page): Promise<{ state: string; strikes: number } | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __replayAudio?: () => { state: string; strikes: number } })
        .__replayAudio?.() ?? null,
  );
}

async function main(): Promise<number> {
  console.log('Venue header and replay audio');
  console.log(`  target ${BASE}\n`);

  // No flags: this is a browser behaving like the user's.
  const real = await chromium.launch({ executablePath: CHROME });
  try {
    await runRealBrowser(real);
  } finally {
    await real.close();
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    // Chromium in a container has no audio device, and without this the whole audio
    // graph is a no-op — the export would come out silent for reasons that have nothing
    // to do with the code under test.
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream'],
  });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log('');
  if (failed.length > 0) {
    console.log(`${failed.length} of ${checks.length} checks failed.`);
    return 1;
  }
  console.log(`All ${checks.length} checks pass. Files written to ${SHOTS}.`);
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
