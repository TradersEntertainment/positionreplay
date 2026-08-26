/**
 * M7 acceptance check.
 *
 *   pnpm verify:m7
 *
 * SPEC §12 M7: "CSV adapter — column mapping UI + Binance klines."
 *
 * The parsing and mapping rules are covered by 120 unit tests. What only a browser can
 * answer is whether the upload actually reaches a replay, and — the part that would be
 * easy to fake — whether the mapping step *changes the numbers*. A column mapper that
 * renders but does not affect the reconstruction would pass every other kind of check.
 *
 * Assumes a server is already up (see PLAYER_URL).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const HOUR = 3_600_000;
/** Inside the synthetic fixture's kline range, so the offline Binance replay covers it. */
const BASE_TS = Date.UTC(2026, 7, 20, 0, 0, 0);
const iso = (hours: number): string =>
  new Date(BASE_TS + hours * HOUR).toISOString().replace('.000Z', 'Z');

const dir = mkdtempSync(join(tmpdir(), 'trade-replay-m7-'));

/**
 * A trades file with the awkwardness of a real export: decorated header names, ISO
 * timestamps, "Open Long" instead of buy, fees with a currency symbol and a thousands
 * separator, and one row nothing can read.
 */
const TRADES = join(dir, 'my-fills.csv');
writeFileSync(
  TRADES,
  [
    'Filled At,Market,Order Side,Fill Price (USD),Quantity,Fee',
    `${iso(1)},BTC,Open Long,92500,0.4,$16.65`,
    `${iso(20)},BTC,Open Long,91200,0.2,$8.21`,
    // Quoted, because the fee itself contains the delimiter — which is exactly how a
    // real export writes a four-figure fee, and the case a naive split gets wrong.
    `${iso(40)},BTC,Close Long,96800,0.6,"$1,026.14"`,
    `${iso(46)},BTC,rebalance,96000,0.1,$4.32`,
  ].join('\n') + '\n',
);

/** A symbol Binance does not list, plus the OHLCV file SPEC §4.6 falls back to. */
const UNLISTED = join(dir, 'unlisted.csv');
writeFileSync(
  UNLISTED,
  [
    'Filled At,Market,Order Side,Fill Price (USD),Quantity',
    `${iso(2)},WIFHAT,Open Long,1.25,1000`,
    `${iso(30)},WIFHAT,Close Long,1.62,1000`,
  ].join('\n') + '\n',
);

const OHLCV = join(dir, 'wifhat-1h.csv');
writeFileSync(
  OHLCV,
  [
    'time,open,high,low,close,volume',
    ...Array.from({ length: 40 }, (_, i) => {
      const close = 1.2 + i * 0.012;
      return [
        BASE_TS + i * HOUR,
        (close - 0.01).toFixed(4),
        (close + 0.02).toFixed(4),
        (close - 0.03).toFixed(4),
        close.toFixed(4),
        '1000',
      ].join(',');
    }),
  ].join('\n') + '\n',
);

