import { expect, Page, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND, withBackend } from './backend';

// End-to-end tests of SRD 4.6 against the assembled static site, in stand-in mode
// (the default back end, FR-06b). Each test loads the page afresh, so each starts
// from a new back end: Mission A imported silently, paused at its start (FR-77).
const STARTUP_BUDGET_MS = 30_000; // NFR-10, as declared in src/config.ts
const SLOW = 90_000;
const BASE = withBackend('demo/');
const PASSWORDS = ['demo-owner', 'demo-friend', 'demo-analyst', 'svc-demo'];


/**
 * Requests the display client sends to the server, through the relay. The stand-in's models run in its
 * worker; the Python back end's model workers also go through the relay, and say so (x-tap-model): left out.
 */
function apiLog(page: Page) {
  const log: { at: number; url: string; method: string }[] = [];
  page.on('request', (r) => {
    if (/\/demo\/api(\/|$)/.test(r.url()) && !r.headers()['x-tap-model']) log.push({ at: Date.now(), url: r.url(), method: r.method() });
  });
  return log;
}
const since = (log: { at: number }[], t: number) => log.filter((x) => x.at >= t);
const landing = (u: string) => /\/demo\/api\/?$/.test(u);

async function open(page: Page) {
  await page.goto(BASE);
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  await page.getByTestId('card-client').click();
}

async function login(page: Page, user = 'owner', password?: string) {
  if (password === undefined) await page.getByTestId(`demo-login-${user}`).click();
  else {
    await page.getByTestId('login-user').fill(user);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();
  }
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
}

const bar = (page: Page) => page.getByTestId('replay-bar');
const chipLabels = async (page: Page) => (await page.getByTestId('chip').allInnerTexts()).join(' | ');
const monitorText = (page: Page) => page.getByTestId('monitor').innerText();

/** Open a file from the picker, and wait until the display client shows that dataset's field list. */
async function openFile(page: Page, file: string) {
  await page.getByTestId(`open-${file}`).click();
  await viewing(page, file);
}

async function viewing(page: Page, file: string) {
  const row = page.locator(`[data-testid="dataset-row"][data-file="${file}"]`).last();
  await expect(row).toHaveAttribute('data-dataset', /./, { timeout: SLOW });
  const id = await row.getAttribute('data-dataset');
  await expect(page.locator(`[data-testid="dc"][data-view="${id}"]`)).toBeVisible({ timeout: SLOW });
  await expect(page.getByTestId('chips')).toBeVisible();
}

async function demo(page: Page, id: string) {
  await page.getByTestId('demo-menu').click();
  await page.getByTestId(`demo-${id}`).click();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
}

type Msg = { src: string; dst: string; letter: string; content: string; chain?: string | null; summary: string };
const messages = (page: Page) => page.evaluate(() => (window as unknown as { __messages: () => Msg[] }).__messages());

test('start-up within budget; before login nothing is shown and nothing is sent (NFR-10, FR-97, AT-19)', async ({ page }) => {
  const log = apiLog(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(BASE);
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
  console.log(`flowchart after ${Date.now() - t0} ms`);
  // NFR-05, NFR-10: the start-up budget includes the silent import of Mission A and each model's worker.
  type Startup = { milestones: Record<string, number> };
  const startup = () => page.evaluate(() => (window as unknown as { __startup: () => Startup }).__startup());
  await expect.poll(async () => (await startup()).milestones.models ?? null, { timeout: STARTUP_BUDGET_MS }).not.toBeNull();
  const { milestones } = await startup();
  console.log(`start-up (${BACKEND}), ms from navigation: server running ${milestones.server}, Mission A loaded ${milestones.dataset}, models ready ${milestones.models}`);
  for (const k of ['server', 'dataset', 'models']) expect(milestones[k], k).toBeLessThan(STARTUP_BUDGET_MS);
  await page.getByTestId('card-client').click();
  await expect(page.getByTestId('dc-login')).toBeVisible();
  // VS-24, FR-102: the two demo accounts, labelled.
  await expect(page.getByTestId('demo-credentials')).toContainText('Demo credentials');
  await expect(page.getByTestId('demo-login-owner')).toBeVisible();
  await expect(page.getByTestId('demo-login-friend')).toBeVisible();
  await page.waitForTimeout(3000);
  expect(log).toEqual([]);
  expect(await monitorText(page)).not.toMatch(/MISSION|mission-/);
  await expect(page.getByTestId('analyst-state')).toHaveText('Not logged in');
  for (const id of ['folder', 'importer', 'replay', 'gateway', 'server', 'models', 'scilibs', 'client']) await expect(page.getByTestId(`card-${id}`)).toBeVisible();
  await expect(page.getByTestId('godseye-note')).toBeVisible(); // FR-68a
  expect(errors).toEqual([]);
});

test('AT-58: no code in the display client mentions CO₂ or roles', () => {
  const root = fileURLToPath(new URL('../src/client', import.meta.url));
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else readFileSync(p, 'utf8').split('\n').forEach((line, i) => /co2|co₂|role|owner|friend|emission/i.test(line) && hits.push(`${p}:${i + 1}: ${line.trim()}`));
    }
  };
  walk(root);
  expect(hits).toEqual([]);
});

