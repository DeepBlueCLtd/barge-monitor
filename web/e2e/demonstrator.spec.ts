import { expect, Page, Request, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, contrastPairs } from '../src/shell/palette';

// End-to-end tests of the 4.7 display client (plan Phase 7; SRD §7.5, §7.6, §8; docs/v4-interfaces.md §8, §9.3,
// §11) against the assembled static site, in both back ends: the JavaScript stand-in and the Python back end in
// Pyodide. Each test loads the page afresh, so each starts from a new back end: Mission A imported silently, and the
// models processing it on import. Every request goes through the Service Worker relay.
const SLOW = 300_000;
const PASSWORDS = ['demo-owner', 'demo-friend', 'demo-analyst', 'svc-demo'];
const A = 'MISSION_A_20310407.csv';
const B = 'MISSION_B_20310414.csv';
const C = 'MISSION_C_20310421.csv';

type Logged = { at: number; url: string; method: string; chain: string };

/** The display client's own requests (its chains are `dc<n>-<seq>`); the models' and the tests' are left out. */
function clientLog(page: Page): Logged[] {
  const log: Logged[] = [];
  page.on('request', (r: Request) => {
    const chain = r.headers()['x-tap-chain'] ?? '';
    if (/\/demo\/api(\/|\?|$)/.test(r.url()) && /^dc\d+-/.test(chain)) log.push({ at: Date.now(), url: r.url(), method: r.method(), chain });
  });
  return log;
}
const since = (log: Logged[], t: number) => log.filter((x) => x.at >= t);
const landing = (u: string) => /\/demo\/api\/?$/.test(u);

async function open(page: Page, backend: string, extra = '') {
  await page.goto(`demo/?backend=${backend}${extra}`);
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW });
  await page.getByTestId('card-client').click();
}

/** Log in, and wait until Mission A is open with its field list. */
async function login(page: Page, user = 'owner', password?: string) {
  if (password === undefined) await page.getByTestId(`demo-login-${user}`).click();
  else {
    await page.getByTestId('login-user').fill(user);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();
  }
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
}

/** Mission A's results complete (the models process it on import): nothing is being prepared, clusters are drawn. */
async function results(page: Page) {
  await expect(page.getByTestId('chart-clusters')).toBeVisible({ timeout: SLOW });
  await expect(page.getByTestId('preparing')).toHaveCount(0, { timeout: SLOW });
}

const bar = (page: Page) => page.getByTestId('replay-bar');
const chipLabels = async (page: Page) => (await page.getByTestId('chip').allInnerTexts()).join(' | ');
const monitorText = (page: Page) => page.getByTestId('monitor').innerText();

async function play(page: Page) {
  await page.getByTestId('dc-play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'true');
}

async function pause(page: Page) {
  await page.getByTestId('dc-play').click();
  await expect(bar(page)).toHaveAttribute('data-playing', 'false');
}

/** The dataset popup's "Open" or "Import and open" for a file, from the keyboard or the mouse. */
async function openFile(page: Page, file: string) {
  await page.getByTestId('dataset-button').click();
  await expect(page.getByTestId('dataset-popup')).toBeVisible();
  await page.getByTestId(`open-${file}`).click();
  await expect(page.getByTestId('dataset-popup')).toHaveCount(0);
  await viewing(page, file);
}

async function viewing(page: Page, file: string) {
  await expect(page.getByTestId('dataset-button')).toHaveAttribute('data-importing', 'false', { timeout: SLOW });
  await expect(page.getByTestId('dataset-button')).toContainText(`Dataset: ${file}`, { timeout: SLOW });
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
}

type Msg = { src: string; dst: string; letter: string; content: string; chain?: string | null; summary: string };
const messages = (page: Page) => page.evaluate(() => (window as unknown as { bargeMessages: () => Msg[] }).bargeMessages());
type Shown = { dataset: string | null; time: number | null; lines: { key: string; rows: [number, unknown][] }[]; clusters: [number, unknown][]; run: string | null };
const shown = (page: Page) => page.evaluate(() => (window as unknown as { bargeClientShown: () => Shown }).bargeClientShown());

/** What the server holds of the models' results for a dataset (runs logs and Analysis's outputs), as counts: AT-36, AT-70. */
async function serverOutputs(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const auth = { authorization: 'Basic ' + btoa('owner:demo-owner') };
    const ds = (await (await fetch('api/datastreams?limit=10000', { headers: auth })).json()).items as { id: string; outputName: string }[];
    const out: string[] = [];
    for (const d of ds.filter((x) => /^(runs|clusters|changes|summary-1h-bow)__mission-a/.test(x.outputName)).sort((a, b) => a.id.localeCompare(b.id))) {
      const rows = await (await fetch(`api/datastreams/${d.id}/observations?f=application/swe%2Bjson&limit=100000`, { headers: auth })).json();
      out.push(`${d.outputName}:${rows.length}`);
    }
    return out.join(',');
  });
}

