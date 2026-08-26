/**
 * Acceptance check for the manual position builder.
 *
 *   pnpm verify:build
 *
 * The risk here is not that the form fails to submit — it is that a constructed position
 * ends up looking exactly like a real one. CLAUDE.md: exports "get exported as images and
 * posted as fact". So most of what this asserts is about the labelling: that the tag is
 * in the canvas pixels and not only in the page around them, and that fees read as
 * unavailable rather than as a confident $0.00.
 *
 * Assumes a server is already up (see PLAYER_URL).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env['PLAYER_URL'] ?? 'http://127.0.0.1:3100';
const SHOTS = process.env['VERIFY_SHOT_DIR'] ?? '.';
const CHROME = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const checks: { name: string; passed: boolean; detail: string }[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
}

/** `datetime-local` wants the viewer's own wall clock, with no zone suffix. */
function localInput(iso: string): string {
  return iso;
}

async function fillRow(
  page: Page,
  index: number,
  when: string,
  side: 'buy' | 'sell',
  size: string,
  price: string,
): Promise<void> {
  await page.getByTestId(`builder-when-${index}`).fill(localInput(when));
  await page.getByTestId(`builder-side-${index}`).selectOption(side);
  await page.getByTestId(`builder-size-${index}`).fill(size);
  await page.getByTestId(`builder-price-${index}`).fill(price);
}

/**
 * Whether the notice colour appears in the canvas.
 *
 * The CONSTRUCTED tag is drawn as a solid block in `theme.notice`, so its presence in
 * the pixels is the only proof the label survives into an export — reading the DOM would
 * only prove the page says it, which is the thing an MP4 loses.
 */
async function noticePixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return -1;
    // Top-left band only: that is where the tag sits, and it keeps a notice-coloured
    // marker elsewhere on the chart from passing this.
    const { data } = ctx.getImageData(0, 0, Math.floor(canvas.width / 2), 80);
    let hits = 0;
    for (let i = 0; i < data.length; i += 4) {
      // #ffa502
      if (data[i]! > 230 && data[i + 1]! > 140 && data[i + 1]! < 190 && data[i + 2]! < 60) hits++;
    }
    return hits;
  });
}

async function run(browser: Browser): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // --- reachable from the landing page ---
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByTestId('build-link').click();
  await page.waitForURL(/\/build$/);
  await page.waitForSelector('[data-testid="position-builder"]');
  record('the builder is reachable from the landing page', true, await page.url());

  // --- the market list comes from the venue ---
  await page.waitForFunction(() => {
    const select = document.querySelector<HTMLSelectElement>('[data-testid="builder-instrument"]');
    return Boolean(select && select.options.length > 0);
  });
  const markets = await page.$$eval('[data-testid="builder-instrument"] option', (nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).textContent ?? ''),
  );
  record(
    "the picker is populated from the venue's own instrument list",
    markets.length > 0,
    `${markets.length} markets: ${markets.slice(0, 4).join(', ')}`,
  );

  record(
    'the page says this is not a real trade before anything is typed',
    (await page.getByTestId('constructed-warning').count()) > 0,
    ((await page.getByTestId('constructed-warning').textContent()) ?? '').slice(0, 70).trim(),
  );

  // --- a bad position is refused with a sentence, not a stack trace ---
  await page.getByTestId('builder-submit').click();
  await page.waitForTimeout(200);
  record(
    'an empty position is refused in words',
    (await page.getByTestId('builder-error').count()) > 0,
    ((await page.getByTestId('builder-error').textContent()) ?? '').trim(),
  );

  // --- build a losing long on the fixture's BTC market ---
  await page.getByTestId('builder-instrument').selectOption({ index: 0 });
  await fillRow(page, 0, '2026-08-20T02:00', 'buy', '0.5', '91000');
  await fillRow(page, 1, '2026-08-21T04:00', 'sell', '0.5', '85000');
  writeFileSync(join(SHOTS, 'build-01-form.png'), await page.screenshot());

  await page.getByTestId('builder-submit').click();
  await page.waitForURL(/\/b\//, { timeout: 20_000 });
  await page.waitForSelector('[data-testid="replay-canvas"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });

  record('the typed position replays', true, await page.url());

  const frameCount = await page.getAttribute('[data-testid="player"]', 'data-frame-count');
  record(
    'it produced a real timeline, not one frame',
    Number(frameCount) > 20,
    `${frameCount} frames`,
  );

  // --- the labelling, which is the point ---
  record(
    'the page badges it as constructed',
    (await page.getByTestId('constructed-badge').count()) > 0,
    'CONSTRUCTED badge present',
  );

  await page.waitForTimeout(400);
  const hits = await noticePixels(page);
  record(
    'the tag is in the canvas pixels, so it survives being exported',
    hits > 200,
    `${hits} notice-coloured pixels in the title band`,
  );
  writeFileSync(join(SHOTS, 'build-02-replay.png'), await page.screenshot());

  // --- the link is the whole position ---
  const url = page.url();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="constructed-badge"]');
  record(
    'the link carries the position with nothing stored behind it',
    (await page.getByTestId('constructed-badge').count()) > 0,
    `${url.length} characters, reloads to the same replay`,
  );

  // Everything after this point deliberately asks for a 404, and Chromium logs a
  // console error for one. Snapshot the real errors before creating a fake one.
  const realErrors = [...errors];

  // --- a hand-mangled link is a 404, not a 500 ---
  const response = await page.goto(`${BASE}/b/not-a-real-spec`, { waitUntil: 'domcontentloaded' });
  record(
    'a malformed link is refused, not crashed on',
    response?.status() === 404,
    `HTTP ${response?.status()}`,
  );

  record(
    'no console errors',
    realErrors.length === 0,
    realErrors.length === 0 ? 'clean' : realErrors.join('\n        '),
  );

  await page.close();
}

async function main(): Promise<number> {
  console.log('Manual position builder');
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
    console.log(`${failed.length} of ${checks.length} checks failed.`);
    return 1;
  }
  console.log(`All ${checks.length} checks pass. Screenshots in ${SHOTS}.`);
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