test('login, handshake, the owner sees CO₂; nothing sensitive in the browser; no credential captured (AT-51, AT-53, AT-58, AT-20)', async ({ page }) => {
  const log = apiLog(page);
  await open(page);
  // FR-101: a refusal is generic.
  await page.getByTestId('login-user').fill('owner');
  await page.getByTestId('login-password').fill('wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText('The name or password is wrong.');
  await login(page);
  // FR-42: discovery only, the profile at its fixed path (FR-41); no instance header is needed.
  expect(log.some((x) => landing(x.url))).toBe(true);
  expect(log.some((x) => /profile\.json$/.test(x.url))).toBe(true);
  // The same build shows CO₂ to the owner (AT-58), because discovery finds it.
  expect(await chipLabels(page)).toContain('CO₂');
  await expect(page.getByTestId('analyst-state')).toHaveText('owner');
  await expect(page.getByTestId('essentials-state')).toHaveText('All present');
  // AT-20: the display client is revealed once it shows its views in its panel; Models on its first click.
  await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'true');
  await expect(page.getByTestId('card-importer')).toHaveAttribute('data-revealed', 'false');
  await page.getByTestId('card-models').click();
  await expect(page.getByTestId('card-models')).toHaveAttribute('data-revealed', 'true');
  await page.getByTestId('card-client').click();
  // AT-51: no credentials, dataset names or data of interest in any browser storage.
  const stored = await page.evaluate(async () => {
    const all: string[] = [];
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) all.push(`${s.key(i)}=${s.getItem(s.key(i)!)}`);
    const dbs = (await indexedDB.databases?.()) ?? [];
    all.push(...dbs.map((d) => `idb:${d.name}`));
    return all.join('\n');
  });
  for (const bad of [...PASSWORDS, 'MISSION', 'mission-', 'Basic ', 'authorization']) expect(stored).not.toContain(bad);
  // AT-53: no captured message shows a credential.
  const msgs = await messages(page);
  expect(msgs.length).toBeGreaterThan(20);
  const text = JSON.stringify(msgs);
  for (const p of PASSWORDS) expect(text).not.toContain(p);
  expect(text).not.toContain(Buffer.from('owner:demo-owner').toString('base64'));
  expect(msgs.some((m) => /authorization: \*\*\*\*/i.test(m.content))).toBe(true);
});

