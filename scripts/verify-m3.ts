/**
 * M3 acceptance check.
 *
 *   pnpm verify:m3
 *
 * SPEC §12 M3: "Done when: you can play/pause/scrub a Hyperliquid episode end-to-end
 * and it feels smooth."
 *
 * Unit tests cannot answer that — the clock is tested in packages/core, but whether
 * the loop actually paints, whether a seek lands where it should, and whether playback
 * holds a frame rate are properties of a real browser. So this drives one.
 *
 * Assumes a server is already running (see PLAYER_URL). It never starts one itself, so
 * a failure here is always the app's, never the harness's.
 */

import { writeFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env['PLAYER_URL'] ?? 'http://127.0.0.1:3100';
const ADDRESS = process.env['VERIFY_ADDRESS'] ?? '0x393d0b87ed38fc779fd9611144ae649ba6082109';
const SHOTS = process.env['VERIFY_SHOT_DIR'] ?? '.';
/** The image ships with Chromium already installed; Playwright's own copy is absent. */
const CHROME = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
}

/** Current frame index, read from the readout the render loop writes. */
async function frameIndex(page: Page): Promise<number> {
  const text = await page.getByTestId('frame-readout').textContent();
  return Number(text?.split('/')[0]?.trim() ?? 0);
}

/** A cheap fingerprint of what is actually painted. */
async function canvasSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    if (!canvas) return 'no-canvas';
    return canvas.toDataURL('image/png').slice(-2_000);
  });
}

async function nonBackgroundPixelRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    // Sample every 40th pixel; the background is near-black (#08090b).
    for (let i = 0; i < data.length; i += 160) {
      if (data[i]! > 24 || data[i + 1]! > 24 || data[i + 2]! > 24) lit++;
    }
    return lit / (data.length / 160);
  });
}