/** Upload a trades file and return the mapping page's document id. */
async function upload(page: Page, path: string): Promise<string> {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.setInputFiles('[data-testid="csv-input"]', path);
  await page.getByTestId('csv-submit').click();
  await page.waitForURL(/\/csv\//);
  return (await page.getByTestId('csv-id').textContent()) ?? '';
}

/** Net PnL of every row in the episode browser, from the attribute the table exposes. */
async function nets(page: Page): Promise<number[]> {
  return page.$$eval('[data-testid="episode-row"]', (rows) =>
    rows.map((r) => Number(r.getAttribute('data-net'))),
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
    // 404s are expected while probing a document that was deliberately not stored.
    if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  // --- SPEC §8: "wallet address, venue toggle …, or CSV drop zone" ---
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  record(
    'the landing page offers a CSV drop zone',
    (await page.getByTestId('csv-input').count()) === 1,
    'file input present',
  );

  const venueOptions = await page.$$eval('[data-testid="venue-select"] option', (nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).value),
  );
  record(
    'CSV is not offered as a typed-address venue',
    !venueOptions.includes('csv'),
    // A CSV has no account to type; putting it in the toggle would promise otherwise.
    `venue toggle: ${venueOptions.join(', ')}`,
  );
  writeFileSync(join(SHOTS, 'm7-01-landing.png'), await page.screenshot());

  // --- upload, and the mapping step SPEC §4.6 requires ---
  const withFees = await upload(page, TRADES);
  record(
    'uploading routes to the mapping step, not straight to a replay',
    /^[0-9a-f]{16}$/.test(withFees),
    `document ${withFees}`,
  );

  record(
    'the file is named back to the user',
    (await page.getByTestId('csv-filename').textContent()) === 'my-fills.csv',
    (await page.getByTestId('csv-filename').textContent()) ?? '',
  );

  const previewRows = await page.$$eval('[data-testid="csv-preview"] tr', (r) => r.length);
  record('the file is previewed before it is mapped', previewRows >= 4, `${previewRows} rows shown`);

  // Every required column found despite "Filled At" / "Fill Price (USD)" / "Quantity".
  const missing = await page.getByTestId('missing-fields').count();
  const guessed = await Promise.all(
    ['timestamp', 'symbol', 'side', 'price', 'size', 'fee'].map(async (f) =>
      page.getByTestId(`column-${f}`).inputValue(),
    ),
  );
  record(
    'decorated header names are mapped without a single click',
    missing === 0 && guessed.every((v) => v !== ''),
    `columns ${guessed.join(', ')}`,
  );

  record(
    'the sniffed timestamp format is ISO8601, not an epoch',
    (await page.getByTestId('timestamp-format').inputValue()) === 'iso8601',
    await page.getByTestId('timestamp-format').inputValue(),
  );

  record(
    'the unreadable row is counted before anything is committed to',
    (await page.getByTestId('rejected-rows').count()) === 1,
    ((await page.getByTestId('rejected-rows').textContent()) ?? '').trim(),
  );

  record(
    'the symbol step suggests a Binance symbol (SPEC §4.6: BTC -> BTCUSDT)',
    (await page.getByTestId('binance-BTC').inputValue()) === 'BTCUSDT',
    await page.getByTestId('binance-BTC').inputValue(),
  );
  writeFileSync(join(SHOTS, 'm7-02-mapping.png'), await page.screenshot());

  // --- the replay itself ---
  await page.getByTestId('symbols-submit').click();
  await page.waitForURL(/\/a\/csv\//);
  await page.waitForSelector('[data-testid="episode-table"]');

  const withFeesNets = await nets(page);
  record(
    'the upload reconstructs into an episode',
    withFeesNets.length === 1,
    `${withFeesNets.length} episode, net ${withFeesNets[0]?.toFixed(2)}`,
  );

  record(
    "the CSV limitation is stated where the numbers are, and it is CSV's own",
    (await page.getByTestId('venue-limitation').count()) === 1 &&
      /Binance/.test((await page.getByTestId('venue-limitation').textContent()) ?? ''),
    ((await page.getByTestId('venue-limitation').first().textContent()) ?? '').slice(0, 76).trim(),
  );
  writeFileSync(join(SHOTS, 'm7-03-browser.png'), await page.screenshot());

  // --- the mapping step is not decorative: unmapping fees must change the PnL ---
  await page.goto(`${BASE}/csv/${withFees}`, { waitUntil: 'networkidle' });
  await page.getByTestId('column-fee').selectOption('');
  await page.getByTestId('column-submit').click();
  await page.waitForURL(/\/csv\//);

  const withoutFees = (await page.getByTestId('csv-id').textContent()) ?? '';
  record(
    'a different mapping is a different document, so both links keep working',
    withoutFees !== '' && withoutFees !== withFees,
    `${withFees} -> ${withoutFees}`,
  );

  await page.getByTestId('symbols-submit').click();
  await page.waitForURL(/\/a\/csv\//);
  await page.waitForSelector('[data-testid="episode-table"]');
  const withoutFeesNets = await nets(page);

  // 16.65 + 8.21 + 1,026.14 — the last one also proves the thousands separator parsed.
  const feeDelta = (withoutFeesNets[0] ?? 0) - (withFeesNets[0] ?? 0);
  record(
    'unmapping the fee column changes the reconstruction by exactly the fees',
    Math.abs(feeDelta - 1051) < 0.005,
    `net moved by ${feeDelta.toFixed(2)}, expected 1051.00`,
  );

  // --- SPEC §4.6's fallback: a symbol Binance does not list ---
  await upload(page, UNLISTED);
  await page.setInputFiles('[data-testid="ohlcv-WIFHAT"]', OHLCV);
  await page.getByTestId('symbols-submit').click();
  await page.waitForURL(/\/a\/csv\//);
  await page.waitForSelector('[data-testid="episode-table"]');
  record(
    'an unlisted symbol replays from the user’s own OHLCV file',
    (await nets(page)).length === 1,
    `net ${(await nets(page))[0]?.toFixed(2)}`,
  );

  await page.getByTestId('episode-link').first().click();
  await page.waitForSelector('[data-testid="player"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="replay-canvas"]');
    return Boolean(canvas && canvas.width > 100);
  });
  const frameCount = Number(await page.getByTestId('player').getAttribute('data-frame-count'));
  record(
    'the OHLCV-backed position plays as a replay',
    frameCount > 20,
    `${frameCount} frames, no Binance request involved`,
  );
  writeFileSync(join(SHOTS, 'm7-04-ohlcv-replay.png'), await page.screenshot());

  // --- the other venues are untouched ---
  await page.goto(`${BASE}/a/hyperliquid/0x393d0b87ed38fc779fd9611144ae649ba6082109`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-testid="episode-table"]');
  record(
    'Hyperliquid still works and shows no limitation banner',
    (await page.getByTestId('episode-row').count()) >= 4 &&
      (await page.getByTestId('venue-limitation').count()) === 0,
    `${await page.getByTestId('episode-row').count()} episodes, no banner`,
  );

  record(
    'no console errors',
    errors.length === 0,
    errors.length === 0 ? 'clean' : errors.join('\n        '),
  );

  await page.close();
}

async function main(): Promise<number> {
  console.log('M7 verification');
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
    console.log(`${failed.length} of ${checks.length} checks failed. M7 is not done.`);
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
