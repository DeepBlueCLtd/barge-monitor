import { expect, Page, test } from '@playwright/test';

// The demonstrator shell (plan Phase 8; SRD §9 but §9.8, §7.3, §7.4, FR-79a; docs/v4-interfaces.md §1 to §3, §13),
// in both back ends: the JavaScript stand-in and the Python back end in Pyodide. One page per back end, its tests in
// order: the flowchart, the reveal, stand-in visibility, the detail panels, the capture (AT-18), the control panel,
// then every failure demo, each ending with "Put everything back", and Reset instance last (it removes Mission A
// until the page is reloaded). Every request goes through the Service Worker relay.
const SLOW = 300_000;
const URN = 'urn:x-barge:';
const SWE = 'application/swe%2Bjson';
const A = 'MISSION_A_20310407.csv';
const B = 'MISSION_B_20310414.csv';
const BX = 'MISSION_B_20310414_REEXPORT.csv';
const C = 'MISSION_C_20310421.csv';
const DEMO = { owner: 'demo-owner', friend: 'demo-friend' };
type User = keyof typeof DEMO;

/** SRD §3.1 (4.7): every directed flow, and how its arrow is labelled where it carries one (FR-65). */
const FLOWS = ['importer>folder', 'folder>importer', 'importer>server', 'server>importer', 'client>server', 'server>client',
  'server>models', 'models>server', 'models>scilibs', 'scilibs>models'];
const LABELS: Record<string, string> = {
  'server>client': 'HTTP', 'models>server': 'HTTP', 'server>models': 'HTTP · push', 'server>importer': 'push', 'importer>server': 'inside the server',
};
const CARDS = ['client', 'scilibs', 'server', 'models', 'importer', 'folder'];
const DEMOS = ['down', 'restart', 'essential', 'extra', 'lie', 'password', 'lock', 'overlap', 'degraded', 'friend', 'crafted'];

async function call(page: Page, method: string, path: string, user: User | null = 'owner', body?: unknown): Promise<{ status: number; text: string }> {
  const auth = user ? 'Basic ' + Buffer.from(`${user}:${DEMO[user]}`).toString('base64') : null;
  return page.evaluate(async ({ method, path, auth, body }) => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    return { status: r.status, text: await r.text() };
  }, { method, path, auth, body });
}

async function get(page: Page, path: string, user: User = 'owner') {
  const a = await call(page, 'GET', path, user);
  expect(a.status, path).toBe(200);
  return JSON.parse(a.text);
}

/** A readiness poll: a refused or failed fetch means "poll again" (2694b00). */
async function getOrNull(page: Page, path: string) {
  try {
    const a = await call(page, 'GET', path);
    return a.status === 200 ? JSON.parse(a.text) : null;
  } catch {
    return null;
  }
}

async function systems(page: Page): Promise<Map<string, string>> {
  const j = await get(page, 'api/systems?searchMembers=true&f=application/sml%2Bjson&limit=1000');
  return new Map(j.items.map((s: any) => [s.uniqueId, s.id]));
}

async function datastreams(page: Page, uid: string): Promise<any[]> {
  return (await get(page, `api/systems/${(await systems(page)).get(uid)}/datastreams?limit=1000`)).items;
}

async function schemaFields(page: Page, id: string): Promise<string[]> {
  return (await get(page, `api/datastreams/${id}/schema?obsFormat=${SWE}`)).recordSchema.fields.map((f: any) => f.name);
}

const captured = (page: Page): Promise<Record<string, number>> => page.evaluate(() => (globalThis as any).bargeCaptured());
const status = (page: Page, id: string) => page.getByTestId(`${id}-state`);
const banner = (page: Page) => page.getByTestId('demo-banner');

async function login(page: Page, user: User = 'owner') {
  await page.getByTestId('card-client').click();
  await page.getByTestId(`demo-login-${user}`).click();
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
}