test('replay by commands: play, rates, seek and the log; never waited on; polls per second; nothing while paused (AT-33, AT-35, AT-37, AT-39, AT-19)', async ({ page }) => {
  const log = apiLog(page);
  await open(page);
  await login(page);
  await expect(bar(page)).toHaveAttribute('data-playing', 'false');
  // AT-39: the POST is held about 5 s by the server; the bar follows the state within about a second.
  const t0 = Date.now();
  await page.getByTestId('dc-play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'true', { timeout: 3000 });
  expect(Date.now() - t0).toBeLessThan(3500);
  const post = log.find((x) => x.method === 'POST' && /commands$/.test(x.url) && x.at >= t0);
  expect(post).toBeTruthy();
  // AT-37: requests per real second the same at 0.1× and 10×.
  await page.getByTestId('dc-rate-0.1').click();
  await expect(bar(page)).toHaveAttribute('data-rate', '0.1');
  await page.waitForTimeout(10_000); // past the command's own watch
  let t = Date.now();
  await page.waitForTimeout(6000);
  const slow = since(log, t).length;
  await page.getByTestId('dc-rate-10').click();
  await expect(bar(page)).toHaveAttribute('data-rate', '10');
  await page.waitForTimeout(10_000);
  t = Date.now();
  await page.waitForTimeout(6000);
  const fast = since(log, t).length;
  console.log(`requests in 6 s: ${slow} at 0.1×, ${fast} at 10×`);
  expect(Math.abs(fast - slow)).toBeLessThanOrEqual(Math.max(3, slow * 0.25));
  // AT-35: above the slowest model's bound: rejected, naming the bound and the model.
  await page.getByTestId('dc-rate-100').click();
  await expect(page.getByTestId('dc-notice').filter({ hasText: 'rate 100 exceeds 10, the highest Analysis sustains' })).toBeVisible({ timeout: 10_000 });
  await expect(bar(page)).toHaveAttribute('data-rate', '10');
  // Seek by the timeline: a new run; the state follows.
  const slider = page.getByTestId('dc-timeline');
  const b = (await slider.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height / 2);
  await expect(bar(page)).toHaveAttribute('data-time', /T1[12]:/, { timeout: 4000 });
  // FR-91: the replay controller's panel shows the commands pushed to it.
  await page.getByTestId('card-replay').click();
  await expect(page.getByTestId('replay-log')).toContainText('seek');
  await expect(page.getByTestId('replay-log')).toContainText('play');
  await page.getByTestId('card-client').click();
  // The top bar's mirror acts through the display client.
  await page.getByTestId('play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'false', { timeout: 3000 });
  await expect(page.getByTestId('replay-state')).toContainText('paused');
  // AT-19: while paused, the client polls nothing.
  await page.waitForTimeout(10_000);
  t = Date.now();
  await page.waitForTimeout(4000);
  expect(since(log, t)).toEqual([]);
});

test('Freeze holds the drawing and the replay (FR-92, AT-19)', async ({ page }) => {
  await open(page);
  await login(page);
  await page.getByTestId('dc-play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'true', { timeout: 3000 });
  await page.getByTestId('freeze').click();
  await page.waitForTimeout(500);
  const where = () => page.locator('[data-testid="message-icon"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform).join(';'));
  const a = await where();
  const time = await page.getByTestId('replay-state').innerText();
  await page.waitForTimeout(1500);
  expect(await where()).toBe(a);
  expect(await page.getByTestId('replay-state').innerText()).toBe(time);
  await page.getByTestId('freeze').click();
  await expect(page.getByTestId('replay-state')).not.toHaveText(time, { timeout: 5000 });
});

test('import, overlapping files, degraded Mission C, and returning without a handshake; every boundary captured (AT-41, AT-42, AT-44, AT-07, AT-18, FR-44)', async ({ page }) => {
  const log = apiLog(page);
  await open(page);
  await login(page);
  // AT-41: a file not imported: import (progress shown), then load; a full handshake follows (FR-44).
  const t0 = Date.now();
  await page.getByTestId('open-MISSION_B_20310414.csv').click();
  await expect(page.getByTestId('import-progress')).toBeVisible({ timeout: 10_000 });
  await viewing(page, 'MISSION_B_20310414.csv');
  expect(since(log, t0).some((x) => landing(x.url))).toBe(true);
  // The overlapping re-export: its own dataset, side by side (AT-42; the separation itself is tested in the back ends).
  await openFile(page, 'MISSION_B_20310414_REEXPORT.csv');
  const rows = page.getByTestId('dataset-row');
  const b1 = await rows.filter({ hasText: 'MISSION_B_20310414.csv' }).getAttribute('data-dataset');
  const b2 = await rows.filter({ hasText: 'REEXPORT' }).getAttribute('data-dataset');
  expect(b1).toMatch(/^mission-b-20310414-/);
  expect(b2).toMatch(/^mission-b-20310414-reexport-/);
  // AT-07: Mission C opens degraded, naming its missing source.
  await openFile(page, 'MISSION_C_20310421.csv');
  await expect(page.getByTestId('dc-degraded')).toContainText('Stern wind speed');
  await expect(page.getByTestId('essentials-state')).toContainText('missing');
  // AT-44: back to Mission A: the field list rebuilt without a full handshake; not degraded.
  const t1 = Date.now();
  await openFile(page, 'MISSION_A_20310407.csv');
  await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
  expect(since(log, t1).some((x) => landing(x.url))).toBe(false);
  expect(Date.now() - t1).toBeLessThan(15_000);
  // AT-18: every boundary of §3.1 produced captured messages (the models call the scientific libraries as the replay passes).
  await page.getByTestId('dc-rate-10').click();
  await page.getByTestId('dc-play').click();
  await expect.poll(async () => (await messages(page)).some((m) => m.src === 'scilibs'), { timeout: 60_000 }).toBe(true);
  await page.getByTestId('dc-play').click();
  const msgs = await messages(page);
  const pairs = new Set(msgs.map((m) => `${m.src}>${m.dst}`));
  for (const p of ['client>gateway', 'gateway>client', 'gateway>server', 'server>gateway', 'models>gateway', 'gateway>models', 'server>replay', 'replay>server',
    'importer>folder', 'folder>importer', 'importer>server', 'server>importer', 'models>scilibs', 'scilibs>models']) expect([...pairs]).toContain(p);
  expect(msgs.some((m) => m.src === 'importer' && m.letter === 'I' && /rows written/.test(m.summary))).toBe(true);
  // Capture off: nothing new is captured; on again, messages resume (FR-66).
  await page.getByTestId('control-panel-toggle').click();
  await page.getByTestId('capture').uncheck();
  await page.waitForTimeout(1000);
  const total = () => page.evaluate(() => (window as unknown as { __messageTotal: () => number }).__messageTotal());
  const n0 = await total();
  await page.getByTestId('dc-play').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('dc-play').click();
  expect(await total()).toBe(n0);
  await page.getByTestId('capture').check();
  await page.getByTestId('dc-play').click();
  await expect.poll(total, { timeout: 10_000 }).toBeGreaterThan(n0);
  // FR-109, FR-110: the folder and importer panels.
  await page.getByTestId('card-folder').click();
  await expect(page.getByTestId('folder-files')).toContainText('MISSION_C_20310421.csv');
  await page.getByTestId('card-importer').click();
  await expect(page.getByTestId('import-rate')).toContainText('rows a second');
  await expect(page.getByTestId('column-mapping')).toBeVisible();
  await page.getByTestId('card-server').click();
  await expect(page.getByTestId('server-datasets')).toContainText(b2!);
  await page.getByTestId('card-models').click();
  await expect(page.getByTestId('models-per-dataset')).toBeVisible();
});

test('data of interest: save, open exactly after switching dataset, compare on elapsed time, refuse a missing resolution, remove (AT-45, AT-46, AT-47)', async ({ page }) => {
  await open(page);
  await login(page);
  await page.getByTestId('dc-rate-10').click();
  await page.getByTestId('dc-play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'true', { timeout: 5000 });
  await page.waitForTimeout(25_000); // about four minutes of replay
  await page.getByTestId('dc-play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'false', { timeout: 5000 });
  await page.getByTestId('preset-1m').click();
  // AT-47: a resolution no datastream holds is refused, naming those that do.
  await page.getByTestId('doi-label').fill('Bad');
  await page.getByTestId('doi-resolution').fill('PT10M');
  await page.getByTestId('doi-save').click();
  await expect(page.getByTestId('doi-error')).toContainText('No datastream holds PT10M');
  await expect(page.getByTestId('doi-error')).toContainText('PT1S, PT1M, PT1H');
  // Save a minute of raw readings.
  await page.getByTestId('doi-label').fill('Last minute');
  await page.getByTestId('doi-resolution').fill('PT1S');
  await page.getByTestId('doi-save').click();
  await expect(page.getByTestId('doi-item').filter({ hasText: 'Last minute' })).toBeVisible();
  await page.getByTestId('doi-item').filter({ hasText: 'Last minute' }).getByTestId('doi-open').click();
  const opened = page.getByTestId('doi-opened');
  await expect(opened).toBeVisible();
  const sum1 = await opened.getAttribute('data-checksum');
  // And the run so far at 1-minute resolution.
  await page.getByTestId('preset-6h').click();
  await page.getByTestId('doi-label').fill('Minutes');
  await page.getByTestId('doi-resolution').fill('PT1M');
  await page.getByTestId('doi-save').click();
  await expect(page.getByTestId('doi-item').filter({ hasText: 'Minutes' })).toBeVisible();
  // AT-45: after switching dataset, the record regenerates exactly the same values.
  await openFile(page, 'MISSION_C_20310421.csv');
  await page.getByTestId('doi-item').filter({ hasText: 'Last minute' }).getByTestId('doi-open').click();
  await expect(page.getByTestId('doi-opened')).toHaveAttribute('data-checksum', sum1!);
  await expect(page.getByTestId('doi-opened')).toContainText('MISSION_A_20310407.csv');
  // AT-46: compared on elapsed time, at the coarser resolution, labelled "elapsed".
  await page.getByTestId('doi-item').filter({ hasText: 'Last minute' }).getByTestId('doi-pick').check();
  await page.getByTestId('doi-item').filter({ hasText: 'Minutes' }).getByTestId('doi-pick').check();
  await page.getByTestId('doi-compare-button').click();
  const cmp = page.getByTestId('doi-compare');
  await expect(cmp).toBeVisible();
  await expect(cmp).toContainText('elapsed');
  await expect(cmp).toContainText('at PT1M');
  // FR-105: remove.
  await page.getByTestId('doi-item').filter({ hasText: 'Minutes' }).getByTestId('doi-remove').click();
  await expect(page.getByTestId('doi-item').filter({ hasText: 'Minutes' })).toHaveCount(0);
});

test('clustering carries the selection as an unsaved data of interest; the cluster view shows the latest run (FR-35a, FR-60)', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (r) => r.method() === 'POST' && /commands$/.test(r.url()) && posts.push(r.postData() ?? ''));
  await open(page);
  await login(page);
  await page.getByTestId('dc-rate-10').click();
  await page.getByTestId('dc-play').click();
  // Data cleanse first: Analysis reads only its output (AT-15), so give it a few minutes of replay.
  await page.waitForTimeout(30_000);
  await page.getByTestId('cluster-B').click();
  await expect.poll(() => posts.find((p) => p.includes('"algorithm":"B"')) ?? '').toContain('doi');
  const sent = JSON.parse(posts.find((p) => p.includes('"algorithm":"B"'))!);
  const doi = JSON.parse(sent.parameters.doi);
  expect(doi.dataset).toMatchObject({ file: 'MISSION_A_20310407.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }); // §11, D-182
  expect(doi.sources.length).toBeGreaterThan(0);
  expect(Object.keys(sent.parameters).sort()).toEqual(['algorithm', 'clusters', 'doi', 'sensitivity']);
  await expect(page.getByTestId('chart-clusters')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('view-clusters')).toContainText('algorithm B', { timeout: 40_000 });
});

test('lock on the button and after inactivity: blanked, credentials gone, no request; unlocking restores the place (AT-50, FR-99)', async ({ page }) => {
  const log = apiLog(page);
  await open(page);
  await login(page);
  // A place to restore: a field chosen and a period.
  const humid = page.getByTestId('chip').filter({ hasText: 'Bow · Humidity' });
  await humid.click();
  await expect(humid).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('preset-6h').click();
  await page.getByTestId('dc-play').click();
  await page.waitForTimeout(2000);
  await page.getByTestId('dc-lock').click();
  await expect(page.getByTestId('dc-locked')).toBeVisible();
  await expect(page.getByTestId('analyst-state')).toHaveText('Locked');
  expect(await monitorText(page)).not.toMatch(/MISSION|mission-|Humidity|Last minute/);
  await page.waitForTimeout(1500);
  const t = Date.now();
  await page.waitForTimeout(4000);
  expect(since(log, t)).toEqual([]);
  // Unlocking needs the password again.
  await page.getByTestId('login-password').fill('demo-owner');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
  await expect(page.getByTestId('chip').filter({ hasText: 'Bow · Humidity' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('preset-6h')).toHaveAttribute('aria-pressed', 'true');
  // After inactivity: the failure demo shortens 5 minutes to 5 seconds.
  await demo(page, 'lock');
  await expect(page.getByTestId('dc-locked')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('demo-watch')).toContainText('blanked');
});

test('the friend: no trace of CO₂ in the client or its traffic, not degraded; a crafted request finds nothing (AT-55, AT-58, AT-60, FR-79a)', async ({ page }) => {
  await open(page);
  await login(page, 'friend');
  expect(await chipLabels(page)).not.toMatch(/CO₂|co2/i);
  expect(await monitorText(page)).not.toMatch(/CO₂|co2/i);
  await expect(page.getByTestId('dc-degraded')).toHaveCount(0); // AT-60
  await page.getByTestId('dc-play').click();
  await page.waitForTimeout(4000);
  // The client's own traffic, less the declared profile: a public document of the server's whose prose says CO₂ is never essential (FR-40).
  const mine = (await messages(page)).filter((m) => /^dc\d+-/.test(m.chain ?? '') && (m.src === 'client' || m.dst === 'client') && !/profile\.json/.test(m.summary));
  expect(mine.length).toBeGreaterThan(10);
  expect(mine.filter((m) => /co2|co₂/i.test(m.content + m.summary)).map((m) => m.summary)).toEqual([]);
  // The flowchart is a god's-eye view: the models' CO₂ traffic is still drawn (FR-68a).
  expect((await messages(page)).some((m) => /co2/i.test(m.content + m.summary))).toBe(true);
  await demo(page, 'crafted');
  await expect(page.getByTestId('demo-found')).toContainText('404', { timeout: 30_000 });
  await expect(page.getByTestId('demo-found')).toContainText('REJECTED: a requested source is not available');
});

test('a role change: CO₂ gone at the next request, the record naming it greyed as no longer permitted (AT-59)', async ({ page }) => {
  await open(page);
  await login(page, 'analyst', 'demo-analyst'); // Viewer with emissions
  const co2 = page.getByTestId('chip').filter({ hasText: 'Bow · CO₂' });
  await co2.click();
  await page.getByTestId('doi-label').fill('Engine CO₂');
  await page.getByTestId('doi-resolution').fill('PT1S');
  await page.getByTestId('doi-save').click();
  await expect(page.getByTestId('doi-item').filter({ hasText: 'Engine' })).toHaveAttribute('data-greyed', 'false');
  // The owner changes the role in OpenSensorHub's administration (the stand-in, §13.5).
  await page.getByTestId('control-panel-toggle').click();
  await page.getByTestId('set-role-analyst').selectOption('viewer');
  await page.getByTestId('control-panel-toggle').click();
  await page.getByTestId('restart-client').click();
  await page.getByTestId('card-client').click();
  await login(page, 'analyst', 'demo-analyst');
  expect(await chipLabels(page)).not.toContain('CO₂');
  const rec = page.getByTestId('doi-item').filter({ hasText: 'Engine' });
  await expect(rec).toHaveAttribute('data-greyed', 'true');
  await expect(rec).toContainText('No longer permitted');
});

test('Reset instance asks, naming what is lost; afterwards nothing is imported and no data of interest is left (FR-50a, AT-48)', async ({ page }) => {
  await open(page);
  await login(page);
  await page.getByTestId('chip').first().click();
  await page.getByTestId('doi-label').fill('Before the reset');
  await page.getByTestId('doi-resolution').fill('PT1S');
  await page.getByTestId('doi-save').click();
  await expect(page.getByTestId('doi-item').filter({ hasText: 'Before the reset' })).toHaveCount(1);
  await page.getByTestId('control-panel-toggle').click();
  await page.getByTestId('reset-instance').click();
  await expect(page.getByTestId('reset-confirm')).toContainText('1 imported dataset');
  await expect(page.getByTestId('reset-confirm')).toContainText('data of interest');
  await page.getByTestId('reset-confirm-yes').click();
  await page.getByTestId('control-panel-toggle').click();
  await expect(page.getByTestId('dataset-state')).toHaveText('None', { timeout: 15_000 });
  await page.getByTestId('restart-client').click();
  await page.getByTestId('card-client').click();
  await page.getByTestId('demo-login-owner').click();
  await expect(page.getByTestId('dc-no-dataset')).toBeVisible({ timeout: SLOW });
  await expect(page.getByTestId('dataset-row').filter({ hasText: 'MISSION_A' })).toHaveAttribute('data-status', 'not-imported');
  await expect(page.getByTestId('doi-item')).toHaveCount(0); // AT-48: deleted with everything else, not greyed
});

test('failure demos: the server down and up, restarts; an essential missing; a misconfigured server (AT-11, AT-31)', async ({ page }) => {
  const log = apiLog(page);
  await open(page);
  await login(page);
  await demo(page, 'down');
  await expect(page.getByTestId('dc-unreachable')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.dc.is-stale')).toBeVisible();
  await expect(page.getByTestId('server-state')).toHaveText('Down');
  const t = Date.now();
  await page.getByTestId('demo-next').click();
  await expect(page.getByTestId('dc-unreachable')).toHaveCount(0, { timeout: SLOW });
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW });
  expect(since(log, t).some((x) => landing(x.url))).toBe(true); // a fresh handshake (FR-48)
  await page.getByTestId('demo-reset').click();
  await expect(page.getByTestId('server-state')).toHaveText('Running', { timeout: 10_000 });
  // An essential missing: the dataset opens degraded, naming it.
  await demo(page, 'essential');
  await expect(page.getByTestId('dc-degraded')).toContainText('air temperature', { timeout: SLOW });
  await page.getByTestId('demo-reset').click();
  await expect(page.getByTestId('dc-degraded')).toHaveCount(0, { timeout: SLOW });
  // A misconfigured server: the claim is checked, and a claimed fixed essential missing rejects the server.
  await demo(page, 'lie');
  await expect(page.getByTestId('dc-rejected')).toContainText('Archive catalogue', { timeout: SLOW });
  await page.getByTestId('demo-reset').click();
  await expect(page.getByTestId('dc-rejected')).toHaveCount(0, { timeout: SLOW });
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW });
  // The server restarts: the client finds it again by itself.
  const t2 = Date.now();
  await demo(page, 'restart');
  await expect.poll(() => since(log, t2).some((x) => landing(x.url)), { timeout: SLOW }).toBe(true);
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW });
});

test('failure demos: never-seen fields, the rate, a wrong password, the degraded dataset, the friend (AT-09, AT-31, AT-35)', async ({ page }) => {
  await open(page);
  await login(page);
  expect(await chipLabels(page)).not.toContain('Pressure tendency');
  await demo(page, 'extra');
  await expect(page.getByTestId('demo-next')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('demo-next').click();
  const extra = page.locator('[data-testid="chip"][data-key$="pressure_tendency_3h"]');
  await expect(extra).toBeVisible({ timeout: SLOW });
  await expect(extra).toHaveClass(/optional/);
  await expect(extra).toHaveAttribute('data-type', 'Quantity');
  await page.getByTestId('demo-reset').click();
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW });
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('client-state')).toHaveText('Configured', { timeout: SLOW });
  await demo(page, 'rate');
  await expect(page.getByTestId('dc-notice').filter({ hasText: 'exceeds 10, the highest Analysis sustains' })).toBeVisible({ timeout: 15_000 });
  await demo(page, 'password');
  await expect(page.getByTestId('login-error')).toHaveText('The name or password is wrong.', { timeout: 15_000 });
  expect(await monitorText(page)).not.toMatch(/MISSION|mission-/);
  await demo(page, 'friend');
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
  await expect(page.getByTestId('analyst-state')).toHaveText('friend');
  expect(await chipLabels(page)).not.toContain('CO₂');
  await demo(page, 'degraded');
  await viewing(page, 'MISSION_C_20310421.csv');
  await expect(page.getByTestId('dc-degraded')).toContainText('Stern wind speed');
});
