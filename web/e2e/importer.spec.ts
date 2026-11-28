import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { expect, Page, test } from '@playwright/test';
import { BACKENDS } from './site';

// The CSV importer (plan Phase 5; docs/v4-interfaces.md §5–§7; SRD §6.1, §6.2), in the browser, through the
// relay, in both back ends: the JavaScript stand-in and the Python back end in Pyodide. Every request is a
// fetch made by the page, so it goes through the Service Worker relay to the back-end worker.
const SLOW_MS = 180_000;
const DEMO = { owner: 'demo-owner', friend: 'demo-friend' };
type User = keyof typeof DEMO;
const URN = 'urn:x-barge:';
const SWE = 'application/swe%2Bjson';
const A = 'MISSION_A_20310407.csv';
const B = 'MISSION_B_20310414.csv';
const BX = 'MISSION_B_20310414_REEXPORT.csv';
const C = 'MISSION_C_20310421.csv';
const DATA = new URL('../../dist-site/demo/data/', import.meta.url);
const FOLDER = new URL('folder/', DATA);
const TEST_FOLDER = new URL('e2e-folder/', DATA); // a test-only folder, chosen with ?folder= (D-272)

interface Answer {
  status: number;
  text: string;
}

async function call(page: Page, method: string, path: string, user: User | null = 'owner', body?: unknown): Promise<Answer> {
  const auth = user ? 'Basic ' + Buffer.from(`${user}:${DEMO[user]}`).toString('base64') : null;
  return page.evaluate(async ({ method, path, auth, body }) => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
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
  const sy = await systems(page);
  return (await get(page, `api/systems/${sy.get(uid)}/datastreams`)).items.find((d: any) => d.outputName === output);
}

/** The catalogue folded per file: the latest observation of each is its current status (§7). */
async function catalogue(page: Page): Promise<Map<string, any>> {
  const cat = await datastream(page, URN + 'importer', 'catalogue');
  const rows = await get(page, `api/datastreams/${cat.id}/observations?f=${SWE}&limit=100000`);
  const out = new Map<string, any>();
  for (const r of rows) out.set(r.file, r);
  return out;
}

/** Send `import` (or `rescan`) as the owner, without waiting on the held answer (AT-39); then its reports. */
async function command(page: Page, action: string, file: string): Promise<string[]> {
  const imp = (await systems(page)).get(URN + 'importer');
  const cs = (await get(page, `api/systems/${imp}/controlstreams`)).items.find((c: any) => c.inputName === 'import');
  const sent = await call(page, 'POST', `api/controlstreams/${cs.id}/commands`, 'owner', { parameters: { action, file } });
  expect(sent.status).toBe(200); // the importer was subscribed: the command was pushed (§9.1)
  const id = JSON.parse(sent.text).id;
  let codes: string[] = [];
  await expect.poll(async () => {
    const items = (await get(page, `api/commands/${id}/status`)).items.filter((r: any) => r.statusCode !== 'PENDING');
    codes = items.map((r: any) => r.statusCode);
    return codes[codes.length - 1];
  }, { timeout: SLOW_MS, intervals: [250] }).toMatch(/COMPLETED|FAILED|REJECTED/);
  return codes;
}

async function captured(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (globalThis as any).bargeCaptured());
}

const touches = (counts: Record<string, number>, who: string) => Object.keys(counts).filter((k) => k.split(':')[0].split('>').includes(who));

/** The CSV's data lines (after the comment block and the header), as written. */
function csvLines(folder: URL, file: string): { head: string[]; rows: string[] } {
  const lines = gunzipSync(readFileSync(new URL(file + '.gz', folder))).toString('latin1').split('\r\n');
  return { head: lines[3].split(';'), rows: lines.slice(4) };
}

const cell = (csv: { head: string[]; rows: string[] }, i: number, col: string) => csv.rows[i].split(';')[csv.head.indexOf(col)];
const num = (s: string, scale = 1) => (s === '-9999' ? 'NaN' : Math.round(Number(s.replace(',', '.')) * scale * 100) / 100);

function folderHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['index.json', 'manifest.json.gz', ...[A, B, BX, C].map((f) => f + '.gz')]) {
    out[name] = createHash('sha256').update(readFileSync(new URL(name, FOLDER))).digest('hex');
  }
  return out;
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW_MS });
  // In Python mode the models start in their own workers after the server: wait until they have registered.
  await expect.poll(async () => (await systems(page)).has(URN + 'process:analysis'), { timeout: SLOW_MS, intervals: [1000] }).toBe(true);
}

for (const backend of BACKENDS) {
  test.describe(`the CSV importer, ${backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in'}`, () => {
    test.describe.configure({ mode: 'serial' });
    let page: Page;
    const before = folderHashes();

    test.beforeAll(async ({ browser }, info) => {
      const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1920, height: 1080 } });
      page = await context.newPage();
      await open(page, `demo/?backend=${backend}`);
    });

    test.afterAll(async () => {
      await page.context().close();
    });

    test('after startup the catalogue lists the four files; Mission A imported silently (FR-15, AT-40, D-197)', async () => {
      const cat = await catalogue(page);
      expect([...cat.keys()].sort()).toEqual([A, B, BX, C]);
      const a = cat.get(A);
      expect(a.status).toBe('imported');
      expect(a.records).toBe(86400);
      expect(a.dataset).toMatch(/^mission-a-20310407-[0-9a-f]{8}$/);
      expect([a.start, a.end]).toEqual(['2031-04-07T00:00:00Z', '2031-04-07T23:59:59Z']);
      for (const f of [B, BX, C]) {
        expect(cat.get(f).status, f).toBe('not-imported');
        expect(cat.get(f).records, f).toBe(0); // a Count has no missing value in OpenSensorHub (D-197)
        expect(cat.get(f).dataset, f).toBe('');
      }
      const index = JSON.parse(readFileSync(new URL('index.json', FOLDER), 'utf8')).files;
      for (const f of index) expect([cat.get(f.file).size, cat.get(f.file).modified, cat.get(f.file).sha256]).toEqual([f.size, f.modified, f.sha256]);
      // Silently: counted, never sent to the shell to draw (x-tap-quiet) — nothing from or to the importer or folder.
      const counts = await captured(page);
      expect(touches(counts, 'importer')).toEqual([]);
      expect(touches(counts, 'folder')).toEqual([]);
      // The data folder's panel shows the folder as the catalogue has it, and the importer's the silent import's rows/s
      // (FR-109, FR-110). Phase 8 moved both from the control panel to their own panels (D-322).
      await page.getByTestId('card-folder').click();
      await expect(page.locator(`[data-testid="folder-table"] tr[data-file="${A}"]`)).toHaveAttribute('data-status', 'imported');
      await expect(page.locator(`[data-testid="folder-table"] tr[data-file="${C}"]`)).toHaveAttribute('data-status', 'not-imported');
      await page.getByTestId('card-importer').click();
      await expect(page.getByTestId('import-rate')).toContainText(/MISSION_A_20310407\.csv, 86,400 rows .* rows\/s \(silently, at startup\)/);
      await page.getByTestId('detail-close').click();
    });

    test('import Mission C over HTTP: ACCEPTED, EXECUTING, COMPLETED; its datastreams match the CSV (AT-01, AT-41, FR-21)', async () => {
      test.setTimeout(SLOW_MS);
      const codes = await command(page, 'import', C);
      expect(codes).toEqual(['ACCEPTED', ...Array(10).fill('EXECUTING'), 'COMPLETED']);
      const c = (await catalogue(page)).get(C);
      expect(c.status).toBe('imported');
      expect(c.records).toBe(43200);
      const ds = c.dataset;
      expect(ds).toMatch(/^mission-c-20310421-[0-9a-f]{8}$/);
      const bow = await datastream(page, URN + 'sensor:bow', `weather__${ds}`);
      const stern = await datastream(page, URN + 'sensor:stern', `weather__${ds}`);
      for (const s of ['bow', 'stern']) expect(await datastream(page, `${URN}sensor:${s}:co2`, `co2__${ds}`), s).toBeTruthy();
      // The stern has no apparent wind speed column in Mission C: no such field (degraded, FR-21).
      const fields = async (d: any) => (await get(page, `api/datastreams/${d.id}/schema?obsFormat=${SWE}`)).recordSchema.fields.map((f: any) => f.name);
      expect(await fields(bow)).toContain('apparent_wind_speed');
      expect(await fields(stern)).not.toContain('apparent_wind_speed');
      expect(await fields(stern)).not.toContain('apparent_wind_speed_qc');
      expect(await fields(stern)).toContain('air_temperature');
      // AT-01 spot checks: the served observations are the file's rows, in declared units (°C, m/s, hPa).
      const csv = csvLines(FOLDER, C);
      const t0 = Date.UTC(2031, 3, 21) / 1000;
      for (const i of [0, 4321, 30000, 43199]) {
        const when = new Date((t0 + i) * 1000).toISOString().replace('.000', '');
        const [b] = await get(page, `api/datastreams/${bow.id}/observations?f=${SWE}&phenomenonTime=${when}/${when}`);
        const [s] = await get(page, `api/datastreams/${stern.id}/observations?f=${SWE}&phenomenonTime=${when}/${when}`);
        expect(b.time, `row ${i}`).toBe(when);
        expect(b.air_temperature, `row ${i}`).toEqual(num(cell(csv, i, 'BOW_AT[dC]'), 0.1));
        expect(b.pressure, `row ${i}`).toEqual(num(cell(csv, i, 'BOW_PR[hPa]')));
        const kn = cell(csv, i, 'BOW_AWS[kn]');
        if (kn === '-9999') expect(b.apparent_wind_speed).toBe('NaN');
        else expect(Math.abs(b.apparent_wind_speed - Number(kn.replace(',', '.')) * 0.514444)).toBeLessThan(0.006);
        expect(s.water_temperature, `row ${i}`).toEqual(num(cell(csv, i, 'STN_WT[dC]'), 0.1));
        expect(s).not.toHaveProperty('apparent_wind_speed');
        expect(csv.head).not.toContain('STN_AWS[kn]');
      }
      // Captured as interfaces §2 says: S and L to and from the folder, one I per 1,000 rows, the pushed K.
      const counts = await captured(page);
      expect(counts['importer>folder:S']).toBeGreaterThanOrEqual(1);
      expect(counts['folder>importer:L']).toBeGreaterThanOrEqual(1);
      expect(counts['importer>server:I']).toBeGreaterThanOrEqual(44); // 43,200 rows, plus catalogue and status messages
      expect(counts['server>importer:K']).toBe(1);
      // The importer's speed, on its panel (FR-110; D-322).
      await page.getByTestId('card-importer').click();
      await expect(page.getByTestId('import-rate')).toContainText(/MISSION_C_20310421\.csv, 43,200 rows .* rows\/s\./);
      await page.getByTestId('detail-close').click();
    });

    test('Mission B and its re-export are kept apart (AT-42, FR-21b)', async () => {
      test.setTimeout(SLOW_MS * 2);
      expect((await command(page, 'import', B)).pop()).toBe('COMPLETED');
      expect((await command(page, 'import', BX)).pop()).toBe('COMPLETED');
      const cat = await catalogue(page);
      const [b, bx] = [cat.get(B).dataset, cat.get(BX).dataset];
      expect(b).not.toBe(bx);
      const db = await datastream(page, URN + 'sensor:bow', `weather__${b}`);
      const dbx = await datastream(page, URN + 'sensor:bow', `weather__${bx}`);
      expect(db.id).not.toBe(dbx.id);
      // Before the re-export starts, only B has readings; in the overlap each holds its own file's readings.
      expect(await get(page, `api/datastreams/${dbx.id}/observations?f=${SWE}&phenomenonTime=2031-04-14T00:00:00Z/2031-04-14T05:59:59Z&limit=10`)).toEqual([]);
      expect((await get(page, `api/datastreams/${db.id}/observations?f=${SWE}&phenomenonTime=2031-04-14T00:00:00Z/2031-04-14T05:59:59Z&limit=10`)).length).toBe(10);
      const span = 'phenomenonTime=2031-04-14T06:00:00Z/2031-04-14T23:59:59Z&limit=100000';
      const rb = await get(page, `api/datastreams/${db.id}/observations?f=${SWE}&${span}`);
      const rbx = await get(page, `api/datastreams/${dbx.id}/observations?f=${SWE}&${span}`);
      expect(rb.length).toBe(18 * 3600);
      expect(rbx.length).toBe(18 * 3600);
      const differ = rb.map((x: any, i: number) => (JSON.stringify(x) === JSON.stringify(rbx[i]) ? -1 : i)).filter((i: number) => i >= 0);
      expect(differ.length).toBeGreaterThan(0);
      expect(differ.length).toBeLessThan(0.01 * rb.length);
      const csvB = csvLines(FOLDER, B);
      for (const i of differ.slice(0, 10)) expect(rb[i].air_temperature).toEqual(num(cell(csvB, 6 * 3600 + i, 'BOW_AT[dC]'), 0.1));
    });

    test('the friend gets 403 on a CO₂ datastream\'s observations, reads its title and schema (D-351), and reads its weather (FR-93, FR-21c)', async () => {
      const ds = (await catalogue(page)).get(A).dataset;
      const co2 = await datastream(page, URN + 'sensor:stern:co2', `co2__${ds}`);
      const weather = await datastream(page, URN + 'sensor:stern', `weather__${ds}`);
      for (const p of [`api/datastreams/${co2.id}`, `api/datastreams/${co2.id}/schema?obsFormat=${SWE}`]) {
        expect((await call(page, 'GET', p, 'friend')).status, p).toBe(200); // a stream's title may be known (D-351)
      }
      for (const p of [`api/datastreams/${co2.id}/observations?f=${SWE}&limit=5`, `api/datastreams/${co2.id}/observations?f=${SWE}&resultTime=latest`]) {
        expect((await call(page, 'GET', p, 'friend')).status, p).toBe(403);
        expect((await call(page, 'GET', p, 'owner')).status, p).toBe(200);
      }
      const rows = await get(page, `api/datastreams/${co2.id}/observations?f=${SWE}&limit=5`);
      expect(Object.keys(rows[0])).toEqual(['time', 'co2', 'co2_qc']);
      expect((await call(page, 'GET', `api/datastreams/${weather.id}/observations?f=${SWE}&limit=5`, 'friend')).status).toBe(200);
      expect(JSON.stringify(await get(page, `api/datastreams/${weather.id}/schema?obsFormat=${SWE}`, 'friend'))).not.toContain('co2');
    });

    test('Reset instance empties the store and leaves the data folder byte-identical (AT-54, FR-50a)', async () => {
      test.setTimeout(SLOW_MS);
      const old = await datastream(page, URN + 'sensor:bow', `weather__${(await catalogue(page)).get(A).dataset}`);
      const served = async () => page.evaluate(async (names) => {
        const out: Record<string, string> = {};
        for (const n of names) {
          const b = await (await fetch(`data/folder/${n}`, { cache: 'no-store' })).arrayBuffer();
          out[n] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join('');
        }
        return out;
      }, Object.keys(before));
      const servedBefore = await served();
      expect(servedBefore).toEqual(before);
      await page.getByTestId('control-panel-toggle').click();
      await page.getByTestId('reset-instance').click();
      const confirm = page.getByTestId('reset-confirm');
      await expect(confirm).toContainText('deletes the data server’s whole store');
      await expect(confirm).toContainText(/every imported dataset \(4: mission-a-20310407-/); // names what is lost
      await expect(confirm).toContainText('every model result');
      await expect(confirm).toContainText('all data of interest');
      await expect(confirm).toContainText('The data folder is untouched');
      await page.getByTestId('reset-confirm-yes').click();
      await page.getByTestId('control-panel-toggle').click();
      // Empty: every file not imported, no dataset's datastream, and identifiers a client held are not found.
      await expect.poll(async () => {
        try {
          const cat = await catalogue(page);
          return [...cat.values()].map((r) => `${r.status}:${r.records}`).join(',');
        } catch {
          return 'not answering';
        }
      }, { timeout: SLOW_MS, intervals: [500] }).toBe(Array(4).fill('not-imported:0').join(','));
      const names = (await get(page, 'api/datastreams?limit=10000')).items.map((d: any) => d.outputName);
      expect(names.filter((n: string) => n.includes('__'))).toEqual([]);
      expect((await call(page, 'GET', `api/datastreams/${old.id}`)).status).toBe(404);
      // Mission A is not imported again until the page is reloaded (FR-15).
      await page.waitForTimeout(3000);
      expect((await catalogue(page)).get(A).status).toBe('not-imported');
      // AT-54: the data folder is byte-identical, on disk and as served.
      expect(folderHashes()).toEqual(before);
      expect(await served()).toEqual(before);
      // The 4.1 app carries on: the server runs, and the models register again.
      await expect.poll(async () => (await systems(page)).has(URN + 'process:analysis'), { timeout: SLOW_MS, intervals: [1000] }).toBe(true);
      await expect(page.getByTestId('flowchart')).toBeVisible();
    });
  });

  test(`a changed file is imported as a new dataset; the earlier one is superseded and still opens (AT-43), ${backend}`, async ({ browser }, info) => {
    test.setTimeout(SLOW_MS * 2);
    // A test-only data folder in the site: Mission A and Mission C, chosen with ?folder= (D-272).
    rmSync(TEST_FOLDER, { recursive: true, force: true });
    mkdirSync(TEST_FOLDER, { recursive: true });
    const index = JSON.parse(readFileSync(new URL('index.json', FOLDER), 'utf8'));
    for (const f of [A, C]) cpSync(new URL(f + '.gz', FOLDER), new URL(f + '.gz', TEST_FOLDER));
    const write = (files: any[]) => writeFileSync(new URL('index.json', TEST_FOLDER), JSON.stringify({ ...index, files }, null, 1));
    write(index.files.filter((f: any) => f.file === A || f.file === C));
    const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    try {
      await open(page, `demo/?backend=${backend}&folder=data/e2e-folder/`);
      expect([...(await catalogue(page)).keys()].sort()).toEqual([A, C]);
      expect((await command(page, 'import', C)).pop()).toBe('COMPLETED');
      const old = (await catalogue(page)).get(C).dataset;
      // The file changes in the folder: one reading re-calibrated, so its size stays, its hash and date change.
      const text = gunzipSync(readFileSync(new URL(C + '.gz', TEST_FOLDER))).toString('latin1');
      const lines = text.split('\r\n');
      const row = lines[4].split(';');
      row[1] = String(Number(row[1]) + 5);
      lines[4] = row.join(';');
      const changed = Buffer.from(lines.join('\r\n'), 'latin1');
      writeFileSync(new URL(C + '.gz', TEST_FOLDER), gzipSync(changed));
      write(index.files.filter((f: any) => f.file === A || f.file === C).map((f: any) => (f.file === C
        ? { ...f, size: changed.length, sha256: createHash('sha256').update(changed).digest('hex'), modified: '2031-04-22T09:00:00Z' } : f)));
      expect((await command(page, 'rescan', '')).pop()).toBe('COMPLETED');
      const after = (await catalogue(page)).get(C);
      expect(after.status).toBe('changed');
      expect(after.dataset).toBe(old); // names the dataset it differs from
      expect((await command(page, 'import', C)).pop()).toBe('COMPLETED');
      const now = (await catalogue(page)).get(C);
      expect(now.status).toBe('imported');
      expect(now.dataset).not.toBe(old);
      // The catalogue keeps one entry per file and hash: the earlier one is superseded.
      const cat = await datastream(page, URN + 'importer', 'catalogue');
      const rows = await get(page, `api/datastreams/${cat.id}/observations?f=${SWE}&limit=100000`);
      const latest = new Map<string, any>();
      for (const r of rows.filter((r: any) => r.file === C)) latest.set(r.dataset || r.sha256, r);
      expect(latest.get(old).status).toBe('superseded');
      // Both datasets open; the new one has the changed reading.
      const o = await datastream(page, URN + 'sensor:bow', `weather__${old}`);
      const n = await datastream(page, URN + 'sensor:bow', `weather__${now.dataset}`);
      const [ro] = await get(page, `api/datastreams/${o.id}/observations?f=${SWE}&limit=1`);
      const [rn] = await get(page, `api/datastreams/${n.id}/observations?f=${SWE}&limit=1`);
      expect(rn.air_temperature).toBeCloseTo(ro.air_temperature + 0.5, 5);
    } finally {
      await context.close();
      rmSync(TEST_FOLDER, { recursive: true, force: true });
    }
  });
}
