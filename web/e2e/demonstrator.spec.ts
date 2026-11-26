import { expect, Page, test } from '@playwright/test';
import { contrast, contrastPairs } from '../src/shell/palette';

// End-to-end tests of the v4 architecture view (SRD §9, §14) against the
// assembled static site. They load the pre-calculated history the build provides.
const STARTUP_BUDGET_MS = 30_000; // NFR-10, as declared in src/config.ts
const SLOW_MS = 180_000;
const URL_PY = 'demo/?seed=1&backend=python'; // explicit: the stand-in is the default (FR-06b)

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
  for (const id of ['platform', 'store', 'adapter', 'server', 'models', 'scilibs', 'client']) await expect(page.getByTestId(`card-${id}`)).toBeVisible();
  for (const l of 'QDOKPHSLI') await expect(page.getByTestId(`key-${l}`)).toBeVisible();
  await expect(page.locator('[data-flow]')).toHaveCount(11); // every flow of §3.1, one arrow per direction (FR-65)
  await expect(page.locator('.flow-label')).toHaveText(['HTTP', 'HTTP']); // the display client's and the models' requests
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

test('the handshake is drawn in its true order: each request leaves after the reply before it arrives (FR-42a)', async ({ page }) => {
  const sent: number[] = [];
  page.on('request', (r) => r.url().includes('/demo/api') && sent.push(Date.now()));
  await open(page, 'demo/?seed=1&backend=standin');
  await page.getByTestId('card-client').click();
  await play(page);
  await expect(page.getByTestId('handshake-step')).toContainText('Request 2', { timeout: 30_000 });
  // One handshake message at most is on the flowchart at any moment.
  let seen = 0;
  for (let i = 0; i < 60; i++) {
    const n = await page.locator('[data-testid="message-icon"][data-handshake]').count();
    expect(n).toBeLessThanOrEqual(1);
    seen += n;
    await page.waitForTimeout(100);
  }
  expect(seen).toBeGreaterThan(20);
  // Two hops of 0.3 simulated seconds at half speed: no request within a second of the one before.
  const gaps = sent.slice(1).map((t, i) => t - sent[i]);
  expect(gaps.length).toBeGreaterThan(2);
  expect(Math.min(...gaps)).toBeGreaterThan(1000);
  await configured(page);
});

test('value-add reveal: nothing gold at start; display client and Models reveal; nothing else can (AT-20, FR-74..FR-76)', async ({ page }) => {
  await open(page);
  await expect(page.locator('.card.gold')).toHaveCount(0);
  await expect(page.getByTestId('detail-empty')).toBeVisible();
  for (const id of ['platform', 'store', 'adapter', 'server', 'scilibs']) {
    await page.getByTestId(`card-${id}`).click();
    await expect(page.getByTestId(`card-${id}`)).toHaveAttribute('data-revealed', 'false');
    await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', id);
  }
  await expect(page.locator('.card.gold')).toHaveCount(0);
  await page.getByTestId('card-client').click();
  // Clicked, but not yet showing its views: not revealed until it is configured.
  await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'false');
  await expect(page.getByTestId('detail-title')).toHaveText('Display client');
  // Configured while another panel is open: still not revealed, so Models can be shown first.
  await page.getByTestId('card-models').click();
  await expect(page.getByTestId('card-models')).toHaveAttribute('data-revealed', 'true');
  await play(page);
  await configured(page);
  await expect(page.locator('.card.gold')).toHaveCount(1);
  await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'false');
  // Configured and its panel on screen: revealed.
  await page.getByTestId('card-client').click();
  await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'true');
  await expect(page.getByTestId('detail-title')).toHaveText('★ Display client');
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
  // 1 h reads raw records: in 4.7 they are Mission A's, imported into the server's own store, so the store
  // adapter is not on the path and the strip says no store query was made (D-286, D-293).
  const strip = page.getByTestId('message-strip');
  await expect(strip).toHaveAttribute('data-letter', 'none', { timeout: 30_000 });
  await expect(page.getByTestId('strip-no-s')).toContainText('No store query');
  // A week reads hourly summaries: no store query, said honestly.
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByTestId('strip-no-s')).toBeVisible({ timeout: 30_000 });
  // No field selected: the views say so (FR-56).
  while (await page.locator('.chip.on').count()) await page.locator('.chip.on').first().click();
  await expect(page.getByTestId('view-line')).toContainText('No field selected');
  await expect(page.getByTestId('view-clusters')).toContainText('No field selected');
});

