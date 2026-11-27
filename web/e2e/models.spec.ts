import { expect, Page, test } from '@playwright/test';

// The models on import (plan Phase 6; docs/v4-interfaces.md §10; SRD §6.4), in the browser, through the relay,
// in both back ends: the JavaScript stand-in and the Python back end in Pyodide, where each model has its own
// worker. Every request is a fetch made by the page, so it goes through the Service Worker relay.
const SLOW_MS = 300_000;
const DEMO = { owner: 'demo-owner', friend: 'demo-friend', analyst: 'demo-analyst' };
type User = keyof typeof DEMO;
const URN = 'urn:x-barge:';
const SWE = 'application/swe%2Bjson';
const DC = URN + 'process:data-cleanse';
const SUM = URN + 'process:summaries';
const AN = URN + 'process:analysis';
const CORE: [string, string][] = [[DC, 'data-cleanse'], [SUM, 'summaries'], [AN, 'analysis']];
const C = 'MISSION_C_20310421.csv';

async function call(page: Page, method: string, path: string, user: User = 'owner', body?: unknown): Promise<{ status: number; text: string }> {
  const auth = 'Basic ' + Buffer.from(`${user}:${DEMO[user]}`).toString('base64');
  return page.evaluate(async ({ method, path, auth, body }) => {
    const headers: Record<string, string> = { authorization: auth };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  }, { method, path, auth, body });
}

async function get(page: Page, path: string, user: User = 'owner') {
  const a = await call(page, 'GET', path, user);
  expect(a.status, path).toBe(200);
  return JSON.parse(a.text);
}

async function systems(page: Page): Promise<Map<string, string>> {
  const j = await get(page, 'api/systems?searchMembers=true&f=application/sml%2Bjson&limit=1000');
  return new Map(j.items.map((s: any) => [s.uniqueId, s.id]));
}

async function datastream(page: Page, uid: string, output: string): Promise<any> {
  const sid = (await systems(page)).get(uid);
  if (!sid) return undefined;
  return (await get(page, `api/systems/${sid}/datastreams?limit=1000`)).items.find((d: any) => d.outputName === output);
}

async function rows(page: Page, uid: string, output: string, user: User = 'owner'): Promise<any[]> {
  const d = await datastream(page, uid, output);
  if (!d) return [];
  return get(page, `api/datastreams/${d.id}/observations?f=${SWE}&limit=100000`, user);
}

/** A model's runs log on a dataset, folded: run id -> its latest entry (FR-35b). */
async function runs(page: Page, uid: string, ds: string): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const e of await rows(page, uid, `runs__${ds}`)) out.set(e.run_id, e);
  return out;
}

async function datasetOf(page: Page, prefix: string): Promise<string> {
  const cat = await rows(page, URN + 'importer', 'catalogue');
  const r = [...cat].reverse().find((x) => String(x.file).startsWith(prefix) && x.status === 'imported');
  return r?.dataset ?? '';
}

/** Send a command as `user`, without waiting on the held answer (AT-39); then its outcome's reports. */
async function command(page: Page, uid: string, input: string, parameters: Record<string, unknown>, user: User = 'owner'): Promise<any[]> {
  const sid = (await systems(page)).get(uid);
  const cs = (await get(page, `api/systems/${sid}/controlstreams`, user)).items.find((c: any) => c.inputName === input);
  const sent = await call(page, 'POST', `api/controlstreams/${cs.id}/commands`, user, { parameters });
  expect(sent.status).toBe(200); // the model was subscribed: the command was pushed (§9.1)
  const id = JSON.parse(sent.text).id;
  let items: any[] = [];
  await expect.poll(async () => {
    items = (await get(page, `api/commands/${id}/status`, user)).items.filter((r: any) => r.statusCode !== 'PENDING');
    return items[items.length - 1]?.statusCode;
  }, { timeout: SLOW_MS, intervals: [250] }).toMatch(/COMPLETED|FAILED|REJECTED/);
  return items;
}

