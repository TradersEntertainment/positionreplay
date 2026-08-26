/**
 * M5 acceptance check.
 *
 *   pnpm verify:m5
 *
 * SPEC §12 M5: "client-side export — MediaRecorder WebM + GIF."
 *
 * This downloads the actual files and inspects their bytes. A button that appears to
 * work and a file that decodes are different claims, and CLAUDE.md's rule about exports
 * being "posted as fact" makes the second one the milestone.
 *
 * Assumes a server is already up (see PLAYER_URL).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Download, type Page } from 'playwright';

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

async function saveDownload(download: Download, name: string): Promise<Buffer> {
  const path = join(SHOTS, name);
  await download.saveAs(path);
  return readFileSync(path);
}

/** GIF header: "GIF89a" then width and height as little-endian uint16. */
function gifHeader(bytes: Buffer): { signature: string; width: number; height: number } {
  return {
    signature: bytes.subarray(0, 6).toString('ascii'),
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
}

/**
 * Animation frames, counted by their Graphic Control Extension blocks (21 F9 04).
 *
 * "Valid GIF" and "animating GIF" are different claims. gif.js reuses the canvas it is
 * handed, so without `copy: true` every frame aliases the last one and the result is a
 * perfectly well-formed single-image file — which is exactly what this catches.
 */
function gifFrameCount(bytes: Buffer): number {
  const marker = Buffer.from([0x21, 0xf9, 0x04]);
  let count = 0;
  let at = bytes.indexOf(marker);
  while (at !== -1) {
    count++;
    at = bytes.indexOf(marker, at + marker.length);
  }
  return count;
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
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await openPlayer(page);
  record('export panel is on the player', true, await page.getByTestId('export-panel').isVisible() ? 'visible' : 'present');
  writeShot(await page.screenshot(), 'm5-01-panel.png');

  // --- the codec the browser actually picked ---
  const videoDisabled = await page.getByTestId('export-video').isDisabled();
  const codec = await page.getByTestId('export-video').getAttribute('title');
  record(
    'a supported codec was selected at runtime',
    !videoDisabled && Boolean(codec),
    codec ?? 'no codec — button disabled',
  );

  // --- MP4 is offered, and routed (SPEC §9: "which routes to Phase 2 when available") ---
  //
  // Until M8 this asserted the opposite: the button was disabled and labelled "not
  // built yet", because a WebM wearing an .mp4 name would be worse than admitting it.
  // Phase 2 exists now, so the honest assertion is that the button is live. Whether
  // the file it produces is really H.264 is verify:m8's job, not this one's.
  const mp4 = page.getByTestId('export-mp4');
  const mp4Disabled = await mp4.isDisabled();
  const mp4Label = ((await mp4.textContent()) ?? '').trim();
  record(
    'MP4 is offered and does not pretend to be made in the browser',
    !mp4Disabled && !/not built/i.test(mp4Label) && /Download MP4/i.test(mp4Label),
    `disabled=${mp4Disabled}, label="${mp4Label}"`,
  );

  // --- WebM: download it and read the container magic ---
  const videoWait = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByTestId('export-video').click();
  await page.waitForSelector('[data-testid="export-progress"]', { timeout: 20_000 });
  const videoDownload = await videoWait;
  const videoBytes = await saveDownload(videoDownload, 'm5-export.webm');

  // EBML magic: 1A 45 DF A3.
  const ebml = videoBytes.subarray(0, 4).toString('hex');
  record(
    'WebM download is a real EBML container',
    ebml === '1a45dfa3' && videoBytes.length > 10_000,
    `${videoDownload.suggestedFilename()} · ${videoBytes.length} bytes · magic ${ebml}`,
  );

  const videoStatus = await page.getByTestId('export-status').textContent();
  record('the panel reports the file it produced', Boolean(videoStatus), videoStatus ?? 'no status');

  // --- GIF: download it and read the header ---
  const gifWait = page.waitForEvent('download', { timeout: 240_000 });
  await page.getByTestId('export-gif').click();
  const gifDownload = await gifWait;
  const gifBytes = await saveDownload(gifDownload, 'm5-export.gif');
  const header = gifHeader(gifBytes);

  record(
    'GIF download is a real GIF89a',
    header.signature === 'GIF89a' && gifBytes.length > 10_000,
    `${gifDownload.suggestedFilename()} · ${gifBytes.length} bytes · ${header.signature}`,
  );
  record(
    'GIF is downsampled to 640px wide (SPEC §9)',
    header.width === 640,
    `${header.width}×${header.height}`,
  );

  const gifFrames = gifFrameCount(gifBytes);
  record(
    'the GIF actually animates',
    gifFrames > 20,
    `${gifFrames} animation frames — one would mean every frame aliased the same canvas`,
  );

  // --- the player still works afterwards ---
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(600);
  const readout = ((await page.getByTestId('frame-readout').textContent()) ?? '').trim();
  const advanced = Number(readout.split('/')[0]?.trim() ?? 0) > 1;
  await page.getByTestId('play-toggle').click();
  record('the player still plays after exporting', advanced, `readout "${readout}"`);

  // --- share button ---
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('share-button').click();
  await page.waitForTimeout(300);
  const shareLabel = ((await page.getByTestId('share-button').textContent()) ?? '').trim();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  record(
    'share copies an absolute deep link',
    /^https?:\/\/.+\/r\/.+/.test(clipboard),
    `"${shareLabel}" -> ${clipboard.slice(0, 60)}…`,
  );

  writeShot(await page.screenshot(), 'm5-02-after-export.png');
  record('no console errors', errors.length === 0, errors.length === 0 ? 'clean' : errors.join('\n        '));

  await page.close();
}

function writeShot(buffer: Buffer, name: string): void {
  writeFileSync(join(SHOTS, name), buffer);
}

async function main(): Promise<number> {
  console.log('M5 verification');
  console.log(`  target ${BASE}\n`);

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log('');
  if (failed.length > 0) {
    console.log(`${failed.length} of ${checks.length} checks failed. M5 is not done.`);
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