test('display client: a view is moved by its header and resized from its corner; its chart follows', async ({ page }) => {
  await open(page, 'demo/?seed=1&backend=standin');
  await page.getByTestId('card-client').click();
  await play(page);
  await configured(page);
  const chart = page.getByTestId('chart-line');
  await expect(chart.locator('canvas')).toBeVisible({ timeout: 60_000 });
  const line = page.locator('[data-panel="line"]');
  const heat = page.locator('[data-panel="heatmap"]');
  const box = async (l: typeof line) => (await l.boundingBox())!;
  // Resize: drag the line plot's corner down and to the left; the panel and its chart shrink in width and grow in height.
  const before = await box(line);
  const chartBefore = await box(chart);
  const handle = await box(line.locator('.react-resizable-handle'));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - before.width / 3, handle.y + 110, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await box(line)).width).toBeLessThan(before.width - 40);
  await expect.poll(async () => (await box(line)).height).toBeGreaterThan(before.height + 60);
  await expect.poll(async () => (await box(chart)).height).toBeGreaterThan(chartBefore.height + 60);
  // Move: drag the heat map by its header to the left edge; it ends up left of where it began.
  const heatBefore = await box(heat);
  const header = await box(heat.locator('header'));
  await page.mouse.move(header.x + 40, header.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 40, header.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await box(heat)).x).toBeLessThan(heatBefore.x - 100);
  await expect(page.getByTestId('chart-heatmap').locator('canvas')).toBeVisible();
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
  // Picked while paused: at Play it travels on, and is deselected when it arrives.
  await play(page);
  await expect(page.getByTestId('selected-icon')).toHaveCount(0, { timeout: 20_000 });
});

test('every text and icon colour meets 4.5:1 (AT-22)', async () => {
  const failing = contrastPairs().filter((p) => contrast(p.fg, p.bg) < 4.5).map((p) => `${p.what}: ${contrast(p.fg, p.bg).toFixed(2)}`);
  expect(failing).toEqual([]);
});

test('stand-in: labelled, tagged, the notice shown, the editor unavailable (AT-25, FR-06f, FR-06h)', async ({ page }) => {
  await open(page, 'demo/?seed=1&backend=standin');
  await expect(page.getByTestId('backend-state')).toHaveText('JavaScript stand-in');
  await expect(page.getByTestId('standin-notice')).toContainText('Running the JavaScript stand-in');
  await expect(page.getByTestId('standin-tag')).toHaveCount(6); // every component behind the seam
  await expect(page.getByTestId('card-client').getByTestId('standin-tag')).toHaveCount(0);
  await page.getByTestId('card-models').click();
  await page.getByTestId('model-new-model-1').click();
  await expect(page.getByTestId('editor-unavailable')).toBeVisible();
  await play(page);
  await configured(page);
  await page.getByTestId('card-client').click();
  await expect(page.getByTestId('cluster-score')).toContainText('(illustrative)', { timeout: 90_000 });
});

// ---- The failure demos and the claims behind them, in the stand-in: the display client is identical in
// ---- both back ends (FR-06c), and the stand-in starts in seconds.
const URL_JS = 'demo/?seed=1&backend=standin';

async function ready(page: Page) {
  await open(page, URL_JS);
  await play(page);
  await page.getByTestId('card-client').click();
  await configured(page);
  await expect(page.getByTestId('chart-line').locator('canvas')).toBeVisible({ timeout: 60_000 });
}

async function demo(page: Page, id: string) {
  await page.getByTestId('demo-menu').click();
  await page.getByTestId(`demo-${id}`).click();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
}