/** Send a command without waiting for its held answer (AT-39): the models act on it at once. */
async function send(page: Page, uid: string, input: string, parameters: Record<string, unknown>, user: User = 'owner'): Promise<void> {
  const sid = (await systems(page)).get(uid);
  const cs = (await get(page, `api/systems/${sid}/controlstreams`, user)).items.find((c: any) => c.inputName === input);
  const auth = 'Basic ' + Buffer.from(`${user}:${DEMO[user]}`).toString('base64');
  await page.evaluate(({ path, auth, body }) => {
    void fetch(path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }, { path: `api/controlstreams/${cs.id}/commands`, auth, body: { parameters } });
}

/** Every core model's run `n` on a dataset is complete; returns the seconds it took to get there. */
async function complete(page: Page, ds: string, n = 1, models = CORE): Promise<number> {
  const t0 = Date.now();
  await expect.poll(async () => {
    for (const [uid, m] of models) if ((await runs(page, uid, ds)).get(`${m}-${ds}-${n}`)?.status !== 'complete') return `${m} not yet`;
    return 'complete';
  }, { timeout: SLOW_MS, intervals: [500] }).toBe('complete');
  return (Date.now() - t0) / 1000;
}

/** How long each core model's run 1 on a dataset took, from its first runs entry to its complete one (real times). */
async function spans(page: Page, ds: string): Promise<string> {
  const out: string[] = [];
  for (const [uid, m] of CORE) {
    const log = (await rows(page, uid, `runs__${ds}`)).filter((e) => e.run_id === `${m}-${ds}-1`);
    out.push(`${m} ${(Date.parse(log[log.length - 1].time) - Date.parse(log[0].time)) / 1000} s`);
  }
  return out.join(', ');
}

/** A cleaned output's blocks of one run, without their run id (D-280). */
async function blocks(page: Page, uid: string, output: string, runId: string): Promise<any[]> {
  return (await rows(page, uid, output)).filter((b) => b.run_id === runId).map(({ run_id: _r, ...rest }) => rest);
}

const timings: string[] = [];
test.afterAll(() => console.log(timings.join('\n')));

for (const backend of ['standin', 'python'] as const) {
  const name = backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in';
  test.describe(`the models on import, ${name}`, () => {
    test.describe.configure({ mode: 'serial' });
    let page: Page;
    let a = '';

    test.beforeAll(async ({ browser }, info) => {
      const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1920, height: 1080 } });
      page = await context.newPage();
      const t0 = Date.now();
      await page.goto(`demo/?backend=${backend}`);
      await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW_MS });
      const shown = (Date.now() - t0) / 1000;
      await expect.poll(async () => (a = await datasetOf(page, 'MISSION_A')), { timeout: SLOW_MS, intervals: [500] }).not.toBe('');
      const done = await complete(page, a);
      timings.push(`${name}: flowchart after ${shown.toFixed(1)} s; Mission A's runs complete ${done.toFixed(1)} s later (${((Date.now() - t0) / 1000).toFixed(1)} s after the page was opened)`);
      timings.push(`${name}: Mission A, each run from its first entry to its complete one (whole seconds): ${await spans(page, a)}`);
    });

    test('after startup each core model\'s run on Mission A is complete, its progress logged (FR-35b)', async () => {
      for (const [uid, m] of CORE) {
        const log = await rows(page, uid, `runs__${a}`);
        expect(log[0]).toMatchObject({ run_id: `${m}-${a}-1`, status: 'processing', pct: 0 });
        expect(log[log.length - 1]).toMatchObject({ run_id: `${m}-${a}-1`, status: 'complete', pct: 100, done_until: '2031-04-08T00:00:00Z' });
        expect(log.length).toBeGreaterThanOrEqual(m === 'analysis' ? 2 : 11); // every 10 %
      }
    });

    test('Data cleanse\'s and the summaries\' outputs exist for Mission A and are readable', async () => {
      const bow = await rows(page, DC, `cleaned-bow__${a}`);
      expect(bow.length).toBe(24); // one block an hour (D-280)
      expect(JSON.parse(bow[0].offsets).length).toBe(3600);
      expect(JSON.parse(bow[0].air_temperature).filter((x: unknown) => typeof x === 'number').length).toBeGreaterThan(3000);
      const m = await rows(page, SUM, `summary-1min-bow__${a}`);
      expect(m.length).toBe(1440);
      expect(m[0]).toMatchObject({ time: '2031-04-07T00:00:00Z', run_id: `summaries-${a}-1` });
      expect(m[0].air_temperature_min).toBeLessThanOrEqual(m[0].air_temperature);
      expect(m[0].air_temperature).toBeLessThanOrEqual(m[0].air_temperature_max);
      expect((await rows(page, SUM, `summary-1h-stern__${a}`)).length).toBe(24);
      const d = await rows(page, SUM, `derived-1min__${a}`);
      expect(d.length).toBe(1440);
      expect(typeof d[600].bow_minus_stern).toBe('number');
      expect((await rows(page, AN, `clusters__${a}`)).length).toBeGreaterThan(100);
    });

    test('importing Mission C starts runs on it, which complete', async () => {
      const t0 = Date.now();
      await send(page, URN + 'importer', 'import', { action: 'import', file: C });
      let c = '';
      await expect.poll(async () => (c = await datasetOf(page, 'MISSION_C')), { timeout: SLOW_MS, intervals: [200] }).toMatch(/^mission-c-20310421-/);
      const imported = (Date.now() - t0) / 1000;
      const done = await complete(page, c);
      timings.push(`${name}: Mission C, each run from its first entry to its complete one (whole seconds): ${await spans(page, c)}`);
      timings.push(`${name}: Mission C (12 h) imported ${imported.toFixed(1)} s after the command was sent; its three runs complete ${done.toFixed(1)} s later`);
      expect((await rows(page, SUM, `summary-1min-stern__${c}`)).length).toBe(720);
    });

    test('a settings command to Data cleanse starts a new run; the latest complete run is the new one; same settings, same outputs (AT-34)', async () => {
      const before = await runs(page, DC, a);
      const n = before.size + 1;
      const id = `data-cleanse-${a}-${n}`;
      const t0 = Date.now();
      await send(page, DC, 'settings', { spike_threshold: 6 });
      await complete(page, a, n, [[DC, 'data-cleanse']]);
      timings.push(`${name}: a new Data cleanse run on Mission A (and on Mission C, newest first) complete ${((Date.now() - t0) / 1000).toFixed(1)} s after the command was sent`);
      const log = await rows(page, DC, `runs__${a}`);
      const last = log.filter((e) => e.status === 'complete').pop();
      expect(last.run_id).toBe(id); // the latest complete run is the one read (FR-35)
      expect(last.spike_threshold).toBe(6);
      expect(await blocks(page, DC, `cleaned-stern__${a}`, id)).toEqual(await blocks(page, DC, `cleaned-stern__${a}`, `data-cleanse-${a}-1`));
      const st = await command(page, DC, 'settings', { spike_threshold: 6 }); // the outcome, as a sender reads it (D-199)
      expect(st.map((r) => r.statusCode)).toEqual(['ACCEPTED', 'COMPLETED']);
      expect(st[1].message).toContain(`data-cleanse-${a}-${n + 1}`);
      await complete(page, a, n + 1, [[DC, 'data-cleanse']]);
    });

    test('the friend gets 403 on restricted model outputs, and a CO₂ clustering command from the friend is rejected (AT-56, AT-57)', async () => {
      for (const [uid, out] of [[DC + ':restricted', `cleaned-co2-bow__${a}`], [SUM + ':restricted', `summary-1min-co2-stern__${a}`],
        [AN + ':restricted', `runs__${a}`]]) {
        const d = await datastream(page, uid, out);
        expect(d, out).toBeTruthy(); // listed, as OpenSensorHub lists it (FR-93, 4.7)
        expect((await call(page, 'GET', `api/datastreams/${d.id}/observations?f=${SWE}`, 'friend')).status, out).toBe(403);
        expect((await call(page, 'GET', `api/datastreams/${d.id}/observations?f=${SWE}`, 'owner')).status, out).toBe(200);
      }
      // No open model output names CO₂ (AT-56).
      for (const [uid] of CORE) {
        const sid = (await systems(page)).get(uid);
        const items = (await get(page, `api/systems/${sid}/datastreams?limit=1000`, 'friend')).items;
        expect(items.filter((d: any) => /co2/.test(d.outputName))).toEqual([]);
      }
      const cat = await rows(page, URN + 'importer', 'catalogue');
      const row = cat.find((r) => r.dataset === a);
      const doi = JSON.stringify({ version: 1, dataset: { file: row.file, size: row.size, modified: row.modified, sha256: row.sha256 },
        start: '2031-04-07T06:00:00Z', end: '2031-04-07T08:00:00Z', resolution: 'PT1M', aggregation: 'as-stored',
        sources: [{ system: URN + 'sensor:bow:co2', output: 'co2', fields: ['co2'] }] });
      const st = await command(page, AN, 'clustering', { algorithm: 'A', doi, clusters: 3, sensitivity: 5 }, 'friend');
      expect(st[st.length - 1]).toMatchObject({ statusCode: 'REJECTED', message: 'a requested source is not available' });
    });

    if (backend === 'python') {
      test('a failing model written in an empty slot leaves the others running (AT-14, AT-13)', async () => {
        await page.getByTestId('card-models').click();
        await page.getByTestId('model-new-model-1').click();
        await expect(page.getByTestId('model-editor')).toBeVisible();
        await expect(page.locator('.cm-content')).toContainText('class WindChill', { timeout: 30_000 });
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText([
          'from csmodel import Model', '', '', 'class Broken(Model):', '    id = "new-model-1"', '    label = "New model 1"', '    window = 3600.0', '',
          '    async def process(self, api, ds, t0, t1, run):', '        raise RuntimeError("a bug in a new model")', '', '', 'MODEL = Broken', ''].join('\n'));
        await page.getByTestId('run-model').click();
        await expect(page.getByTestId('phase-new-model-1')).toContainText('failed', { timeout: SLOW_MS });
        await expect(page.getByTestId('editor-status')).toContainText('a bug in a new model');
        // It registered first; everything else carries on: the core models stay live and the server answers.
        expect((await systems(page)).has(URN + 'process:new-model-1')).toBe(true);
        for (const m of ['data-cleanse', 'summaries', 'analysis']) await expect(page.getByTestId(`phase-${m}`)).toContainText('live');
        const st = await command(page, SUM, 'settings', { tendency_hours: 3 });
        expect(st[st.length - 1].statusCode).toBe('COMPLETED');
        await expect(page.getByTestId('phase-new-model-1')).toContainText('failed');
      });
    }
  });
}