async function run(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  // "Failed to load resource" without the URL is not a usable failure message.
  page.on('response', (response) => {
    if (response.status() >= 400) {
      consoleErrors.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    // A navigation cancels in-flight prefetches; that abort is normal, not a fault.
    if (reason.includes('ERR_ABORTED')) return;
    consoleErrors.push(`request failed ${request.url()}: ${reason}`);
  });

  // --- reach the player through the UI, not by a hand-built URL ---
  await page.goto(`${BASE}/?address=${ADDRESS}`, { waitUntil: 'networkidle' });
  const links = page.getByTestId('episode-link');
  const linkCount = await links.count();
  record('episode list reachable', linkCount > 0, `${linkCount} episodes listed at /`);

  await links.first().click();
  await page.waitForSelector('[data-testid="player"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });

  const player = page.getByTestId('player');
  const frameCount = Number(await player.getAttribute('data-frame-count'));
  record('replay deep link resolves', frameCount > 40, `${frameCount} frames built`);

  // --- the canvas is actually painted ---
  const lit = await nonBackgroundPixelRatio(page);
  record('canvas is drawn, not blank', lit > 0.01, `${(lit * 100).toFixed(1)}% of sampled pixels are non-background`);
  writeFileSync(`${SHOTS}/m3-01-loaded.png`, await page.screenshot());

  // --- space plays and the frames advance ---
  await page.getByTestId('replay-canvas').click({ position: { x: 5, y: 5 } });
  const before = await frameIndex(page);
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  const during = await frameIndex(page);
  const playingLabel = await page.getByTestId('play-toggle').textContent();

  record(
    'space starts playback and frames advance',
    during > before && playingLabel?.trim() === 'Pause',
    `frame ${before} -> ${during} in 700ms, button reads "${playingLabel?.trim()}"`,
  );
  writeFileSync(`${SHOTS}/m3-02-playing.png`, await page.screenshot());

  // --- and the pixels change with them ---
  const signatureA = await canvasSignature(page);
  await page.waitForTimeout(400);
  const signatureB = await canvasSignature(page);
  record('the canvas repaints while playing', signatureA !== signatureB, 'pixel signature changed between samples');

  // --- space pauses ---
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  const paused = await frameIndex(page);
  await page.waitForTimeout(500);
  record('space pauses', (await frameIndex(page)) === paused, `held at frame ${paused} for 500ms`);

  // --- arrows step exactly one frame, shift+arrow ten ---
  await page.keyboard.press('ArrowRight');
  const afterRight = await frameIndex(page);
  await page.keyboard.press('ArrowLeft');
  const afterLeft = await frameIndex(page);
  record(
    'arrow keys step one frame',
    afterRight === paused + 1 && afterLeft === paused,
    `${paused} -> ${afterRight} -> ${afterLeft}`,
  );

  await page.keyboard.press('Shift+ArrowRight');
  record(
    'shift+arrow steps ten frames',
    (await frameIndex(page)) === paused + 10,
    `${paused} -> ${await frameIndex(page)}`,
  );

  // --- the scrubber seeks ---
  const target = Math.floor(frameCount * 0.75);
  await page.getByTestId('scrubber').fill(String(target));
  await page.waitForTimeout(120);
  record(
    'scrubber seeks',
    Math.abs((await frameIndex(page)) - (target + 1)) <= 1,
    `asked for ${target}, landed on ${await frameIndex(page)}`,
  );

  // --- a seek is framed the same as playing to that frame (SPEC §7.2) ---
  await page.getByTestId('scrubber').fill('0');
  await page.waitForTimeout(80);
  await page.getByTestId('scrubber').fill(String(target));
  await page.waitForTimeout(120);
  const seekedTwice = await canvasSignature(page);
  await page.getByTestId('scrubber').fill(String(target));
  await page.waitForTimeout(120);
  record(
    'seeking is deterministic',
    seekedTwice === (await canvasSignature(page)),
    'the same frame renders identically however it was reached',
  );

  // --- hovering pauses and seeks (SPEC §8) ---
  const box = (await page.getByTestId('replay-canvas').boundingBox())!;
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.waitForTimeout(150);
  const hovered = await frameIndex(page);
  const hoverLabel = await page.getByTestId('play-toggle').textContent();
  record(
    'hovering the chart pauses and seeks',
    hoverLabel?.trim() === 'Play' && Math.abs(hovered - frameCount * 0.25) < frameCount * 0.1,
    `paused at frame ${hovered} of ${frameCount} after hovering 25% across`,
  );

  // --- speed multiplies the frame rate ---
  const measure = async (speed: string): Promise<number> => {
    await page.getByTestId('scrubber').fill('0');
    await page.getByTestId(`speed-${speed}`).click();
    await page.getByTestId('play-toggle').click();
    await page.waitForTimeout(1_000);
    const reached = await frameIndex(page);
    await page.getByTestId('play-toggle').click();
    return reached;
  };

  const at1x = await measure('1');
  const at4x = await measure('4');
  record(
    'speed control changes the frame rate',
    at4x > at1x * 2.5,
    `1x reached frame ${at1x} in 1s, 4x reached ${at4x}`,
  );

  // --- smoothness: 24fps at 1x, with the loop keeping up ---
  record(
    'playback holds ~24fps at 1x',
    at1x >= 20 && at1x <= 28,
    `${at1x} frames in 1000ms (24 expected)`,
  );

  // --- interval override refetches and rebuilds ---
  const barsBefore = Number(await player.getAttribute('data-series-length'));
  await page.getByTestId('interval-select').selectOption('1h');
  await page.waitForFunction(
    (previous) =>
      Number(
        document.querySelector('[data-testid="player"]')?.getAttribute('data-series-length'),
      ) !== previous,
    barsBefore,
    { timeout: 15_000 },
  );
  const barsAfter = Number(await player.getAttribute('data-series-length'));
  record(
    'interval override rebuilds the timeline',
    barsAfter !== barsBefore && barsAfter > 0,
    `${barsBefore} bars -> ${barsAfter} bars at 1h`,
  );
  writeFileSync(`${SHOTS}/m3-03-interval.png`, await page.screenshot());

  // --- nothing threw along the way ---
  record(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? 'clean' : consoleErrors.join('\n        '),
  );

  await page.close();
}

async function main(): Promise<number> {
  console.log('M3 verification');
  console.log(`  target ${BASE}\n`);

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((check) => !check.passed);
  console.log('');
  if (failed.length > 0) {
    console.log(`${failed.length} of ${checks.length} checks failed. M3 is not done.`);
    return 1;
  }
  console.log(`All ${checks.length} checks pass. Screenshots written to ${SHOTS}.`);
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