test('overview: what is adopted, what is written, what is not in the demonstrator', async ({ page }) => {
  await open(page, URL_JS);
  await expect(page.getByTestId('detail-empty')).toBeVisible();
  await expect(page.getByTestId('adopted').locator('tbody tr')).toHaveCount(10);
  await expect(page.getByTestId('adopted')).toContainText('OGC API – Connected Systems');
  await expect(page.getByTestId('written').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('adopted')).toContainText('OpenSensorHub');
  await expect(page.getByTestId('not-here').locator('li')).toHaveCount(13);
  await expect(page.getByTestId('not-here')).toContainText('Authentication and access control');
  await expect(page.locator('.card.gold')).toHaveCount(0); // the overview reveals nothing (FR-74)
  await page.getByTestId('card-server').click();
  await expect(page.getByTestId('overview')).toHaveCount(0);
  await page.getByTestId('overview-button').click();
  await expect(page.getByTestId('overview')).toBeVisible();
  // Nothing on screen cites a requirement number.
  for (const id of ['adapter', 'store', 'platform', 'scilibs', 'server', 'models']) {
    await page.getByTestId(`card-${id}`).click();
    expect(await page.getByTestId('detail-panel').innerText()).not.toMatch(/\b(FR|AT|NFR|VS)-\d|§/);
  }
  await page.getByTestId('control-panel-toggle').click();
  expect(await page.getByTestId('control-panel').innerText()).not.toMatch(/\b(FR|AT|NFR|VS)-\d|§/);
});

test('the Data server panel claims only what the server does; models register over HTTP (FR-28)', async ({ page }) => {
  await ready(page);
  await page.getByTestId('card-server').click();
  const panel = page.getByTestId('detail-server');
  await expect(panel).toContainText('ordinary resource creation');
  await expect(panel).toContainText('Not used:');
  // What the panel says is not used is refused; what it says a model does, works: a model's service account
  // registers its process system under Models by ordinary resource creation (4.7: credentials, SensorML, 201).
  const probe = await page.evaluate(async () => {
    const owner = { authorization: 'Basic ' + btoa('owner:demo-owner') };
    const svc = { authorization: 'Basic ' + btoa('svc-new-model-2:svc-demo') };
    const events = await fetch('api/systemEvents', { headers: owner });
    const sy = await (await fetch('api/systems?searchMembers=true&f=application/sml%2Bjson', { headers: owner })).json();
    const models = sy.items.find((s: any) => s.uniqueId === 'urn:x-barge:process:models').id;
    const made = await fetch(`api/systems/${models}/subsystems`, {
      method: 'POST', headers: { ...svc, 'content-type': 'application/sml+json' },
      body: JSON.stringify({ type: 'SimpleProcess', uniqueId: 'urn:x-barge:process:new-model-2', label: 'Probe' }),
    });
    const removed = await fetch(`api/systems/${models}`, { method: 'DELETE', headers: owner });
    return { events: events.status, made: made.status, location: made.headers.get('location'), removed: removed.status };
  });
  expect(probe.events).toBe(404);
  expect(probe.made).toBe(201);
  expect(probe.location).toMatch(/\/systems\/[0-9a-v]{4}$/);
  expect(probe.removed).toBe(405);
  // The models' own traffic is on the flowchart, between Models and the data server, as HTTP.
  await expect(page.getByTestId('server-osh')).toContainText('OpenSensorHub');
  await expect(page.getByTestId('card-server').getByTestId('standin-tag')).toBeVisible(); // a stand-in in both back ends
  const counters = page.getByTestId('counters');
  await expect(counters.locator('tr', { hasText: 'receives from' }).filter({ hasText: 'Models' })).toBeVisible();
  await expect.poll(async () => Number((await counters.locator('tr', { hasText: 'receives from' }).filter({ hasText: 'Models' }).locator('td.num').innerText()).match(/Q ([\d,]+)/)?.[1].replace(/,/g, '') ?? 0),
    { timeout: 60_000 }).toBeGreaterThan(0);
});

