import { expect, Page, test } from '@playwright/test';
import { contrast, contrastPairs } from '../src/shell/palette';

// End-to-end tests of the v4 architecture view (SRD §9, §14) against the
// assembled static site. They load the pre-calculated history the build provides.
const STARTUP_BUDGET_MS = 30_000; // NFR-10, as declared in src/config.ts
const SLOW_MS = 180_000;
const URL_PY = 'demo/?seed=1&backend=python'; // explicit: the stand-in is the default for now (D-80)

test.describe.configure({ mode: 'serial' });

async function open(page: Page, url = URL_PY) {
  await page.goto(url);
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW_MS });
}

async function play(page: Page) {
  if ((await page.getByTestId('play').innerText()).includes('Play')) await page.getByTestId('play').click();
  await expect(page.getByTestId('sim-state')).toHaveText('Playing');
}

async function pause(page: Page) {
  if ((await page.getByTestId('play').innerText()).includes('Pause')) await page.getByTestId('play').click();
  await expect(page.getByTestId('sim-state')).toHaveText('Paused');
}

/** The display client is configured once the core models are live and it has made its handshake. */
async function configured(page: Page) {
  await expect(page.getByTestId('client-state')).toHaveText(/Configured|Degraded/, { timeout: SLOW_MS });
}

/** Every sketched outline's path data, keyed by shape (AT-21). */
async function outlines(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-sketch]')).map(
    (e) => `${e.getAttribute('data-sketch')}:${Array.from(e.querySelectorAll('path')).map((p) => p.getAttribute('d')).join('|')}`).sort());
}

test('start-up: progress shown, then the flowchart; everything from the site itself (FR-15, NFR-10, AT-23)', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(URL_PY);
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  console.log(`flowchart after ${Date.now() - t0} ms`);
  await expect(page.getByTestId('backend-state')).toHaveText('Python');
  await expect(page.getByTestId('history-state')).not.toHaveText('none');
  for (const id of ['platform', 'store', 'adapter', 'server', 'models', 'fastapi', 'scilibs', 'client']) await expect(page.getByTestId(`card-${id}`)).toBeVisible();
  for (const l of 'QDOKPHSLI') await expect(page.getByTestId(`key-${l}`)).toBeVisible();
  await expect(page.locator('[data-flow]')).toHaveCount(13); // every flow of §3.1, one arrow per direction (FR-65)
  await expect(page.locator('.flow-label')).toHaveText('HTTP');
  const origin = new URL(page.url()).origin;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
  // No horizontal scroll at 1920×1080.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('nothing moves before Play or while paused; play moves clock and messages (AT-19, FR-77)', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('sim-state')).toHaveText('Paused');
  const t1 = await page.getByTestId('role-platform').innerText();
  await page.waitForTimeout(4000);
  expect(await page.getByTestId('role-platform').innerText()).toBe(t1);
  await expect(page.getByTestId('message-icon')).toHaveCount(0);
  await expect(page.getByTestId('client-state')).toHaveText('Waiting for play');
  await play(page);
  await expect(page.getByTestId('message-icon').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('role-platform')).not.toHaveText(t1);
  await pause(page);
  await page.waitForTimeout(800);
  // Paused: icons freeze in place and the clock stands still.
  const pos = () => page.getByTestId('message-icon').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform).join(';'));
  const t2 = await page.getByTestId('role-platform').innerText();
  const p1 = await pos();
  await page.waitForTimeout(3000);
  expect(await pos()).toBe(p1);
  expect(await page.getByTestId('role-platform').innerText()).toBe(t2);
});

test('value-add reveal: nothing gold at start; display client and Models reveal; nothing else can (AT-20, FR-74..FR-76)', async ({ page }) => {
  await open(page);
  await expect(page.locator('.card.gold')).toHaveCount(0);
  await expect(page.getByTestId('detail-empty')).toBeVisible();
  for (const id of ['platform', 'store', 'adapter', 'server', 'fastapi', 'scilibs']) {
    await page.getByTestId(`card-${id}`).click();
    await expect(page.getByTestId(`card-${id}`)).toHaveAttribute('data-revealed', 'false');
    await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', id);
  }
  await expect(page.locator('.card.gold')).toHaveCount(0);
  await page.getByTestId('card-client').click();
  await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'true');
  await expect(page.getByTestId('card-client')).toContainText('★ Display client');
  await expect(page.getByTestId('role-client')).toContainText('our value-add');
  await expect(page.getByTestId('card-client').getByTestId('diamond')).toBeVisible();
  await page.getByTestId('card-models').click();
  await expect(page.getByTestId('card-models')).toHaveAttribute('data-revealed', 'true');
  await expect(page.getByTestId('detail-models').getByTestId('diamond')).toHaveCount(6); // Models and five model cards
  // Stays revealed when another component is selected; the × returns the empty state (FR-69).
  await page.getByTestId('card-server').click();
  await expect(page.locator('.card.gold')).toHaveCount(2);
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail-empty')).toBeVisible();
  const before = await outlines(page);
  await page.getByTestId('restart-client').click();
  await expect(page.locator('.card.gold')).toHaveCount(0);
  expect(await outlines(page)).toEqual(before); // AT-21: identical sketched outlines after a client restart
});

