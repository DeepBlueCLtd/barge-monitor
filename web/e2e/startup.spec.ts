import { readFileSync, writeFileSync } from 'node:fs';
import { expect, Page, test } from '@playwright/test';
import { SUB_DEMO } from './site';

// Startup made robust (FR-125a, NFR-10a, docs/v4-interfaces.md §13.7; AT-67's "says why"
// part, AT-68). Every test serves the site under a pull request's published sub-path, as the
// preview is, and starts from a fresh browser context, so no relay is installed unless the
// test installs one. The default back end (the JavaScript stand-in) starts in seconds.
// Interfaces §13.7: the 4.1 step "history" is retired with the logger's history (D-320).
const STEPS = ['relay', 'back end', 'server', 'import', 'models'];
const STARTED_MS = 30_000; // NFR-10's budget
const STALL_SAYS_WITHIN_MS = 12_000; // NFR-10a: 10 s, plus a little for the page to load

/** The 4.1 relay, as deployed before this change: an older sw.js already installed. */
const SW_41 = readFileSync(new URL('./fixtures/sw-4.1.js', import.meta.url), 'utf8');
/** An older relay at its worst: it never skips waiting, never claims, and forwards nothing. */
const SW_STUBBORN = "self.addEventListener('fetch', () => {});\n";

const relayVersion = (page: Page) => page.evaluate(() => new Promise<string | null>((resolve) => {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return resolve(null);
  const t = setTimeout(() => resolve('no answer (an older relay)'), 2000);
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'relay-version') { clearTimeout(t); resolve(e.data.version); }
  });
  sw.postMessage({ type: 'version' });
}));

/**
 * Deploy `body` as the site's sw.js, as an earlier deploy of the preview did, until
 * `restore`. The file on disk is changed rather than the request routed: Playwright's
 * routing makes Chromium bypass Service Workers, which would hide what is tested here.
 */
const SITE_SW = new URL('../../dist-site/demo/sw.js', import.meta.url);
const CURRENT_SW = readFileSync(SITE_SW, 'utf8');
const deployRelay = (body: string) => writeFileSync(SITE_SW, body);
const restore = () => writeFileSync(SITE_SW, CURRENT_SW);
test.afterEach(restore);

test('the relay answers the version the page waits for (D-354)', () => {
  const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  const version = /RELAY_VERSION = '([^']+)'/.exec(config)?.[1];
  expect(version).toBeTruthy();
  expect(CURRENT_SW).toContain(`const RELAY_VERSION = '${version}'`);
});

/** AT-67 ("says why"): every disabled top-bar control gives a non-empty reason, in its title and to assistive technology. */
async function everyDisabledControlSaysWhy(page: Page): Promise<number> {
  const found = await page.getByTestId('controls').locator('button').evaluateAll((els) => els.map((e) => {
    const b = e as HTMLButtonElement;
    const ids = (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return {
      label: b.textContent?.trim() ?? '',
      disabled: b.disabled,
      title: b.title,
      described: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' '),
    };
  }));
  const disabled = found.filter((c) => c.disabled);
  for (const c of disabled) {
    expect(c.title, `${c.label}: title`).not.toBe('');
    expect(c.described, `${c.label}: aria-describedby`).not.toBe('');
  }
  return disabled.length;
}

async function started(page: Page) {
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTED_MS });
  await expect(page.getByTestId('step-models')).toHaveCount(0); // the steps give way to the flowchart
  await expect(page.getByTestId('stall')).toHaveCount(0);
  // Nothing has started playing; a control that cannot act yet says why (FR-125a). 4.7 (D-307): replay is the
  // display client's own, in its own replay bar (D-362: the top bar mirrors it no more); the system's Pause is there.
  expect(await everyDisabledControlSaysWhy(page)).toBe(0);
  await expect(page.getByTestId('restart-server')).toBeEnabled();
  await expect(page.getByTestId('play')).toHaveCount(0);
  await expect(page.getByTestId('system-pause')).toBeEnabled();
  await expect(page.getByTestId('system-pause')).toHaveText(/Pause system/);
  await expect(page.getByTestId('sim-state')).toHaveText('Paused');
  // The relay answers for the system: a request under api/ reaches the back end (with the
  // demo owner's credentials: every request needs them, docs/v4-interfaces.md §9.3).
  const status = await page.evaluate(async () => (await fetch('api/', { headers: { authorization: 'Basic ' + btoa('owner:demo-owner') } })).status);
  expect(status).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test('(a) first load on the sub-path: the steps are named, startup completes, the controls enable (NFR-10a, FR-125a)', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Hold the back-end step for a moment, so the named steps and disabled controls can be read: the stand-in worker's
  // script is held (the history it used to hold back is retired, D-320).
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/standin\.worker-[^/]*\.js/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(SUB_DEMO);
  const steps = page.getByTestId('startup-steps').locator('li');
  await expect(steps).toHaveCount(STEPS.length);
  for (const [i, name] of STEPS.entries()) await expect(steps.nth(i).locator('b')).toHaveText(name);
  await expect(page.getByTestId('step-relay')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('step-back-end')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('step-back-end')).toHaveAttribute('aria-current', 'step');
  // (d) while starting, every top-bar control is disabled and says why.
  // D-362: the system's Pause and drawing speed are the exception: they can act from the start.
  expect(await everyDisabledControlSaysWhy(page)).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId('restart-client')).toBeDisabled();
  await expect(page.getByTestId('restart-client')).toHaveAttribute('title', 'Starting: back end');
  await expect(page.getByTestId('system-pause')).toBeEnabled();
  await expect(page.getByTestId('control-reason')).toHaveText('Starting: back end');
  release();
  await started(page);
  // D-366: the page opens with no dataset loaded: the folder is listed, nothing in it imported.
  await expect.poll(() => page.evaluate(() => ((globalThis as any).bargeControlState?.()?.folder ?? []).map((f: any) => f.status)))
    .toEqual(Array(4).fill('not-imported'));
  expect(await relayVersion(page)).toMatch(/^4\.7/);
  expect(errors).toEqual([]);
  await context.close();
});

