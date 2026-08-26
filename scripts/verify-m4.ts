/**
 * M4 acceptance check.
 *
 *   pnpm verify:m4
 *
 * SPEC §12 M4: "`/a/[venue]/[address]` list view, caching layer, SQLite."
 *
 * Same shape as verify-m3: it drives the real browser rather than asserting from unit
 * tests, because sorting, sparklines and "did the cache actually help" are properties of
 * the running app. Assumes a server is already up (see PLAYER_URL) — a failure here is
 * always the app's, never the harness's.
 */

import { writeFileSync } from 'node:fs';
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

/** Read a numeric data attribute off every row, in the order they are rendered. */
async function column(page: Page, attribute: string): Promise<number[]> {
  return page.$$eval(`[data-testid="episode-row"]`, (rows, name) =>
    rows.map((row) => Number(row.getAttribute(name))), attribute);
}

function isDescending(values: number[]): boolean {
  return values.every((value, i) => i === 0 || values[i - 1]! >= value);
}

function isAscending(values: number[]): boolean {
  return values.every((value, i) => i === 0 || values[i - 1]! <= value);
}

async function run(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const reason = r.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) errors.push(`request failed ${r.url()}: ${reason}`);
  });

  // --- health (SPEC §15.1) ---
  const health = await page.request.get(`${BASE}/api/health`);
  const healthBody = (await health.json()) as { status: string; cache: string };
  record(
    'health reports the database is reachable',
    health.status() === 200 && healthBody.cache === 'ready',
    `${health.status()} ${JSON.stringify(healthBody)}`,
  );

  // --- the input routes to the SPEC §8 address route ---
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.getByTestId('address-input').fill(ADDRESS);
  await page.getByTestId('address-submit').click();
  await page.waitForURL(/\/a\/hyperliquid\//);
  record('the input routes to /a/[venue]/[address]', true, new URL(page.url()).pathname);

  await page.waitForSelector('[data-testid="episode-table"]');
  const rowCount = await page.getByTestId('episode-row').count();
  record('episode table renders', rowCount >= 4, `${rowCount} rows`);
  writeFileSync(`${SHOTS}/m4-01-browser.png`, await page.screenshot());

  // --- sparklines (SPEC §8: "Sparkline per row") ---
  const sparks = await page.getByTestId('sparkline').count();
  const points = await page.$$eval('[data-testid="sparkline"] polyline', (nodes) =>
    nodes.map((node) => (node.getAttribute('points') ?? '').split(' ').length),
  );
  record(
    'every row has a sparkline with real points',
    sparks === rowCount && points.length === rowCount && points.every((n) => n > 4),
    `${sparks} sparklines, ${Math.min(...points)}-${Math.max(...points)} points each`,
  );

  // --- sorting, in both directions, on every column SPEC names ---
  for (const [key, attribute] of [
    ['pnl', 'data-net'],
    ['duration', 'data-duration'],
    ['size', 'data-peak'],
    ['date', 'data-opened'],
  ] as const) {
    await page.getByTestId(`sort-${key}`).click();
    const descending = await column(page, attribute);
    await page.getByTestId(`sort-${key}`).click();
    const ascending = await column(page, attribute);

    record(
      `sorts by ${key}`,
      isDescending(descending) && isAscending(ascending) && descending.length === rowCount,
      `desc [${descending.join(', ')}] then asc [${ascending.join(', ')}]`,
    );
  }
  writeFileSync(`${SHOTS}/m4-02-sorted.png`, await page.screenshot());

  // --- sorting must not go back to the venue ---
  let requestsDuringSort = 0;
  const countRequests = (): void => {
    requestsDuringSort++;
  };
  page.on('request', countRequests);
  await page.getByTestId('sort-pnl').click();
  await page.waitForTimeout(400);
  page.off('request', countRequests);
  record(
    'sorting is client-side',
    requestsDuringSort === 0,
    `${requestsDuringSort} network requests while re-sorting`,
  );

  // --- a row opens its own replay ---
  const targetNet = (await column(page, 'data-net'))[0]!;
  await page.getByTestId('episode-link').first().click();
  await page.waitForSelector('[data-testid="player"]');
  const frameCount = Number(await page.getByTestId('player').getAttribute('data-frame-count'));
  record(
    'a row opens its own replay',
    /\/r\//.test(page.url()) && frameCount > 40,
    `net ${targetNet} -> ${frameCount} frames at ${new URL(page.url()).pathname.slice(0, 28)}…`,
  );

  // --- the cache earns its keep ---
  const time = async (url: string): Promise<number> => {
    const started = Date.now();
    const response = await page.request.get(url);
    await response.body();
    return Date.now() - started;
  };
  const target = `${BASE}/a/hyperliquid/${ADDRESS}`;
  await time(target); // ensure warm
  const warm = Math.min(await time(target), await time(target), await time(target));
  record('a cached address load is fast', warm < 1_000, `${warm}ms warm`);

  record('no console errors', errors.length === 0, errors.length === 0 ? 'clean' : errors.join('\n        '));

  await page.close();
}

async function main(): Promise<number> {
  console.log('M4 verification');
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
    console.log(`${failed.length} of ${checks.length} checks failed. M4 is not done.`);
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