test('display client: chips, period, clustering, views; the strip shows the selection\'s store query (FR-53..FR-61, FR-70, AT-17)', async ({ page }) => {
  await open(page);
  await page.getByTestId('card-client').click();
  await expect(page.getByTestId('dc-waiting')).toBeVisible();
  await play(page);
  await configured(page);
  const chips = page.getByTestId('chip');
  await expect(chips.first()).toBeVisible();
  await expect(page.locator('.chip.on')).toHaveCount(2); // default: the profile's raw essentials
  await expect(page.locator('.chip.optional').first()).toBeVisible();
  await expect(page.getByTestId('chart-line').locator('canvas')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('chart-errorbars').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('chart-heatmap').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('monitor').getByTestId('diamond')).toHaveCount(4); // three graphs and the cluster view (FR-76)
  await expect(page.getByTestId('cluster-score')).toContainText('score against ground truth', { timeout: 90_000 });
  // 1 h reads raw records: the strip shows the S that selection caused, found by its chain.
  const strip = page.getByTestId('message-strip');
  await expect(strip).toHaveAttribute('data-letter', 'S', { timeout: 30_000 });
  await expect(page.getByTestId('strip-chain')).toContainText('S to the store adapter');
  await expect(page.getByTestId('message-content')).toContainText('"op"');
  // A week reads hourly summaries: no store query, said honestly.
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByTestId('strip-no-s')).toBeVisible({ timeout: 30_000 });
  // No field selected: the views say so (FR-56).
  while (await page.locator('.chip.on').count()) await page.locator('.chip.on').first().click();
  await expect(page.getByTestId('view-line')).toContainText('No field selected');
  await expect(page.getByTestId('view-clusters')).toContainText('No field selected');
});

test('clicking a message shows it in the message strip (FR-68)', async ({ page }) => {
  await open(page);
  await play(page);
  await expect(page.getByTestId('message-icon').first()).toBeVisible({ timeout: 30_000 });
  await pause(page);
  const icon = page.getByTestId('message-icon').first();
  const letter = await icon.getAttribute('data-letter');
  await icon.dispatchEvent('click'); // icons queue and can overlap: click this one
  const strip = page.getByTestId('message-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-letter', letter!);
  await expect(page.getByTestId('strip-meta')).toContainText(/from .+ to /);
  await expect(page.getByTestId('message-content')).not.toBeEmpty();
  await expect(page.getByTestId('selected-icon')).toBeVisible();
});

test('every text and icon colour meets 4.5:1 (AT-22)', async () => {
  const failing = contrastPairs().filter((p) => contrast(p.fg, p.bg) < 4.5).map((p) => `${p.what}: ${contrast(p.fg, p.bg).toFixed(2)}`);
  expect(failing).toEqual([]);
});

test('stand-in: labelled, tagged, the notice shown, the editor unavailable (AT-25, FR-06f, FR-06h)', async ({ page }) => {
  await open(page, 'demo/?seed=1&backend=standin');
  await expect(page.getByTestId('backend-state')).toHaveText('JavaScript stand-in');
  await expect(page.getByTestId('standin-notice')).toContainText('Running the JavaScript stand-in');
  await expect(page.getByTestId('standin-tag')).toHaveCount(7); // every component behind the seam
  await expect(page.getByTestId('card-client').getByTestId('standin-tag')).toHaveCount(0);
  await page.getByTestId('card-models').click();
  await page.getByTestId('model-model-c').click();
  await expect(page.getByTestId('editor-unavailable')).toBeVisible();
  await play(page);
  await configured(page);
  await page.getByTestId('card-client').click();
  await expect(page.getByTestId('cluster-score')).toContainText('(illustrative)', { timeout: 90_000 });
});