/** AT-67 ("says why"): every disabled top-bar control gives a non-empty reason, in its title and to assistive technology. */
async function everyDisabledControlSaysWhy(page: Page): Promise<number> {
  const found = await page.getByTestId('controls').locator('button').evaluateAll((els) => els.map((e) => {
    const b = e as HTMLButtonElement;
    const ids = (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return { label: b.textContent?.trim() ?? '', disabled: b.disabled, title: b.title,
      described: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ') };
  }));
  const disabled = found.filter((c) => c.disabled);
  for (const c of disabled) {
    expect(c.title, `${c.label}: title`).not.toBe('');
    expect(c.described, `${c.label}: aria-describedby`).not.toBe('');
  }
  return disabled.length;
}

/** The demo's banner, after its step has run. */
async function stepDone(page: Page) {
  await expect(banner(page)).toHaveAttribute('data-running', 'false', { timeout: SLOW });
}

async function startDemo(page: Page, id: string) {
  await expect(page.getByTestId('demo-menu')).toBeEnabled({ timeout: SLOW });
  await page.getByTestId('demo-menu').click();
  await page.getByTestId(`demo-${id}`).click();
  await expect(banner(page)).toHaveAttribute('data-demo', id);
  await stepDone(page);
}

async function nextStep(page: Page) {
  await page.getByTestId('demo-next').click();
  await stepDone(page);
}

/**
 * "Put everything back" (AT-31): the banner goes, the server runs and is honest, and the display client is restored:
 * the owner logged in, configured, Mission A open, nothing missing and nothing refused.
 */
async function putBack(page: Page) {
  await page.getByTestId('demo-reset').click();
  await expect(banner(page)).toHaveCount(0, { timeout: SLOW });
  await expect(status(page, 'server')).toContainText('Ready');
  await expect(status(page, 'analyst')).toHaveText('owner', { timeout: SLOW });
  await expect(status(page, 'client')).toHaveText('Configured', { timeout: SLOW });
  await expect(page.getByTestId('dataset-button')).toContainText(A, { timeout: SLOW });
  await expect(page.getByTestId('dc-rejected')).toHaveCount(0);
  await expect(page.getByTestId('dc-degraded')).toHaveCount(0);
  await expect(status(page, 'essentials')).toHaveText('All present');
  const st = await page.evaluate(() => (globalThis as any).bargeControlState?.());
  if (st) {
    expect(st.lie_about_profile).toBe(false);
    expect(st.pending).toBe(false);
  }
}

for (const backend of ['standin', 'python'] as const) {
  const name = backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in';
  test.describe(`the shell, ${name}`, () => {
    test.describe.configure({ mode: 'serial' });
    let page: Page;
    const errors: string[] = [];
    const foreign: string[] = [];

    test.beforeAll(async ({ browser }, info) => {
      const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1920, height: 1080 } });
      page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      // NFR-06 (AT-23): nothing is fetched from another origin.
      page.on('request', (r) => !r.url().startsWith(new URL(info.project.use.baseURL!).origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:') && foreign.push(r.url()));
      await page.goto(`demo/?backend=${backend}`);
      await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW });
      // In Python mode the models start in their own workers after the server: wait until they are live.
      await expect.poll(async () => (await getOrNull(page, 'api/systems?searchMembers=true&f=application/sml%2Bjson&limit=1000'))?.items
        ?.some((s: any) => s.uniqueId === URN + 'process:analysis') ?? false, { timeout: SLOW, intervals: [1000] }).toBe(true);
    });

    test.afterAll(async () => {
      await page.context().close();
    });

    test(`the flowchart: four zones, the six 4.7 cards, every flow of §3.1 drawn and labelled; the god's-eye note, status and key (FR-64, FR-65, FR-68a, AT-21, AT-23), ${backend}`, async () => {
      for (const z of ['front', 'third', 'back', 'legacy']) await expect(page.locator(`[data-zone="${z}"]`)).toHaveCount(1);
      await expect(page.locator('[data-zone]')).toHaveCount(4);
      for (const c of CARDS) await expect(page.getByTestId(`card-${c}`)).toBeVisible();
      await expect(page.locator('[data-testid^="card-"]')).toHaveCount(CARDS.length);
      // The 4.1 platform, logger store and store adapter are retired (D-320); no replay controller, no gateway (4.7).
      for (const gone of ['platform', 'store', 'adapter', 'replay', 'gateway']) await expect(page.getByTestId(`card-${gone}`)).toHaveCount(0);
      const drawn = await page.locator('[data-flow]').evaluateAll((els) => els.map((e) => e.getAttribute('data-flow')));
      expect(drawn.sort()).toEqual([...FLOWS].sort());
      for (const [flow, label] of Object.entries(LABELS)) await expect(page.getByTestId(`flow-label-${flow}`)).toHaveText(label);
      // AT-21: every card and flow is drawn with the sketch renderer, seeded by its name.
      for (const c of CARDS) await expect(page.locator(`[data-sketch="card:${c}"]`)).toHaveCount(1);
      for (const f of FLOWS) await expect(page.locator(`[data-sketch="flow:${f}"]`)).toHaveCount(1);
      // FR-68a: the god's-eye note, and what is counted but not drawn (D-321).
      await expect(page.getByTestId('gods-eye')).toContainText('God’s-eye view');
      await expect(page.getByTestId('gods-eye')).toContainText('CO₂ traffic included');
      await expect.poll(async () => Number(await page.getByTestId('counted-not-drawn').getAttribute('data-count'))).toBeGreaterThan(1000);
      // The message key names the letters as SRD §5 does.
      await expect(page.getByTestId('key-S')).toContainText('File request, internal');
      await expect(page.getByTestId('key-L')).toContainText('Legacy CSV');
      // Status (§9.1) before login: nothing plays, every disabled control says why (FR-125a).
      await expect(status(page, 'analyst')).toHaveText('Not logged in');
      await expect(status(page, 'dataset')).toHaveText('None');
      await expect(status(page, 'server')).toHaveText(/^Ready · start 1$/);
      await expect(status(page, 'backend')).toHaveText(backend === 'python' ? 'Python' : 'JavaScript stand-in');
      expect(await everyDisabledControlSaysWhy(page)).toBeGreaterThanOrEqual(6);
      // No Freeze (4.7); Restart client and Restart server are in the top bar.
      await expect(page.getByTestId('controls')).not.toContainText('Freeze');
      await expect(page.getByTestId('restart-client')).toBeEnabled();
      await expect(page.getByTestId('restart-server')).toBeEnabled();
      expect(foreign).toEqual([]);
    });

    test(`the value-add reveal: only Models and the display client ever turn gold (AT-20, FR-74 to FR-76), ${backend}`, async () => {
      const gold = () => page.locator('[data-testid^="card-"][data-revealed="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(await gold()).toEqual([]);
      for (const c of ['server', 'importer', 'folder', 'scilibs']) {
        await page.getByTestId(`card-${c}`).click();
        await expect(page.getByTestId('detail-title')).not.toContainText('★');
      }
      expect(await gold()).toEqual([]);
      // The display client before login: its panel shows the login screen, and it is not revealed.
      await page.getByTestId('card-client').click();
      await expect(page.getByTestId('dc-login')).toBeVisible();
      expect(await gold()).toEqual([]);
      // Models: revealed by the first click (FR-75), the outline unchanged (AT-21: seeded by its name).
      const outline = await page.locator('[data-sketch="card:models"] path').first().getAttribute('d');
      await page.getByTestId('card-models').click();
      await expect(page.getByTestId('card-models')).toHaveAttribute('data-revealed', 'true');
      await expect(page.getByTestId('role-models')).toContainText('our value-add');
      expect(await page.locator('[data-sketch="card:models"] path').first().getAttribute('d')).toBe(outline);
      // The display client: revealed once its views show in its panel.
      await login(page);
      await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'true');
      expect((await gold()).sort()).toEqual(['card-client', 'card-models']);
      for (const c of ['server', 'importer', 'folder', 'scilibs']) await page.getByTestId(`card-${c}`).click();
      expect((await gold()).sort()).toEqual(['card-client', 'card-models']);
      // Restart client un-reveals (FR-75) and returns to the login screen with nothing kept (FR-46).
      await page.getByTestId('restart-client').click();
      expect(await gold()).toEqual([]);
      await page.getByTestId('card-client').click();
      await expect(page.getByTestId('dc-login')).toBeVisible();
      await expect(status(page, 'analyst')).toHaveText('Not logged in');
      await login(page);
    });

    test(`stand-in visibility and parity: the notice, the tags, the model editor; the same shell in both back ends (AT-25, AT-26, FR-06f, FR-06h), ${backend}`, async () => {
      if (backend === 'standin') {
        await expect(page.getByTestId('standin-notice')).toContainText('Running the JavaScript stand-in');
        for (const c of ['server', 'importer', 'models', 'scilibs']) await expect(page.getByTestId(`card-${c}`).getByTestId('standin-tag')).toBeVisible();
      } else {
        await expect(page.getByTestId('standin-notice')).toHaveCount(0);
        await expect(page.getByTestId('card-server').getByTestId('standin-tag')).toBeVisible(); // a stand-in for OpenSensorHub either way (FR-06j)
        for (const c of ['importer', 'models', 'scilibs']) await expect(page.getByTestId(`card-${c}`).getByTestId('standin-tag')).toHaveCount(0);
      }
      for (const c of ['client', 'folder']) await expect(page.getByTestId(`card-${c}`).getByTestId('standin-tag')).toHaveCount(0);
      await page.getByTestId('card-models').click();
      await page.getByTestId('model-new-model-2').click();
      if (backend === 'standin') await expect(page.getByTestId('editor-unavailable')).toContainText('The model editor is unavailable here');
      else await expect(page.getByTestId('model-editor')).toBeVisible();
      await page.getByTestId('model-new-model-2').click();
      await page.getByTestId('detail-close').click();
      // AT-26: the same shell over either back end: the same demos, the same switches, the same folder as catalogued.
      await page.getByTestId('demo-menu').click();
      const demos = await page.locator('[data-testid^="demo-"][role="menuitem"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(5)));
      expect(demos).toEqual(DEMOS);
      await page.keyboard.press('Escape');
      await page.getByTestId('control-panel-toggle').click();
      const fields = await page.getByTestId('fields-table').locator('tr[data-field]').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')));
      expect(fields).toEqual(['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure', 'apparent_wind_direction', 'solar_irradiance',
        'water_temperature', 'dew_point', 'bow_minus_stern', 'pressure_tendency_3h', 'readings_removed']);
      await expect(page.getByTestId('admin-stub')).toContainText('OpenSensorHub administration (stand-in)');
      await page.getByTestId('control-panel-close').click();
      await page.getByTestId('card-folder').click();
      const files = await page.getByTestId('folder-table').locator('tr[data-file]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-file')}:${e.getAttribute('data-status')}`));
      expect(files).toEqual([`${A}:imported`, `${B}:not-imported`, `${BX}:not-imported`, `${C}:not-imported`]);
    });

    test(`each detail panel opens with its content (FR-69 to FR-73, FR-109, FR-110), ${backend}`, async () => {
      await page.getByTestId('card-client').click();
      await expect(page.getByTestId('monitor')).toBeVisible();
      await expect(page.locator('.client-detail .notes')).toContainText('Favourites');
      await expect(page.getByTestId('message-strip')).toBeVisible();
      await page.getByTestId('card-models').click();
      await expect(page.getByTestId('detail-models')).toBeVisible();
      for (const m of ['data-cleanse', 'summaries', 'analysis']) await expect(page.getByTestId(`phase-${m}`)).toContainText('live', { timeout: SLOW });
      const a = (await page.getByTestId('model-outputs').locator('tr[data-dataset]').first().getAttribute('data-dataset'))!;
      expect(a).toMatch(/^mission-a-20310407-/);
      for (const m of ['data-cleanse', 'summaries', 'analysis']) {
        await expect(page.getByTestId(`outputs-${m}-${a}`)).toContainText(/[1-9]\d* outputs/);
        await expect(page.locator(`[data-testid="model-run"][data-run="${m}-${a}-1"]`)).toHaveAttribute('data-status', 'complete');
      }
      await page.getByTestId('card-server').click();
      await expect(page.getByTestId('server-osh')).toContainText('OpenSensorHub');
      await expect(page.getByTestId('server-osh')).toContainText('stand-in');
      await expect(page.locator(`[data-testid="server-datasets"] tr[data-dataset="${a}"]`)).toContainText(A);
      await expect(page.getByTestId('server-also')).toContainText('CSV importer');
      await expect(page.getByTestId('server-also')).toContainText('Workspaces');
      await expect(page.getByTestId('server-auth')).toContainText('401');
      await expect(page.getByTestId('server-auth')).toContainText('403');
      await expect(page.getByTestId('server-auth')).toContainText('listed');
      await expect(page.getByTestId('server-accounts')).toContainText('friend');
      await expect(page.getByTestId('server-gaps')).toContainText('Gaps');
      await expect(page.getByTestId('server-unused')).toContainText('Not used');
      await page.getByTestId('card-folder').click();
      await expect(page.getByTestId('folder-table').locator('tr[data-file]')).toHaveCount(4);
      await expect(page.getByTestId('folder-never-written')).toContainText('never writes');
      await page.getByTestId('card-importer').click();
      await expect(page.getByTestId('importer-catalogue')).toContainText(A);
      await expect(page.getByTestId('column-mapping')).toContainText('T_HS94');
      await expect(page.getByTestId('import-rate')).toContainText(/MISSION_A_20310407\.csv, 86,400 rows .* rows\/s \(silently, at startup\)/);
      await expect(page.getByTestId('silent-import')).toContainText('silently');
      await expect(page.getByTestId('detail-title')).toHaveText('CSV importer'); // not marked as value-add (FR-74)
      await page.getByTestId('card-scilibs').click();
      await expect(page.getByTestId('detail-scilibs')).toContainText('numpy');
      await expect(page.getByTestId('counters')).toContainText('Models');
      await page.getByTestId('overview-button').click();
      await expect(page.getByTestId('written')).toContainText('CSV importer');
      await expect(page.getByTestId('written')).toContainText('Models');
      await expect(page.getByTestId('written')).toContainText('Display client');
      await expect(page.getByTestId('adopted')).toContainText('Authentication and permissions');
    });

    test(`AT-18: every boundary of §3.1 produces captured messages; outputs are identical with capture on and off, ${backend}`, async () => {
      test.setTimeout(SLOW * 2);
      // An import asked for over HTTP: the importer's flows (the silent one is counted, not drawn), and the models process it.
      const imp = (await systems(page)).get(URN + 'importer');
      const cs = (await get(page, `api/systems/${imp}/controlstreams`)).items.find((c: any) => c.inputName === 'import');
      expect((await call(page, 'POST', `api/controlstreams/${cs.id}/commands`, 'owner', { parameters: { action: 'import', file: C } })).status).toBe(200);
      await expect.poll(async () => {
        const counts = await captured(page);
        return FLOWS.filter((f) => !Object.keys(counts).some((k) => k.startsWith(f + ':')));
      }, { timeout: SLOW, intervals: [1000] }).toEqual([]);
      const counts = await captured(page);
      expect(counts['importer>server:I']).toBeGreaterThanOrEqual(44); // one per 1,000 rows (FR-67), and the catalogue
      expect(counts['server>importer:K']).toBeGreaterThanOrEqual(1);
      // Wait until the models have processed Mission C, so nothing moves while the outputs are compared.
      await expect.poll(async () => {
        const items = await datastreams(page, URN + 'importer');
        const cat = items.find((d: any) => d.outputName === 'catalogue');
        const rows = await get(page, `api/datastreams/${cat.id}/observations?f=${SWE}&limit=100000`);
        return rows.filter((r: any) => r.file === C && r.status === 'imported').map((r: any) => r.dataset).pop() ?? null;
      }, { timeout: SLOW, intervals: [1000] }).not.toBeNull();
      await page.getByTestId('card-models').click();
      await expect.poll(async () => page.locator('[data-testid="model-run"][data-status="processing"]').count(), { timeout: SLOW, intervals: [1000] }).toBe(0);
      await expect.poll(async () => page.locator('[data-testid="model-run"][data-status="complete"]').count(), { timeout: SLOW }).toBeGreaterThanOrEqual(6);
      const outputs = async () => {
        const out: string[] = [];
        for (const [uid, prefix] of [[URN + 'sensor:stern', 'weather__mission-c'], [URN + 'process:summaries', 'summary-1min-bow__mission-c'],
          [URN + 'process:data-cleanse', 'runs__mission-c']]) {
          const d = (await datastreams(page, uid)).find((x: any) => x.outputName.startsWith(prefix));
          expect(d, prefix).toBeTruthy();
          out.push((await call(page, 'GET', `api/datastreams/${d.id}/observations?f=${SWE}&limit=500`)).text);
        }
        return out;
      };
      const on = await outputs();
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('capture-toggle').click();
      await expect(page.getByTestId('capture-toggle')).not.toBeChecked();
      const before = await captured(page);
      const off = await outputs();
      await page.waitForTimeout(1500);
      expect(await captured(page)).toEqual(before); // nothing captured, nothing drawn
      expect(off).toEqual(on);
      await page.getByTestId('capture-toggle').click();
      await page.getByTestId('control-panel-close').click();
      await outputs();
      await expect.poll(async () => (await captured(page))['client>server:Q'] ?? 0).toBeGreaterThan(before['client>server:Q'] ?? 0);
      // FR-16a, FR-68: a clicked message shows no credential.
      const text = JSON.stringify(await page.evaluate(() => (globalThis as any).bargeMessages()));
      for (const p of Object.values(DEMO)) expect(text).not.toContain(p);
      expect(text).toContain('****');
    });

    test(`the control panel: down and up; a field toggle changes nothing until the next server start (AT-11, AT-12, FR-49, FR-50), ${backend}`, async () => {
      test.setTimeout(SLOW * 2);
      await page.getByTestId('card-client').click();
      await page.getByTestId('dc-play').click();
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('server-down').click();
      await expect(page.getByTestId('drawer-server-state')).toContainText('Server down');
      await expect(status(page, 'server')).toHaveText('Down');
      await expect(page.getByTestId('dc-unreachable')).toBeVisible({ timeout: 30_000 }); // stale, said so (AT-11)
      await expect(status(page, 'client')).toHaveText('Server unreachable');
      await expect(page.locator('[data-testid="message-icon"].failed').first()).toBeAttached({ timeout: 10_000 }); // stopped at the boundary
      await page.getByTestId('server-up').click();
      await expect(status(page, 'server')).toHaveText(/^Ready · start 2$/, { timeout: SLOW });
      await expect(status(page, 'client')).toHaveText('Configured', { timeout: SLOW }); // a fresh handshake
      await expect(page.getByTestId('dc-unreachable')).toHaveCount(0);
      // AT-12: switch humidity off. Nothing changes until the next server start.
      const weather = (await datastreams(page, URN + 'sensor:bow')).find((d: any) => d.outputName.startsWith('weather__mission-a')).id;
      await page.getByTestId('field-relative_humidity').click();
      await expect(page.getByTestId('pending')).toBeVisible();
      await expect(page.locator('tr[data-field="relative_humidity"]')).toHaveAttribute('data-now', 'true');
      await expect(page.locator('tr[data-field="relative_humidity"]')).toHaveAttribute('data-next', 'false');
      await expect(page.locator('tr[data-field="dew_point"]')).toHaveAttribute('data-next', 'false'); // its input is off (FR-52)
      await page.waitForTimeout(1500);
      expect(await schemaFields(page, weather)).toContain('relative_humidity');
      await expect(page.getByTestId('chips')).toContainText('Bow · Humidity');
      await page.getByTestId('restart-server').click();
      await expect.poll(async () => (await getOrNull(page, `api/datastreams/${weather}/schema?obsFormat=${SWE}`))?.recordSchema?.fields
        ?.map((f: any) => f.name).includes('relative_humidity') ?? 'starting', { timeout: SLOW, intervals: [500] }).toBe(false);
      await expect(page.getByTestId('pending')).toHaveCount(0);
      await page.getByTestId('field-relative_humidity').click();
      await expect(page.getByTestId('pending')).toBeVisible();
      await page.getByTestId('restart-server').click();
      await expect.poll(async () => (await getOrNull(page, `api/datastreams/${weather}/schema?obsFormat=${SWE}`))?.recordSchema?.fields
        ?.map((f: any) => f.name).includes('relative_humidity') ?? 'starting', { timeout: SLOW, intervals: [500] }).toBe(true);
      await expect(page.getByTestId('pending')).toHaveCount(0);
      await page.getByTestId('control-panel-close').click();
      await page.getByTestId('card-client').click();
      if ((await page.getByTestId('replay-bar').getAttribute('data-playing')) === 'true') await page.getByTestId('dc-play').click();
      await expect(status(page, 'client')).toHaveText('Configured', { timeout: SLOW });
    });

    // --- every failure demo of FR-79a (4.7), each with its banner and "Put everything back" (AT-31) -------------------
    test(`failure demo "the server goes down": no answer, the client stale; up again, a fresh handshake (AT-11, AT-31), ${backend}`, async () => {
      await startDemo(page, 'down');
      await expect(page.getByTestId('demo-watch')).toContainText('stop at the boundary');
      await expect(status(page, 'server')).toHaveText('Down');
      await expect(page.getByTestId('dc-unreachable')).toBeVisible({ timeout: 30_000 });
      await nextStep(page);
      await expect(page.getByTestId('demo-watch')).toContainText('repeats its handshake');
      await expect(status(page, 'server')).toContainText('Ready', { timeout: SLOW });
      await expect(status(page, 'client')).toHaveText('Configured', { timeout: SLOW });
      await expect(page.getByTestId('dc-unreachable')).toHaveCount(0);
      await putBack(page);
    });

    test(`failure demo "the server restarts": refused while it starts, then answering again (FR-47, FR-48, AT-31), ${backend}`, async () => {
      const before = Number((await status(page, 'server').innerText()).match(/start (\d+)/)![1]);
      await startDemo(page, 'restart');
      await expect(page.getByTestId('demo-watch')).toContainText('refuses connections');
      await expect(status(page, 'server')).toHaveText(new RegExp(`^Ready · start ${before + 1}$`), { timeout: SLOW });
      await expect(status(page, 'client')).toHaveText('Configured', { timeout: SLOW });
      await putBack(page);
    });

    test(`failure demo "an essential source is missing": the dataset opens degraded, naming what is missing (FR-45, AT-31), ${backend}`, async () => {
      await startDemo(page, 'essential');
      await expect(page.getByTestId('demo-watch')).toContainText('opens the dataset degraded');
      await expect(page.getByTestId('dc-degraded')).toContainText('Bow air temperature', { timeout: SLOW });
      await expect(page.getByTestId('dc-degraded')).toContainText('Stern air temperature');
      await expect(status(page, 'client')).toHaveText('Degraded');
      await putBack(page);
      await expect(page.getByTestId('chips')).toContainText('Bow · Air temperature');
    });

    test(`failure demo "fields the client has never seen": new chips after a client restart, drawn by type (FR-50, AT-09, AT-31), ${backend}`, async () => {
      await startDemo(page, 'extra');
      await expect(page.getByTestId('demo-watch')).toContainText('never told about');
      await nextStep(page);
      await expect(page.getByTestId('demo-watch')).toContainText('drawn by its schema type');
      await expect(page.getByTestId('chips')).toContainText('Pressure tendency', { timeout: SLOW });
      await expect(page.getByTestId('chips')).toContainText('Readings removed');
      await putBack(page);
      await expect(page.getByTestId('chips')).not.toContainText('Pressure tendency');
    });

    test(`failure demo "a misconfigured server": the catalogue without its status, still claiming the profile; the client refuses it (D-210, AT-08, AT-31), ${backend}`, async () => {
      await startDemo(page, 'lie');
      await expect(page.getByTestId('demo-watch')).toContainText('refuses the server at the handshake');
      await expect(page.getByTestId('dc-rejected')).toContainText('Archive catalogue', { timeout: SLOW });
      await expect(status(page, 'client')).toHaveText('Server rejected');
      await expect(page.getByTestId('chips')).toHaveCount(0);
      await putBack(page); // restarts the client that refused the server (D-210)
    });

    test(`failure demo "a wrong password": refused, saying only that, nothing shown (FR-101, AT-31), ${backend}`, async () => {
      await startDemo(page, 'password');
      await expect(page.getByTestId('demo-watch')).toContainText('not which');
      await expect(page.getByTestId('login-error')).toHaveText('The name or password is wrong.');
      await expect(page.getByTestId('monitor')).not.toContainText(/MISSION|mission-/);
      await expect(status(page, 'analyst')).toHaveText('Not logged in');
      await putBack(page);
    });

    test(`failure demo "the screen locks": views blank, credentials gone, login needed (FR-99, AT-50, AT-31), ${backend}`, async () => {
      await startDemo(page, 'lock');
      await expect(page.getByTestId('demo-watch')).toContainText('the display client locks');
      // Hands off: no input for five seconds locks the client.
      await expect(page.getByTestId('dc-locked')).toBeVisible({ timeout: 30_000 });
      await expect(status(page, 'analyst')).toHaveText('Locked');
      await expect(page.getByTestId('monitor')).not.toContainText(/MISSION|mission-/);
      await expect(page.getByTestId('chips')).toHaveCount(0);
      await putBack(page);
    });

    test(`failure demo "an overlapping file": Mission B and its re-export imported side by side, never mixed (FR-21b, AT-42, AT-31), ${backend}`, async () => {
      test.setTimeout(SLOW * 3);
      await startDemo(page, 'overlap');
      await expect(page.getByTestId('dataset-button')).toContainText(B, { timeout: SLOW });
      await nextStep(page);
      await expect(page.getByTestId('demo-watch')).toContainText('never mixed');
      await expect(page.getByTestId('dataset-button')).toContainText(BX, { timeout: SLOW });
      const bow = await datastreams(page, URN + 'sensor:bow');
      const weathers = bow.filter((d: any) => /^weather__mission-b-20310414/.test(d.outputName)).map((d: any) => d.outputName);
      expect(weathers.length).toBe(2); // each in its own datastream
      expect(new Set(weathers).size).toBe(2);
      await page.getByTestId('card-folder').click();
      await expect(page.locator(`[data-testid="folder-table"] tr[data-file="${B}"]`)).toHaveAttribute('data-status', 'imported');
      await expect(page.locator(`[data-testid="folder-table"] tr[data-file="${BX}"]`)).toHaveAttribute('data-status', 'imported');
      await putBack(page);
    });

    test(`failure demo "a degraded dataset": Mission C opens degraded; Mission A does not (FR-45, AT-07, AT-31), ${backend}`, async () => {
      await startDemo(page, 'degraded');
      await expect(page.getByTestId('dataset-button')).toContainText(C, { timeout: SLOW });
      await expect(page.getByTestId('dc-degraded')).toContainText('Stern wind speed', { timeout: SLOW });
      await expect(page.getByTestId('demo-watch')).toContainText('no stern wind speed column');
      await putBack(page); // Mission A again, not degraded
    });

    test(`failure demo "the friend logs in": no CO₂ anywhere in the client, nor in its traffic (FR-118, AT-55, AT-31), ${backend}`, async () => {
      await startDemo(page, 'friend');
      await expect(status(page, 'analyst')).toHaveText('friend');
      await expect(page.getByTestId('chips')).toBeVisible();
      await expect(page.getByTestId('chips')).not.toContainText(/CO₂|co2/i);
      await expect(page.getByTestId('monitor')).not.toContainText(/CO₂/);
      await expect(page.getByTestId('demo-watch')).toContainText('god’s-eye view');
      // The client's own messages since the friend logged in carry no CO₂ value or schema.
      const msgs = await page.evaluate(() => (globalThis as any).bargeMessages() as { src: string; dst: string; content: string; chain?: string }[]);
      // The friend's session is the latest: each login's requests carry chains dc<n>- of its own (client/http.ts).
      const session = (m: { chain?: string }) => Number(/^dc(\d+)-/.exec(m.chain ?? '')?.[1] ?? -1);
      const latest = Math.max(...msgs.map(session));
      const friend = msgs.filter((m) => m.dst === 'client' && session(m) === latest);
      expect(friend.length).toBeGreaterThan(5);
      expect(friend.filter((m) => /"co2"\s*:|"name"\s*:\s*"co2"/.test(m.content))).toEqual([]);
      await putBack(page);
      await expect(page.getByTestId('chips')).toContainText('CO₂'); // the owner sees CO₂ again
    });

    test(`failure demo "the friend asks for CO₂": 403 from the server, and the model rejects the command (FR-93, FR-112a, AT-57, AT-31), ${backend}`, async () => {
      test.setTimeout(SLOW * 2);
      await startDemo(page, 'crafted');
      await expect(page.getByTestId('demo-watch')).toContainText('answers 403');
      await expect(page.getByTestId('demo-found')).toContainText('answered 403', { timeout: SLOW });
      await expect(page.getByTestId('demo-found')).toContainText('REJECTED: a requested source is not available');
      await putBack(page);
    });

    if (backend === 'python') {
      test('AT-14: a failing model written in an empty slot leaves the rest running: the server, the other models, the client, the drawing', async () => {
        test.setTimeout(SLOW * 2);
        await page.getByTestId('card-models').click();
        await page.getByTestId('model-new-model-1').click();
        await expect(page.getByTestId('model-editor')).toBeVisible();
        await expect(page.locator('.cm-content')).toContainText('class', { timeout: 30_000 });
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText([
          'from csmodel import Model', '', '', 'class Broken(Model):', '    id = "new-model-1"', '    label = "New model 1"', '    window = 3600.0', '',
          '    async def process(self, api, ds, t0, t1, run):', '        raise RuntimeError("a bug in a new model")', '', '', 'MODEL = Broken', ''].join('\n'));
        await page.getByTestId('run-model').click();
        await expect(page.getByTestId('phase-new-model-1')).toContainText('failed', { timeout: SLOW });
        for (const m of ['data-cleanse', 'summaries', 'analysis']) await expect(page.getByTestId(`phase-${m}`)).toContainText('live');
        await expect(status(page, 'server')).toContainText('Ready');
        const drawn = (await captured(page))['client>server:Q'] ?? 0;
        await page.getByTestId('card-client').click();
        await page.getByTestId('dc-play').click();
        await expect.poll(async () => (await captured(page))['client>server:Q'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(drawn);
        await page.getByTestId('dc-play').click();
        await expect(status(page, 'client')).toHaveText('Configured');
      });
    }

    test(`Reset instance: a confirmation naming what is lost; then an empty store, the folder unchanged (FR-50a, AT-54), ${backend}`, async () => {
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('reset-instance').click();
      const confirm = page.getByTestId('reset-confirm');
      await expect(confirm).toContainText('deletes the data server’s whole store');
      await expect(confirm).toContainText(/every imported dataset \(\d: mission-a-20310407-/);
      await expect(confirm).toContainText('The data folder is untouched');
      await page.getByTestId('reset-confirm-no').click();
      await expect(confirm).toHaveCount(0);
      await page.getByTestId('reset-instance').click();
      await page.getByTestId('reset-confirm-yes').click();
      await page.getByTestId('control-panel-close').click();
      await page.getByTestId('card-folder').click();
      for (const f of [A, B, BX, C]) {
        await expect(page.locator(`[data-testid="folder-table"] tr[data-file="${f}"]`)).toHaveAttribute('data-status', 'not-imported', { timeout: SLOW });
      }
      await page.getByTestId('card-server').click();
      await expect(page.getByTestId('server-empty')).toBeVisible({ timeout: SLOW });
      expect(errors).toEqual([]);
    });
  });
}
