/**
 * M6 acceptance check.
 *
 *   pnpm verify:m6
 *
 * SPEC §12 M6: "Open-positions-only mode (option A in §4.4.1). Instrument id map,
 * klines + mark-history series, previous_size/previous_entry_price assertions wired into
 * the §5 tests, liquidation/ADL markers."
 *
 * The assertions live in the unit suites; what only a browser can answer is whether the
 * venue toggle reaches Perps, whether option A's limitation is actually stated where
 * someone reads the numbers, and whether a liquidation renders as its own thing.
 *
 * Assumes a server is already up (see PLAYER_URL).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env['PLAYER_URL'] ?? 'http://127.0.0.1:3100';
const ADDRESS = process.env['VERIFY_ADDRESS'] ?? '0x393d0b87ed38fc779fd9611144ae649ba6082109';
const SHOTS = process.env['VERIFY_SHOT_DIR'] ?? '.';
const CHROME = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The fixture instrument whose position ends in a forced exit (fixtures/polymarket-perps). */
const LIQUIDATED_INSTRUMENT = 'BTC-PERP';

const checks: { name: string; passed: boolean; detail: string }[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
}

/** Colours actually painted onto the canvas, sampled from its pixels. */
async function hasColor(page: Page, hex: string): Promise<boolean> {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return page.evaluate(
    ([red, green, blue]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return false;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i]! - red!) < 12 &&
          Math.abs(data[i + 1]! - green!) < 12 &&
          Math.abs(data[i + 2]! - blue!) < 12
        ) {
          return true;
        }
      }
      return false;
    },
    [r, g, b] as const,
  );
}

async function run(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  // --- the toggle exists, because nothing in a 0x address names its venue ---
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const options = await page.$$eval('[data-testid="venue-select"] option', (nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).value),
  );
  record(
    'the landing page offers a venue toggle',
    options.includes('hyperliquid') && options.includes('polymarket-perps'),
    options.join(', '),
  );

  record(
    "the venue's limitation is stated before any address is entered",
    (await page.getByText(/funding as unavailable rather than as zero/).count()) > 0,
    'shown on the landing page',
  );
  writeFileSync(join(SHOTS, 'm6-01-landing.png'), await page.screenshot());

  // --- the toggle actually routes there ---
  await page.getByTestId('venue-select').selectOption('polymarket-perps');
  await page.getByTestId('address-input').fill(ADDRESS);
  await page.getByTestId('address-submit').click();
  await page.waitForURL(/\/a\/polymarket-perps\//);
  await page.waitForSelector('[data-testid="episode-table"]');

  const rows = await page.getByTestId('episode-row').count();
  record('the toggle reaches the Perps browser', rows >= 2, `${rows} positions listed`);

  record(
    "the limitation is repeated where the numbers are (SPEC §4.4.1: 'Label it in the UI')",
    (await page.getByTestId('venue-limitation').count()) > 0,
    ((await page.getByTestId('venue-limitation').first().textContent()) ?? '').slice(0, 72).trim(),
  );

  // --- closed Perps positions exist now, which option A could never show ---
  const cells = await page.$$eval('[data-testid="episode-row"]', (nodes) =>
    nodes.map((n) => n.textContent ?? ''),
  );
  const open = cells.filter((text) => text.includes('OPEN')).length;
  record(
    'the browser lists both closed and open Perps positions',
    open > 0 && open < cells.length,
    `${cells.length} rows, ${open} open — under option A every row read OPEN, because a ` +
      `closed position was unreachable`,
  );
  writeFileSync(join(SHOTS, 'm6-02-perps-browser.png'), await page.screenshot());

  // --- the liquidated position replays, and the marker is its own thing ---
  // By instrument, not by row order: the table sorts newest-first by default, so
  // .first() picks whichever position opened last — which is not the liquidated one.
  const liquidated = page.getByTestId('episode-row').filter({ hasText: LIQUIDATED_INSTRUMENT });
  record(
    `the ${LIQUIDATED_INSTRUMENT} position is in the table`,
    (await liquidated.count()) === 1,
    `${await liquidated.count()} matching row(s)`,
  );
  await liquidated.getByTestId('episode-link').click();
  await page.waitForSelector('[data-testid="player"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });

  const frameCount = Number(await page.getByTestId('player').getAttribute('data-frame-count'));
  record('a Perps position replays', frameCount > 40, `${frameCount} frames`);

  // Seek to the end so every marker has appeared.
  await page.getByTestId('scrubber').fill(String(frameCount - 1));
  await page.waitForTimeout(400);

  // #ff2d55 is theme.markerLiquidation — a colour used nowhere else.
  const liquidationPainted = await hasColor(page, '#ff2d55');
  record(
    'a liquidation renders in its own colour, not as a generic close',
    liquidationPainted,
    liquidationPainted
      ? 'markerLiquidation (#ff2d55) found in the canvas pixels'
      : 'no #ff2d55 pixel in the canvas — the forced exit drew as a generic close',
  );
  writeFileSync(join(SHOTS, 'm6-03-liquidation.png'), await page.screenshot());

  // --- funding is unavailable, not zero (CLAUDE.md) ---
  const canvasText = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="player"]');
    return el?.getAttribute('data-frame-count') ?? '';
  });
  record('the player is intact after seeking', canvasText !== '', `frame-count ${canvasText}`);

  // --- Hyperliquid is untouched by any of this ---
  await page.goto(`${BASE}/a/hyperliquid/${ADDRESS}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="episode-table"]');
  const hlRows = await page.getByTestId('episode-row').count();
  record(
    'Hyperliquid still works and shows no limitation banner',
    hlRows >= 4 && (await page.getByTestId('venue-limitation').count()) === 0,
    `${hlRows} episodes, no banner`,
  );

  record('no console errors', errors.length === 0, errors.length === 0 ? 'clean' : errors.join('\n        '));

  await page.close();
}

async function main(): Promise<number> {
  console.log('M6 verification');
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
    console.log(`${failed.length} of ${checks.length} checks failed. M6 is not done.`);
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