test('server down, then up: unreachable and stale, then no answer while it starts, and a fresh handshake (AT-10, AT-11, FR-48)', async ({ page }) => {
  await ready(page);
  const instance = await page.getByTestId('server-state').innerText();
  const simTime = () => page.getByTestId('role-platform').innerText();
  await demo(page, 'down');
  await expect(page.getByTestId('client-state')).toHaveText('Server unreachable', { timeout: 30_000 });
  await expect(page.getByTestId('server-state')).toHaveText('Down');
  await expect(page.getByTestId('dc-banner')).toContainText('Server unreachable');
  await expect(page.getByTestId('dc-status')).toContainText('stale');
  await expect(page.locator('.is-stale')).toHaveCount(1); // the last data stays, marked stale
  const t = await simTime();
  await expect.poll(simTime, { timeout: 30_000 }).not.toBe(t); // the platform and its store carry on (FR-18)
  await page.getByTestId('demo-next').click();
  await expect(page.getByTestId('server-state')).toHaveText(/Ready/, { timeout: 60_000 });
  expect(await page.getByTestId('server-state').innerText()).not.toBe(instance);
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW_MS });
  await expect(page.locator('.is-stale')).toHaveCount(0);
});

test('an essential source removed: degraded, one warning naming the sources, their views unavailable (AT-07)', async ({ page }) => {
  await ready(page);
  await demo(page, 'essential');
  await expect(page.getByTestId('client-state')).toHaveText('Degraded', { timeout: SLOW_MS });
  await expect(page.getByTestId('dc-degraded')).toHaveCount(1);
  await expect(page.getByTestId('dc-degraded')).toContainText('Bow air temperature');
  await expect(page.getByTestId('view-line')).toContainText('Unavailable');
  await expect(page.getByTestId('chart-line')).toHaveCount(0); // never an empty chart (FR-45)
  await expect(page.getByTestId('chip').filter({ hasText: 'air temperature' }).first()).toBeDisabled();
  await page.getByTestId('demo-reset').click();
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW_MS });
  await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
});

test('fields the client has never seen appear after a handshake, drawn by schema type (AT-09)', async ({ page }) => {
  await ready(page);
  const before = await page.getByTestId('chip').allInnerTexts();
  await demo(page, 'extra');
  // 4.7 (D-293): the client reads Mission A, whose files record no precipitation, so two of the three fields appear.
  await expect.poll(async () => (await page.getByTestId('chip').allInnerTexts()).length, { timeout: SLOW_MS }).toBe(before.length + 2);
  await expect(page.getByTestId('client-state')).toHaveText('Configured');
  for (const name of ['Pressure tendency', 'Readings removed']) {
    const chip = page.getByTestId('chip').filter({ hasText: name });
    await expect(chip).toHaveClass(/optional/); // not in the profile: no warning, a dashed chip
    await chip.click();
  }
  await expect(page.getByTestId('chart-line').locator('canvas')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
});

test('a server whose profile claim discovery contradicts is rejected (AT-08)', async ({ page }) => {
  await ready(page);
  await demo(page, 'lie');
  await expect(page.getByTestId('client-state')).toHaveText('Server rejected', { timeout: SLOW_MS });
  await expect(page.getByTestId('dc-rejected')).toContainText('This server cannot be used');
  await page.getByTestId('demo-reset').click();
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW_MS });
});

test('a model written in an empty slot registers and appears in the display client (AT-13, Python)', async ({ page }) => {
  await open(page);
  await play(page);
  await configured(page);
  await page.getByTestId('card-models').click();
  await page.getByTestId('model-new-model-1').click();
  await expect(page.getByTestId('model-editor')).toBeVisible();
  await page.getByTestId('run-model').click();
  await expect(page.getByTestId('phase-new-model-1')).toContainText('live', { timeout: SLOW_MS });
  await page.getByTestId('card-client').click();
  await page.getByTestId('restart-client').click(); // discovery happens only at handshake (FR-44)
  await page.getByTestId('card-client').click();
  await configured(page);
  const chip = page.getByTestId('chip').filter({ hasText: 'Wind chill' });
  await expect(chip).toBeVisible({ timeout: SLOW_MS });
  await expect(chip).toHaveClass(/optional/);
  await chip.click();
  await expect(page.getByTestId('chart-line').locator('canvas')).toBeVisible({ timeout: 60_000 });
});
