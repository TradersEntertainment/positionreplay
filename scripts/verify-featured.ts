/**
 * The front door works for someone who arrived knowing nobody.
 *
 *   pnpm verify:featured
 *
 * Every other entry point starts from something you must already have — an address, a
 * market and a memory, or a CSV file. This one does not, which makes it the only part of
 * the landing page a first-time visitor can actually use, and the only one worth checking
 * in a real browser rather than a unit test.
 *
 * Assumes a server is already up (see PLAYER_URL). Runs entirely offline against
 * TRADE_REPLAY_FIXTURE=synthetic — note that the Hyperliquid fixture routes on the
 * request's `type` and never on `user`, so any address returns the synthetic account's
 * fills. That is what makes the click-through testable with no network, and it is also
 * why this script proves nothing about whether the real featured addresses have history.
 */

import { writeFileSync } from 'node:fs';
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

async function waitForCards(page: Page): Promise<void> {
  // The panel fetches after mount and reconstructs whole accounts, so this is a real
  // wait, not a formality.
  await page.waitForSelector('[data-testid="featured-card"]', { timeout: 120_000 });
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

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await waitForCards(page);

  const cards = page.getByTestId('featured-card');
  const count = await cards.count();
  record('the front page offers traders with no address typed', count > 0, `${count} card(s)`);

  // The click-through contract: every card must carry an address the address page will
  // normalise to the same string, or the link lands somewhere else.
  const addresses = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-address') ?? ''),
  );
  record(
    'every card carries a lowercase 0x address',
    addresses.length > 0 && addresses.every((address) => /^0x[0-9a-f]{40}$/.test(address)),
    addresses.join(', ') || 'none',
  );

  // A card without numbers is a card that should not have rendered: the API omits a
  // trader it could not summarise rather than sending zeroes.
  const stats = await cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      net: node.getAttribute('data-net'),
      positions: node.getAttribute('data-positions'),
      text: node.textContent ?? '',
    })),
  );
  record(
    'each card states positions and a net, both real numbers',
    stats.every(
      (stat) =>
        stat.net !== null &&
        stat.positions !== null &&
        Number.isFinite(Number(stat.net)) &&
        Number(stat.positions) > 0,
    ),
    stats.map((s) => `${s.positions} pos / ${s.net}`).join(' · '),
  );

  record(
    'the numbers are labelled as ours, not the venue\u2019s',
    (await page.getByText(/own reconstruction of their positions/i).count()) > 0,
    'the panel says whose figures these are',
  );

  // Presence is not enough — it has to be read before the address box, which is the
  // whole point of moving it to the top.
  const panelBox = await page.getByTestId('featured-panel').boundingBox();
  const formBox = await page.getByTestId('address-input').boundingBox();
  record(
    'the panel sits above the address form',
    panelBox !== null && formBox !== null && panelBox.y < formBox.y,
    `panel y=${panelBox?.y ?? '?'} form y=${formBox?.y ?? '?'}`,
  );

  // --- the click-through actually lands somewhere with positions ---
  const first = addresses[0] ?? '';
  await cards.first().click();
  await page.waitForURL(new RegExp(`/a/hyperliquid/${first}`), { timeout: 120_000 });
  await page.waitForSelector('[data-testid="episode-table"], [data-testid="notices"]', {
    timeout: 120_000,
  });
  const rows = await page.getByTestId('episode-row').count();
  record('clicking a card reaches that trader’s positions', rows > 0, `${rows} position(s) listed`);
  writeFileSync(join(SHOTS, 'featured-02-positions.png'), await page.screenshot());

  // --- the address form still works, since it moved ---
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('address-input').fill(first);
  await page.getByTestId('address-submit').click();
  await page.waitForURL(/\/a\/hyperliquid\//, { timeout: 120_000 });
  record('the address form still routes after moving down the page', true, page.url());

  // --- mobile: the page must not scroll sideways ---
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await waitForCards(phone);
  const overflow = await phone.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    inner: window.innerWidth,
  }));
  record(
    'the front page does not scroll sideways on a phone',
    overflow.scroll <= overflow.inner + 1,
    `scrollWidth ${overflow.scroll} vs innerWidth ${overflow.inner}`,
  );
  writeFileSync(join(SHOTS, 'featured-03-phone.png'), await phone.screenshot({ fullPage: true }));
  await phone.close();

  record('no console errors', errors.length === 0, errors.length === 0 ? 'clean' : errors.join('\n        '));
  await page.close();
}

async function main(): Promise<number> {
  console.log('\nFeatured traders verification');
  console.log(`  target ${BASE}\n`);

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await run(browser);
  } catch (error) {
    console.error(`\nVerification could not run: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await browser.close();
  }

  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${checks.length} checks failed.`);
    return 1;
  }
  console.log(`\nAll ${checks.length} checks pass. Screenshots in ${SHOTS}.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