test('(a) a hard reload, which loads the page without a relay in control, still starts', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(SUB_DEMO);
  await started(page);
  // Shift+Reload: the browser bypasses the Service Worker, so the page has no controller,
  // and the active relay never activates again. 4.1 waited for ever for controllerchange here.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.reload', { ignoreCache: true });
  await started(page);
  await context.close();
});

const OLDER = [['the 4.1 relay', SW_41], ['a relay that never skips waiting or claims', SW_STUBBORN]] as const;
for (const [hard, [name, older]] of [false, true].flatMap((h) => OLDER.map((o) => [h, o] as const))) {
  test(`(b) ${hard ? 'hard ' : ''}reload with an older sw.js installed (${name}): still starts, no hang (AT-68)`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    deployRelay(older);
    await page.goto(SUB_DEMO);
    // The older relay is now installed and active for this scope.
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 15_000 });
    restore(); // this build is deployed over it
    if (hard) {
      // Uncontrolled, with the older relay active: only an update the page asks for brings the new one.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.reload', { ignoreCache: true });
    } else {
      await page.reload();
    }
    await started(page);
    // The new relay has taken over from the older one.
    await expect.poll(() => relayVersion(page), { timeout: 10_000 }).toMatch(/^4\.7/);
    await context.close();
  });
}

test('(c) Service Workers blocked: within 10 s the page names the stalled step and what to do (AT-68)', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(SUB_DEMO);
  const stall = page.getByTestId('stall');
  await expect(stall).toBeVisible({ timeout: STALL_SAYS_WITHIN_MS });
  console.log(`stall message after ${Date.now() - t0} ms`);
  await expect(stall).toHaveAttribute('data-step', 'relay');
  await expect(stall).toContainText('relay');
  await expect(stall).toContainText('Reload');
  await expect(stall).toContainText('Service Workers');
  await expect(page.getByTestId('restart-client')).toBeDisabled();
  await expect(page.getByTestId('restart-client')).toHaveAttribute('title', /^Starting: relay/);
  expect(await everyDisabledControlSaysWhy(page)).toBeGreaterThanOrEqual(5);
  await context.close();
});

test('(c) the relay fails to register (sw.js not served): the page says so at once, naming the step (AT-68)', async ({ browser }) => {
  const context = await browser.newContext();
  await context.route('**/demo/sw.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  const page = await context.newPage();
  await page.goto(SUB_DEMO);
  const stall = page.getByTestId('stall');
  await expect(stall).toBeVisible({ timeout: STALL_SAYS_WITHIN_MS });
  await expect(stall).toHaveAttribute('data-step', 'relay');
  await expect(stall).toContainText('could not be registered');
  await expect(stall).toContainText('Service Workers');
  await expect(page.getByTestId('step-relay')).toHaveAttribute('data-state', 'failed');
  expect(await everyDisabledControlSaysWhy(page)).toBeGreaterThanOrEqual(5);
  await context.close();
});

test('(c) a relay that registers but never takes control: after 10 s the page names the step and what to do (AT-68)', async ({ browser }) => {
  const context = await browser.newContext();
  deployRelay(SW_STUBBORN);
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(SUB_DEMO);
  const stall = page.getByTestId('stall');
  await expect(stall).toBeVisible({ timeout: STALL_SAYS_WITHIN_MS });
  const after = Date.now() - t0;
  console.log(`stall message after ${after} ms`);
  expect(after).toBeGreaterThanOrEqual(9_500);
  await expect(stall).toHaveAttribute('data-step', 'relay');
  await expect(stall).toContainText('has not taken control');
  await expect(stall).toContainText('Reload');
  await expect(page.getByTestId('restart-client')).toHaveAttribute('title', 'Starting: relay (stalled: see the message on the page)');
  expect(await everyDisabledControlSaysWhy(page)).toBeGreaterThanOrEqual(5);
  await context.close();
});

test('the site serves the data folder: index.json lists four files (FR-15, interfaces §5)', async ({ request }) => {
  const res = await request.get(`${SUB_DEMO}data/folder/index.json`);
  expect(res.status()).toBe(200);
  const index = await res.json();
  expect(index.files.map((f: { file: string }) => f.file)).toEqual([
    'MISSION_A_20310407.csv', 'MISSION_B_20310414.csv', 'MISSION_B_20310414_REEXPORT.csv', 'MISSION_C_20310421.csv']);
  for (const f of index.files) expect((await request.head(`${SUB_DEMO}data/folder/${f.file}.gz`)).status()).toBe(200);
});
