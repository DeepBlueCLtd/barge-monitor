import { expect, Page, test } from '@playwright/test';

const STARTUP_BUDGET_MS = 20_000; // NFR-09, as declared in src/config.ts
const SLOW_MS = 180_000; // for steps that are not the start-up budget
// Tests load the pre-built history the build provides: one week in CI (decision D-37).
const QUICK = 'demo/';

test.describe.configure({ mode: 'serial' });

async function open(page: Page, url = QUICK) {
  await page.goto(url);
  await expect(page.getByTestId('sim-now')).toBeVisible({ timeout: SLOW_MS });
  await expect(page.getByTestId('chart-temperature')).toBeVisible({ timeout: 60_000 });
}

/** Control-panel switches follow the backend's state, so click and wait for it. */
async function toggle(page: Page, name: string, on: boolean) {
  const box = page.getByLabel(`toggle ${name}`, { exact: true });
  if ((await box.isChecked()) !== on) await box.click();
  await expect(box).toBeChecked({ checked: on });
}

async function restartServerAndWait(page: Page) {
  // The client notices a new instance on its next request: it polls only while the clock runs (FR-63).
  if ((await page.getByTestId('play').innerText()).includes('Play')) await page.getByTestId('play').click();
  const before = await page.getByTestId('server-state').innerText();
  await page.getByTestId('restart-server').click();
  await expect(page.getByTestId('server-state')).not.toHaveText(before, { timeout: 30_000 });
  await expect(page.getByTestId('server-state')).toContainText('running', { timeout: 120_000 });
}

test('pre-built history loaded within the start-up budget, progress shown honestly (FR-16, FR-17, NFR-09)', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const t0 = Date.now();
  await page.goto('demo/'); // a seed with pre-built history (SRD §13)
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(page.getByTestId('flowchart')).toHaveCount(0); // no flowchart until pre-generation ends
  await expect(page.getByTestId('sim-now')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  const ms = Date.now() - t0;
  console.log(`start-up with pre-built history: ${ms} ms`);
  await expect(page.locator('footer')).toContainText('history pre-built');
  expect(ms).toBeLessThan(STARTUP_BUDGET_MS);
  await expect(page.getByTestId('chart-temperature')).toBeVisible({ timeout: 120_000 });
  const origin = new URL(page.url()).origin;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]); // NFR-08
});

test('starts off; paused means silent; play moves the clock and the messages; a message opens (AT-11, FR-50, FR-52)', async ({ page }) => {
  await open(page);
  const t1 = await page.getByTestId('sim-now').innerText();
  const n1 = await page.locator('footer').innerText();
  await page.waitForTimeout(3000);
  expect(await page.getByTestId('sim-now').innerText()).toBe(t1);
  expect(await page.locator('footer').innerText()).toBe(n1);
  await page.getByTestId('play').click();
  await page.waitForTimeout(4000);
  expect(await page.getByTestId('sim-now').innerText()).not.toBe(t1);
  await page.getByTestId('play').click(); // pause: icons freeze and stay clickable
  const icon = page.locator('.icon').first();
  await expect(icon).toBeVisible({ timeout: 10_000 });
  const letter = await icon.innerText();
  await icon.click({ force: true });
  await expect(page.getByRole('dialog', { name: 'Message' })).toContainText(letter);
});

test('the contract suite passes in the browser, through the relay (AT-02)', async ({ page }) => {
  await open(page);
  const btn = page.getByRole('button', { name: 'Contract suite' });
  await expect(btn).toBeEnabled({ timeout: 120_000 });
  await btn.click();
  const summary = page.getByTestId('contract-summary');
  await expect(summary).toContainText('failed', { timeout: 180_000 });
  const text = await summary.innerText();
  console.log(text);
  expect(text).toContain('0 failed');
  expect(text).toContain('0 skipped');
});

test('promoted products of every schema type appear after restart client with generic views (AT-08, FR-36, FR-37)', async ({ page }) => {
  await open(page);
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  for (const id of ['quantity', 'category', 'count', 'angular']) {
    await page.getByLabel('Example script').selectOption(id);
    await run.click();
    await expect(page.locator('.console')).toContainText('Restart the client', { timeout: 120_000 });
    await expect(run).toBeEnabled();
    await page.locator('.console').evaluate((el) => (el.innerHTML = ''));
  }
  await expect(page.getByTestId('field-air_temperature_smoothed')).toHaveCount(0); // not until the next handshake (FR-37)
  await page.getByTestId('restart-client').click();
  await expect(page.getByTestId('field-air_temperature_smoothed')).toHaveAttribute('data-view', 'line', { timeout: 60_000 });
  await expect(page.getByTestId('field-wind_class')).toHaveAttribute('data-view', 'band');
  await expect(page.getByTestId('field-suspect_readings')).toHaveAttribute('data-view', 'step');
  await expect(page.getByTestId('field-wind_direction_median')).toHaveAttribute('data-view', 'points');
});