test('AT-58: the display client\'s code mentions neither CO₂ nor roles', () => {
  const root = fileURLToPath(new URL('../src/client', import.meta.url));
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else readFileSync(p, 'utf8').split('\n').forEach((line, i) => /co2|co₂|\brole|owner|friend|emission/i.test(line) && hits.push(`${p}:${i + 1}: ${line.trim()}`));
    }
  };
  walk(root);
  expect(hits).toEqual([]);
});

test('every text and icon colour of the shell meets 4.5:1 (AT-22)', () => {
  const failing = contrastPairs().filter((p) => contrast(p.fg, p.bg) < 4.5).map((p) => `${p.what}: ${contrast(p.fg, p.bg).toFixed(2)}`);
  expect(failing).toEqual([]);
});

for (const backend of ['standin', 'python'] as const) {
  const name = backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in';
  test.describe(`the display client, ${name}`, () => {
    test.describe.configure({ mode: 'serial' });

    test(`nothing before login; a generic refusal; login; nothing sensitive kept, no credential captured (AT-19, AT-49 to AT-53), ${backend}`, async ({ page }) => {
      const log = clientLog(page);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await open(page, backend);
      await expect(page.getByTestId('dc-login')).toBeVisible();
      // FR-102: the two demo accounts, labelled as demo credentials.
      await expect(page.getByTestId('demo-credentials')).toContainText('Demo credentials');
      await expect(page.getByTestId('demo-login-owner')).toBeVisible();
      await expect(page.getByTestId('demo-login-friend')).toBeVisible();
      // FR-97, AT-19: nothing shown and nothing sent before login; the top bar's replay says why it cannot act.
      await page.waitForTimeout(3000);
      expect(log).toEqual([]);
      expect(await monitorText(page)).not.toMatch(/MISSION|mission-/);
      await expect(page.getByTestId('play')).toBeDisabled();
      await expect(page.getByTestId('play')).toHaveAttribute('title', 'Log in to the display client first');
      await expect(page.getByTestId('analyst-state')).toHaveText('Not logged in');
      // AT-49: without credentials, discovery and the catalogue are refused with 401; the browser's dialog is kept away.
      const anon = await page.evaluate(async () => Promise.all(['api/', 'api/systems', 'api/datastreams', 'api/profile.json'].map(async (u) => {
        const r = await fetch(u);
        return `${r.status}:${r.headers.get('www-authenticate') ?? ''}`;
      })));
      expect(anon).toEqual(['401:', '401:', '401:', '401:']);
      // FR-101: a refusal says only that the name or password was wrong.
      for (const [u, p] of [['owner', 'wrong'], ['nobody', 'demo-owner']]) {
        await page.getByTestId('login-user').fill(u);
        await page.getByTestId('login-password').fill(p);
        await page.getByTestId('login-submit').click();
        await expect(page.getByTestId('login-error')).toHaveText('The name or password is wrong.');
      }
      expect(await monitorText(page)).not.toMatch(/MISSION|mission-/);
      const t0 = Date.now();
      await login(page);
      // FR-42: standard discovery after login, the profile at its fixed path (FR-41).
      expect(since(log, t0).some((x) => landing(x.url))).toBe(true);
      expect(since(log, t0).some((x) => /profile\.json$/.test(x.url))).toBe(true);
      // After login: Mission A open and paused at its start (interfaces §8).
      await expect(page.getByTestId('dataset-button')).toContainText(A);
      await expect(bar(page)).toHaveAttribute('data-playing', 'false');
      await expect(bar(page)).toHaveAttribute('data-time', '2031-04-07T00:00:00Z');
      await expect(page.getByTestId('analyst-state')).toHaveText('owner');
      await expect(page.getByTestId('play')).toBeEnabled();
      // The display client is revealed once it shows its views in its panel (FR-75).
      await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'true');
      await results(page);
      // AT-51: no credentials, dataset names or data of interest in any browser storage.
      const stored = await page.evaluate(async () => {
        const all: string[] = [document.cookie];
        for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) all.push(`${s.key(i)}=${s.getItem(s.key(i)!)}`);
        const dbs = (await indexedDB.databases?.()) ?? [];
        all.push(...dbs.map((d) => `idb:${d.name}`));
        for (const k of await caches.keys()) all.push(`cache:${k}`);
        return all.join('\n');
      });
      for (const bad of [...PASSWORDS, 'MISSION', 'mission-', 'Basic ', 'authorization']) expect(stored).not.toContain(bad);
      // AT-53: no captured message shows a credential.
      const msgs = await messages(page);
      expect(msgs.filter((m) => /^dc\d+-/.test(m.chain ?? '')).length).toBeGreaterThan(10);
      const text = JSON.stringify(msgs);
      for (const p of PASSWORDS) expect(text).not.toContain(p);
      for (const u of ['owner:demo-owner', 'owner:wrong', 'nobody:demo-owner']) expect(text).not.toContain(Buffer.from(u).toString('base64'));
      expect(errors).toEqual([]);
    });

    test(`the own replay clock: play, pause, rates, seek, the end; no command; polls per real second whatever the rate; nothing while paused (AT-33, AT-36, AT-37, AT-19), ${backend}`, async ({ page }) => {
      const log = clientLog(page);
      await open(page, backend);
      await login(page);
      await results(page);
      const before = await serverOutputs(page);
      const t0 = Date.now();
      // Play: the client's own clock moves; the shell's status mirrors it.
      await play(page);
      await expect(page.getByTestId('sim-state')).toHaveText('Playing');
      await expect(bar(page)).not.toHaveAttribute('data-time', '2031-04-07T00:00:00Z', { timeout: 5000 });
      // AT-37: requests per real second the same at 0.1× and 100×.
      await page.getByTestId('dc-rate-0.1').click();
      await expect(bar(page)).toHaveAttribute('data-rate', '0.1');
      await page.waitForTimeout(1500);
      let t = Date.now();
      await page.waitForTimeout(6000);
      const slow = since(log, t).length;
      await page.getByTestId('dc-rate-100').click();
      await expect(bar(page)).toHaveAttribute('data-rate', '100');
      await page.waitForTimeout(1500);
      t = Date.now();
      await page.waitForTimeout(6000);
      const fast = since(log, t).length;
      console.log(`${backend}: requests in 6 s, ${slow} at 0.1×, ${fast} at 100×`);
      expect(slow).toBeGreaterThan(5);
      expect(Math.abs(fast - slow)).toBeLessThanOrEqual(Math.max(2, slow * 0.15));
      // FR-63b: never a read beyond the replay time.
      const time = Date.parse((await bar(page).getAttribute('data-time'))!) / 1000;
      const ends = since(log, t0).map((x) => new URL(x.url).searchParams.get('phenomenonTime')).filter((p): p is string => !!p).map((p) => Date.parse(p.split('/')[1]) / 1000);
      expect(ends.length).toBeGreaterThan(10);
      expect(Math.max(...ends)).toBeLessThanOrEqual(time + 1);
      // The top bar's mirror drives the same clock (interfaces §8).
      await page.getByTestId('play').click();
      await expect(bar(page)).toHaveAttribute('data-playing', 'false');
      await expect(page.getByTestId('sim-state')).toHaveText('Paused');
      await page.getByTestId('speed-10').click();
      await expect(bar(page)).toHaveAttribute('data-rate', '10');
      // FR-63a, AT-19: while paused, the client polls nothing.
      await page.waitForTimeout(3000);
      t = Date.now();
      await page.waitForTimeout(4000);
      expect(since(log, t)).toEqual([]);
      // Seek, from the keyboard on the timeline: near the end; then play to the end, where the clock pauses (FR-88).
      const slider = page.getByTestId('dc-timeline');
      await slider.focus();
      await page.keyboard.press('End');
      for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
      await expect(bar(page)).toHaveAttribute('data-time', '2031-04-07T23:59:39Z');
      await expect(page.getByTestId('replay-state')).toContainText('04-07 23:59:39');
      await play(page);
      await expect(bar(page)).toHaveAttribute('data-at-end', 'true', { timeout: 10_000 });
      await expect(bar(page)).toHaveAttribute('data-playing', 'false');
      await expect(page.getByTestId('dc-at-end')).toContainText('At the end');
      await expect(page.getByTestId('sim-state')).toHaveText('At the end');
      // Play at the end starts again from the start.
      await play(page);
      await pause(page);
      expect(Date.parse((await bar(page).getAttribute('data-time'))!)).toBeLessThan(Date.parse('2031-04-07T01:00:00Z'));
      // AT-33: open, play, pause, every rate and seek sent no command; AT-36: no model output changed.
      for (const r of ['0.1', '0.5', '1', '10', '100']) {
        await page.getByTestId(`dc-rate-${r}`).click();
        await expect(bar(page)).toHaveAttribute('data-rate', r);
      }
      expect(since(log, t0).filter((x) => x.method !== 'GET')).toEqual([]);
      expect(await serverOutputs(page)).toBe(before);
    });

    test(`the handshake shows its request in hand (D-357); Whole dataset shows all of it, with replay off and saying why (D-358), ${backend}`, async ({ page }) => {
      await open(page, backend);
      // Record each request the client shows while it runs its handshake.
      await page.evaluate(() => {
        const w = window as unknown as { hsSeen: string[] };
        w.hsSeen = [];
        new MutationObserver(() => {
          const e = document.querySelector('[data-testid="dc-handshake-request"]');
          if (e?.textContent && w.hsSeen[w.hsSeen.length - 1] !== e.textContent) w.hsSeen.push(e.textContent);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await login(page);
      const seen = await page.evaluate(() => (window as unknown as { hsSeen: string[] }).hsSeen);
      expect(seen).toContain('GET /api/conformance');
      expect(seen.some((x) => x.startsWith('GET /api/systems?'))).toBe(true);
      await expect(page.getByTestId('dc-handshake-request')).toHaveCount(0);
      await results(page);
      await page.getByTestId('dc-rate-100').click();
      await play(page);
      await page.getByTestId('preset-all').click();
      // A replay in progress stops; Play, the rates and the timeline say why they cannot act, in the client and the top bar.
      await expect(bar(page)).toHaveAttribute('data-playing', 'false');
      const why = 'Whole dataset shows everything: choose a shorter period to play';
      await expect(page.getByTestId('dc-play')).toBeDisabled();
      await expect(page.getByTestId('dc-play')).toHaveAttribute('title', why);
      await expect(page.getByTestId('dc-rate-10')).toBeDisabled();
      await expect(page.getByTestId('dc-timeline')).toBeDisabled();
      await expect(page.getByTestId('dc-replay-off')).toHaveText(why);
      await expect(page.getByTestId('play')).toBeDisabled();
      await expect(page.getByTestId('replay-reason')).toContainText(why);
      // All of the dataset is drawn: the lines reach far beyond the replay time (here, early in the day).
      await expect.poll(async () => {
        const v = await shown(page);
        const last = Math.max(...v.lines.flatMap((l) => l.rows.map(([t]) => t)));
        return last - (v.time ?? 0);
      }, { timeout: SLOW }).toBeGreaterThan(12 * 3600);
      // A shorter period turns replay on again.
      await page.getByTestId('preset-1h').click();
      await expect(page.getByTestId('dc-play')).toBeEnabled();
      await expect(page.getByTestId('dc-replay-off')).toHaveCount(0);
    });

    test(`two clients replay one dataset at different rates and positions and see the same results; the server is unchanged (AT-70), ${backend}`, async ({ page }) => {
      await open(page, backend);
      await login(page);
      await results(page);
      const before = await serverOutputs(page);
      // A day, not the whole dataset: the whole dataset is shown at once, with nothing to replay (D-358).
      await page.getByTestId('preset-1d').click();
      await page.getByTestId('dc-rate-100').click();
      await play(page);
      await page.waitForTimeout(6000);
      await pause(page);
      await page.waitForTimeout(1500);
      const one = await shown(page);
      // A second display client on the same server: the same code, not on screen (D-306).
      const two = await page.evaluate(async () => {
        type C = { login: (u: string, p: string) => Promise<boolean>; setPeriod: (p: string) => void; setRate: (r: number) => void; play: () => void; pause: () => void;
          seek: (t: number) => void; clock: { state: { value: { start: number } } }; shown: () => unknown; lock: () => void };
        const c = (window as unknown as { bargeNewClient: () => C }).bargeNewClient();
        await c.login('owner', 'demo-owner');
        c.setPeriod('1d');
        c.setRate(10);
        c.seek(c.clock.state.value.start + 5 * 3600);
        c.play();
        await new Promise((r) => setTimeout(r, 4000));
        c.pause();
        await new Promise((r) => setTimeout(r, 2500));
        const s = c.shown();
        c.lock();
        return s;
      }) as Shown;
      expect(one.dataset).toBe(two.dataset);
      expect(two.time!).toBeGreaterThan(one.time! + 3600);
      expect(one.lines.length).toBeGreaterThan(0);
      // Up to what the first client may read, both show exactly the same results: at "A day" the per-minute summaries,
      // each readable once its minute has ended (FR-63b), so up to the minute before its replay time.
      const upTo = one.time! - 60;
      for (const l of one.lines) {
        const other = two.lines.find((x) => x.key === l.key)!;
        expect(l.rows.length).toBeGreaterThan(0);
        expect(other.rows.filter(([t]) => t <= upTo)).toEqual(l.rows.filter(([t]) => t <= upTo));
        expect(other.rows.length).toBeGreaterThan(l.rows.length);
      }
      expect(two.run).toBe(one.run);
      expect(two.clusters.filter(([t]) => t <= one.time!)).toEqual(one.clusters);
      expect(Math.max(...one.clusters.map(([t]) => t))).toBeLessThanOrEqual(one.time!);
      expect(await serverOutputs(page)).toBe(before);
    });

    test(`the Dataset selector popup: Escape, a click outside, the keyboard; Mission C imported with progress on the button, opened degraded; back to Mission A without a handshake (AT-07, AT-41, AT-44, AT-69), ${backend}`, async ({ page }) => {
      const log = clientLog(page);
      await open(page, backend);
      await login(page);
      const button = page.getByTestId('dataset-button');
      const popup = page.getByTestId('dataset-popup');
      await expect(popup).toHaveCount(0); // FR-127: neither popup is open at login
      await expect(page.getByTestId('favourites-popup')).toHaveCount(0);
      // Escape closes it, and the focus returns to its button.
      await button.click();
      await expect(popup).toBeVisible();
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(popup.getByTestId('dataset-row')).toHaveCount(4);
      await expect(popup.locator(`[data-file="${A}"]`)).toHaveAttribute('data-status', 'imported');
      await expect(popup.locator(`[data-file="${C}"]`)).toHaveAttribute('data-status', 'not-imported');
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await expect(button).toBeFocused();
      // A click outside closes it.
      await button.click();
      await expect(popup).toBeVisible();
      await page.getByTestId('dc-user').click();
      await expect(popup).toHaveCount(0);
      // From the keyboard: Enter opens it with the focus inside; Rescan, then import and open Mission C.
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(popup).toBeVisible();
      await expect(page.getByTestId('rescan')).toBeFocused();
      await page.keyboard.press('Enter');
      const t0 = Date.now();
      await page.getByTestId(`open-${C}`).focus();
      await page.keyboard.press('Enter');
      // AT-41, AT-69: the import's progress stays on the button while the popup is closed.
      await expect(popup).toHaveCount(0);
      await expect(button).toHaveAttribute('data-importing', 'true');
      await expect(button).toContainText(`Importing ${C}`);
      await expect(page.getByTestId('dataset-button-pct')).toContainText('%');
      await viewing(page, C);
      await expect(button).toHaveAttribute('data-importing', 'false');
      // FR-44: a full handshake followed the import.
      expect(since(log, t0).some((x) => landing(x.url))).toBe(true);
      // AT-07: Mission C opens degraded, naming its missing source.
      await expect(page.getByTestId('dc-degraded')).toContainText('Stern wind speed', { timeout: SLOW });
      await expect(page.getByTestId('client-state')).toHaveText('Degraded');
      await button.click();
      await expect(popup.locator(`[data-file="${C}"]`).getByTestId('degraded-mark')).toContainText('Stern wind speed');
      await expect(popup.locator(`[data-file="${A}"]`).getByTestId('degraded-mark')).toHaveCount(0);
      // AT-44: back to Mission A: the field list rebuilt without a full handshake; not degraded.
      const t1 = Date.now();
      await page.getByTestId(`open-${A}`).click();
      await viewing(page, A);
      await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
      await expect(page.getByTestId('chart-clusters')).toBeVisible({ timeout: SLOW }); // processed: its results at once
      expect(since(log, t1).some((x) => landing(x.url))).toBe(false);
      // AT-33: opening an imported dataset is the client's own choice: no command.
      expect(since(log, t1).filter((x) => x.method !== 'GET')).toEqual([]);
    });

    test(`"results being prepared" while a model processes a new dataset, then its results (FR-35b, AT-44), ${backend}`, async ({ page }) => {
      // In the stand-in a run takes about a second and the client looks about once a second, so seeing it was luck:
      // `?runpace=` makes each run last long enough to be seen (D-355). Python's runs are long enough as they are.
      await open(page, backend, backend === 'standin' ? '&runpace=400' : '');
      await login(page);
      await results(page);
      // Record every "results being prepared" the client shows, however briefly.
      await page.evaluate(() => {
        const w = window as unknown as { preparedSeen: string[] };
        w.preparedSeen = [];
        new MutationObserver(() => {
          for (const e of document.querySelectorAll('[data-testid="preparing"]')) w.preparedSeen.push(e.textContent ?? '');
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await openFile(page, B);
      // A new Summaries run over every dataset (a settings command, interfaces §10.3), while the client plays:
      // in the stand-in a run takes about a second, so the import alone may finish before the client looks.
      await page.getByTestId('dc-rate-100').click();
      await play(page);
      const seenCount = () => page.evaluate(() => (window as unknown as { preparedSeen: string[] }).preparedSeen.length);
      // In the stand-in a run takes about a second, and the client looks once a second: ask again until it is seen.
      for (let i = 0; i < 8 && !(await seenCount()); i++) {
        await page.evaluate(async (hours) => {
          const auth = { authorization: 'Basic ' + btoa('owner:demo-owner'), 'content-type': 'application/json' };
          const all = (await (await fetch('api/controlstreams?limit=1000', { headers: auth })).json()).items as { id: string; inputName: string; 'system@id': string }[];
          const sys = (await (await fetch('api/systems?searchMembers=true&f=application/sml%2Bjson&limit=1000', { headers: auth })).json()).items as { id: string; uniqueId: string }[];
          const summaries = sys.find((x) => x.uniqueId === 'urn:x-barge:process:summaries')!.id;
          const target = all.find((c) => c.inputName === 'settings' && c['system@id'] === summaries)!;
          void fetch(`api/controlstreams/${target.id}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ parameters: { tendency_hours: hours } }) });
        }, 2 + (i % 4));
        await expect.poll(seenCount, { timeout: backend === 'python' ? 120_000 : 6000 }).toBeGreaterThan(0).catch(() => undefined);
      }
      expect(await seenCount()).toBeGreaterThan(0);
      const seen = await page.evaluate(() => (window as unknown as { preparedSeen: string[] }).preparedSeen);
      expect(seen.join(' ')).toMatch(/Results being prepared: .*(Summaries|Analysis|Data cleanse)/);
      // Then the results of the latest complete run, with nothing being prepared, and the dataset not degraded.
      await expect(page.getByTestId('preparing')).toHaveCount(0, { timeout: SLOW });
      await expect(page.getByTestId('chart-errorbars')).toBeVisible({ timeout: SLOW });
      await pause(page);
      await expect(page.getByTestId('chart-errorbars')).toBeVisible();
      await expect(page.getByTestId('chart-clusters')).toBeVisible({ timeout: SLOW });
      await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
    });

    test(`the friend: no CO₂ chip or source anywhere, no CO₂ value in its traffic, not degraded (AT-55, AT-58, AT-60), ${backend}`, async ({ page }) => {
      const bodies: string[] = [];
      page.on('response', async (r) => {
        const chain = r.request().headers()['x-tap-chain'] ?? '';
        if (!/^dc\d+-/.test(chain) || !/\/observations|\/schema/.test(r.url())) return;
        try {
          bodies.push(`${r.status()} ${r.url()}\n${await r.text()}`);
        } catch {
          /* gone */
        }
      });
      await open(page, backend);
      await login(page, 'friend');
      await results(page);
      expect(await chipLabels(page)).not.toMatch(/CO₂|co2/i);
      // AT-60: not degraded on a dataset with every essential source.
      await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
      await expect(page.getByTestId('client-state')).toHaveText('Configured');
      await expect(page.getByTestId('essentials-state')).toHaveText('All present');
      await page.getByTestId('dc-rate-100').click();
      await play(page);
      await page.waitForTimeout(4000);
      await pause(page);
      await page.getByTestId('favourites-button').click();
      expect(await monitorText(page)).not.toMatch(/CO₂|co2/i);
      await page.keyboard.press('Escape');
      // AT-55: no CO₂ value reaches the client: every schema or observation it read without CO₂, or refused.
      expect(bodies.length).toBeGreaterThan(10);
      expect(bodies.filter((b) => b.startsWith('200') && /co2/i.test(b)).map((b) => b.split('\n')[0])).toEqual([]);
      expect(bodies.some((b) => b.startsWith('403'))).toBe(true); // it asked, and was refused: left out generically (FR-118)
    });

    test(`the owner sees CO₂; a change of role takes effect at the next request, the favourite naming CO₂ greyed (AT-58, AT-59), ${backend}`, async ({ page }) => {
      await open(page, backend);
      await login(page);
      expect(await chipLabels(page)).toContain('Bow · CO₂');
      await page.getByTestId('dc-lock').click();
      await expect(page.getByTestId('dc-locked')).toBeVisible();
      await page.getByTestId('restart-client').click();
      await page.getByTestId('card-client').click();
      await login(page, 'analyst', 'demo-analyst'); // Viewer with emissions
      await results(page);
      const co2 = page.getByTestId('chip').filter({ hasText: 'Bow · CO₂' });
      await co2.click();
      await expect(co2).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('favourites-button').click();
      await page.getByTestId('doi-label').fill('Engine CO₂');
      await page.getByTestId('doi-resolution').fill('PT1S');
      await page.getByTestId('doi-save').click();
      await expect(page.getByTestId('doi-item').filter({ hasText: 'Engine' })).toHaveAttribute('data-greyed', 'false');
      await page.keyboard.press('Escape');
      // The owner changes the analyst's role in OpenSensorHub's administration (the stand-in, §13.5).
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('set-role-analyst').selectOption('viewer');
      await page.getByTestId('control-panel-toggle').click();
      // At the next request (FR-116): play, and the CO₂ source is refused, then left out; the record greyed.
      await page.getByTestId('dc-rate-10').click();
      await play(page);
      await expect.poll(() => chipLabels(page), { timeout: 30_000 }).not.toContain('CO₂');
      await pause(page);
      await expect(page.getByTestId('dc-login')).toHaveCount(0); // not logged out
      await page.getByTestId('favourites-button').click();
      const rec = page.getByTestId('doi-item').filter({ hasText: 'Engine' });
      await expect(rec).toHaveAttribute('data-greyed', 'true', { timeout: 30_000 });
      await expect(rec).toContainText('No longer permitted');
    });

    test(`lock on the button and after inactivity: blanked, credentials gone, no request; unlocking restores the place (AT-50, FR-99), ${backend}`, async ({ page }) => {
      const log = clientLog(page);
      await open(page, backend, '&idle=6');
      await login(page);
      const humid = page.getByTestId('chip').filter({ hasText: 'Bow · Humidity' });
      await humid.click();
      await expect(humid).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('preset-6h').click();
      await page.getByTestId('dc-rate-100').click();
      await play(page);
      await page.waitForTimeout(2000);
      await page.getByTestId('dc-lock').click();
      await expect(page.getByTestId('dc-locked')).toBeVisible();
      await expect(page.getByTestId('analyst-state')).toHaveText('Locked');
      await expect(page.getByTestId('play')).toBeDisabled();
      expect(await monitorText(page)).not.toMatch(/MISSION|mission-|Humidity/);
      await page.waitForTimeout(1000);
      const t = Date.now();
      await page.waitForTimeout(4000);
      expect(since(log, t)).toEqual([]);
      // Unlocking needs the password again, and restores the place: the dataset, the time, the field and the period.
      await page.getByTestId('login-password').fill('demo-owner');
      await page.getByTestId('login-submit').click();
      await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
      await expect(page.getByTestId('chip').filter({ hasText: 'Bow · Humidity' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('preset-6h')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('dataset-button')).toContainText(A);
      expect(Date.parse((await bar(page).getAttribute('data-time'))!)).toBeGreaterThan(Date.parse('2031-04-07T00:01:00Z'));
      // After inactivity (6 s here, 5 minutes by default): locked, blanked, and nothing more is sent.
      await expect(page.getByTestId('dc-locked')).toBeVisible({ timeout: 20_000 });
      expect(await monitorText(page)).not.toMatch(/MISSION|mission-|Humidity/);
      const t2 = Date.now();
      await page.waitForTimeout(3000);
      expect(since(log, t2)).toEqual([]);
    });

    test(`Favourites: save the current window, open it exactly after switching dataset, compare on elapsed time, refuse a missing resolution, remove; Reset instance empties the list (AT-45 to AT-48), ${backend}`, async ({ page }) => {
      await open(page, backend);
      await login(page);
      await results(page);
      await page.getByTestId('dc-rate-100').click();
      await play(page);
      await page.waitForTimeout(4000);
      await pause(page);
      await page.getByTestId('preset-1m').click();
      const star = page.getByTestId('favourites-button');
      await expect(star).toHaveAttribute('data-saved', 'false');
      await star.click();
      const pop = page.getByTestId('favourites-popup');
      // FR-104: the top shows the current data window.
      await expect(pop.getByTestId('window-dataset')).toHaveText(A);
      await expect(pop.getByTestId('window-resolution')).toHaveText('PT1S');
      await expect(pop.getByTestId('window-fields')).toContainText('Bow · Air temperature');
      // AT-47: a resolution no datastream holds is refused, naming those that do.
      await page.getByTestId('doi-label').fill('Bad');
      await page.getByTestId('doi-resolution').fill('PT10M');
      await page.getByTestId('doi-save').click();
      await expect(page.getByTestId('doi-error')).toContainText('No datastream holds PT10M');
      await expect(page.getByTestId('doi-error')).toContainText('PT1S, PT1M, PT1H');
      // Save a minute of readings.
      await page.getByTestId('doi-label').fill('Last minute');
      await page.getByTestId('doi-note').fill('a gust');
      await page.getByTestId('doi-resolution').fill('PT1S');
      await page.getByTestId('doi-save').click();
      await expect(page.getByTestId('doi-item').filter({ hasText: 'Last minute' })).toBeVisible();
      await expect(star).toHaveAttribute('data-saved', 'true');
      // Opening one closes the popup and draws it, labelled with its dataset and span.
      await page.getByTestId('doi-item').filter({ hasText: 'Last minute' }).getByTestId('doi-open').click();
      await expect(pop).toHaveCount(0);
      const opened = page.getByTestId('doi-opened');
      await expect(opened).toBeVisible();
      await expect(opened).toContainText(A);
      const sum1 = await opened.getAttribute('data-checksum');
      // And the same span and more at 1-minute resolution.
      await page.getByTestId('preset-6h').click();
      await star.click();
      await expect(pop.getByTestId('window-resolution')).toHaveText('PT1M');
      await page.getByTestId('doi-label').fill('Minutes');
      await page.getByTestId('doi-save').click();
      await expect(page.getByTestId('doi-item').filter({ hasText: 'Minutes' })).toBeVisible();
      await page.keyboard.press('Escape');
      // AT-45: after switching dataset, the record regenerates exactly the same values.
      await openFile(page, C);
      await star.click();
      await page.getByTestId('doi-item').filter({ hasText: 'Last minute' }).getByTestId('doi-open').click();
      await expect(page.getByTestId('doi-opened')).toHaveAttribute('data-checksum', sum1!);
      await expect(page.getByTestId('doi-opened')).toContainText(A);
      // AT-46: compared on elapsed time, at the coarser resolution, labelled "elapsed".
      await star.click();
      await page.getByTestId('doi-item').filter({ hasText: 'Last minute' }).getByTestId('doi-pick').check();
      await page.getByTestId('doi-item').filter({ hasText: 'Minutes' }).getByTestId('doi-pick').check();
      await page.getByTestId('doi-compare-button').click();
      const cmp = page.getByTestId('doi-compare');
      await expect(cmp).toBeVisible();
      await expect(cmp).toContainText('elapsed');
      await expect(cmp).toContainText('at PT1M');
      // FR-105: remove.
      await star.click();
      await page.getByTestId('doi-item').filter({ hasText: 'Minutes' }).getByTestId('doi-remove').click();
      await expect(page.getByTestId('doi-item').filter({ hasText: 'Minutes' })).toHaveCount(0);
      await expect(page.getByTestId('doi-item')).toHaveCount(1);
      await page.keyboard.press('Escape');
      // AT-48: after Reset instance the list is empty, and importing the file again restores nothing.
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('reset-instance').click();
      await expect(page.getByTestId('reset-confirm')).toContainText('data of interest');
      await page.getByTestId('reset-confirm-yes').click();
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('restart-client').click();
      await page.getByTestId('card-client').click();
      await page.getByTestId('demo-login-owner').click();
      await expect(page.getByTestId('dc-no-dataset')).toBeVisible({ timeout: SLOW });
      await expect(page.getByTestId('dataset-button')).toContainText('Choose a dataset');
      await star.click();
      await expect(page.getByTestId('doi-empty')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByTestId('dataset-button').click();
      await expect(page.locator(`[data-testid="dataset-row"][data-file="${A}"]`)).toHaveAttribute('data-status', 'not-imported');
      await page.getByTestId(`open-${A}`).click();
      await viewing(page, A);
      await star.click();
      await expect(page.getByTestId('doi-empty')).toBeVisible();
      await expect(page.getByTestId('doi-item')).toHaveCount(0);
    });
  });
}
