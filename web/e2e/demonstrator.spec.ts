import { expect, test } from '@playwright/test';

const STARTUP_BUDGET_MS = 60_000; // NFR-08, also declared in src/config.ts

test.describe.configure({ mode: 'serial' });

test('starts within budget, shows progress honestly, then live data (FR-36, NFR-08)', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const t0 = Date.now();
  await page.goto('demo/?seed=5');
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(page.locator('.chart')).toHaveCount(0); // no empty chart while loading
  await expect(page.getByTestId('sim-now')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  const startup = Date.now() - t0;
  console.log(`startup ${startup} ms`);
  expect(startup).toBeLessThan(STARTUP_BUDGET_MS);
  await expect(page.locator('.chart')).toHaveCount(7, { timeout: 30_000 });
  // NFR-06: every request is same-origin.
  const origin = new URL(page.url()).origin;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
});

test('the clock accelerates, and the contract suite passes through the Service Worker (AT-02)', async ({ page }) => {
  await page.goto('demo/?seed=6');
  await expect(page.getByTestId('sim-now')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  const before = Date.parse((await page.getByTestId('sim-now').textContent())!.replace(' UTC', 'Z').replace(' ', 'T'));
  await page.getByRole('button', { name: '600×' }).click();
  await page.waitForTimeout(5000);
  const after = Date.parse((await page.getByTestId('sim-now').textContent())!.replace(' UTC', 'Z').replace(' ', 'T'));
  expect(after - before).toBeGreaterThan(1000 * 1000); // well over 1000 simulated seconds in ~5 s
  await page.getByRole('tab', { name: 'Seam' }).click();
  await page.getByRole('button', { name: /contract suite/ }).click();
  const summary = page.getByTestId('contract-summary');
  await expect(summary).toBeVisible({ timeout: 180_000 });
  const text = (await summary.textContent())!;
  console.log(`contract suite in the browser: ${text}`);
  expect(text).toContain('0 failed');
  expect(Number(text.match(/(\d+) passed/)![1])).toBeGreaterThanOrEqual(13);
  await page.getByRole('button', { name: /Drop the index/ }).click();
  await expect(page.getByTestId('index-result')).toContainText('Identical', { timeout: 60_000 });
});

test('a workspace edit changes the display without reload; a broken script leaves the EDR server answering (AT-08)', async ({ page }) => {
  await page.goto('demo/?seed=7');
  await expect(page.getByTestId('sim-now')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  await page.getByRole('tab', { name: 'Workspace' }).click();
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  const editor = page.getByLabel('Python script');
  await run.click();
  await expect(page.locator('.promoted .coverage h3')).toHaveText(['smoothed-air-temperature'], { timeout: 60_000 });
  await expect(page.locator('.promoted')).toContainText('air_temperature_mean_300s');
  // Edit the script: a different window. The display follows, with no reload.
  const navs: string[] = [];
  page.on('framenavigated', (f) => navs.push(f.url()));
  await editor.fill((await editor.inputValue()).replace('WINDOW = 300', 'WINDOW = 900'));
  await run.click();
  await expect(page.locator('.promoted')).toContainText('air_temperature_mean_900s', { timeout: 60_000 });
  expect(navs).toEqual([]);
  // A deliberately broken script.
  await page.getByLabel('Example script').selectOption('broken');
  await run.click();
  await expect(page.locator('.console')).toContainText('deliberately broken', { timeout: 60_000 });
  const r = await page.evaluate(async () => (await fetch('api/sim/clock')).status);
  expect(r).toBe(200);
  // A runaway script is stopped without touching the backend.
  await editor.fill('while True:\n    pass\n');
  await run.click();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.console')).toContainText('backend was not touched');
  expect(await page.evaluate(async () => (await fetch('api/conformance')).status)).toBe(200);
});

test('analysis outputs carry scores; out-of-range values are refused by name (FR-23, FR-26)', async ({ page }) => {
  await page.goto('demo/?seed=8');
  await expect(page.getByTestId('sim-now')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Reach offsets from revisits' })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.analysis')).toContainText('scores › true_wind › speed_rmse_ms');
  await page.locator('label', { hasText: 'clusters' }).first().locator('input[type=number]').fill('99');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await expect(page.getByRole('alert')).toContainText('maximum 8', { timeout: 60_000 });
});