test('a broken script leaves the server answering (AT-13)', async ({ page }) => {
  await open(page);
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await page.getByLabel('Example script').selectOption('broken');
  await run.click();
  await expect(page.locator('.console')).toContainText('deliberately broken', { timeout: 60_000 });
  expect(await page.evaluate(async () => (await fetch('api/')).status)).toBe(200);
});

test('switching off an essential source gives degraded mode at the next server start (AT-06, AT-14, FR-41)', async ({ page }) => {
  await open(page);
  await page.getByText('Fields the server publishes').click();
  await toggle(page, 'air_temperature', false);
  await expect(page.getByTestId('pending')).toBeVisible();
  await expect(page.getByTestId('chart-temperature')).toBeVisible(); // nothing changes until the server restarts
  await restartServerAndWait(page);
  const popup = page.getByRole('alertdialog', { name: 'Unavailable essential sources' });
  await expect(popup).toBeVisible({ timeout: 60_000 });
  const items = await page.getByTestId('degraded-list').locator('li').allInnerTexts();
  expect(items.map((t) => t.split(':')[0]).sort()).toEqual(['Bow air temperature', 'Derived values (dew point)', 'Stern air temperature']);
  await popup.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('unavailable-temperature')).toBeVisible();
  await expect(page.getByTestId('view-temperature')).toBeDisabled();
  await expect(page.getByTestId('view-temperature')).toHaveAttribute('title', /Bow air temperature: missing/);
  await expect(page.getByTestId('chart-wind')).toBeVisible(); // views whose sources are present work normally
  // An optional source removed: no warning.
  await toggle(page, 'air_temperature', true);
  await toggle(page, 'solar_irradiance', false);
  await restartServerAndWait(page);
  await expect(page.getByTestId('chart-temperature')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('field-solar_irradiance')).toHaveCount(0);
});

test('a server whose claim its discovery contradicts is rejected (AT-07)', async ({ page }) => {
  await open(page);
  await page.getByText('Fields the server publishes').click();
  await toggle(page, 'apparent_wind_speed', false);
  await page.getByTestId('profile-lie').click();
  await expect(page.getByTestId('profile-lie')).toBeChecked();
  await restartServerAndWait(page);
  await expect(page.getByTestId('rejected')).toContainText('claims the declared profile', { timeout: 60_000 });
});

test('restart server: waiting mode, a new instance, a fresh handshake (AT-09)', async ({ page }) => {
  await open(page);
  const inst = await page.getByTestId('server-state').innerText();
  await page.getByTestId('restart-server').click();
  await expect(page.getByTestId('server-state')).toContainText('waiting', { timeout: 10_000 });
  await expect(page.getByTestId('server-state')).toContainText('running', { timeout: 120_000 });
  expect(await page.getByTestId('server-state').innerText()).not.toBe(inst);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('handshake')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('chart-temperature')).toBeVisible({ timeout: 60_000 });
});

test('server down: network failures, unreachable banner with stale data, re-handshake when up (AT-15)', async ({ page }) => {
  await open(page);
  await page.getByTestId('play').click();
  await page.getByTestId('server-down').click();
  await expect(page.getByTestId('unreachable')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('chart-temperature')).toBeVisible(); // last data kept, marked stale
  expect(await page.evaluate(async () => { try { await fetch('api/'); return 'answered'; } catch { return 'network failure'; } })).toBe('network failure');
  await page.getByTestId('server-up').click();
  await expect(page.getByTestId('unreachable')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId('chart-temperature')).toBeVisible({ timeout: 60_000 });
});

test('analysis settings are commands; the server refuses an out-of-range value by naming the bound (FR-26, FR-60)', async ({ page }) => {
  await open(page);
  await page.getByLabel('clusters', { exact: true }).fill('99');
  await page.getByRole('button', { name: 'Send command' }).click();
  await expect(page.getByTestId('command-status')).toContainText('clusters=99', { timeout: 30_000 });
  await page.getByLabel('clusters', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Send command' }).click();
  await expect(page.getByTestId('command-status')).toContainText('COMPLETED', { timeout: 60_000 });
});

test('a browser with WebAssembly switched off is told why the demonstrator cannot start', async ({ page }) => {
  await page.addInitScript(() => { delete (globalThis as any).WebAssembly; });
  await page.goto(QUICK);
  await expect(page.locator('.startup .error')).toContainText('WebAssembly switched off', { timeout: 20_000 });
});
