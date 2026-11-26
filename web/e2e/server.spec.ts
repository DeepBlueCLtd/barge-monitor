import { expect, Page, test } from '@playwright/test';

// The server behaves as a configured stock OpenSensorHub (plan Phase 4; docs/v4-interfaces.md
// §9.1-§9.3), proved in the browser, through the relay, in both back ends: the JavaScript
// stand-in and the Python back end in Pyodide. Every request here is a fetch made by the page,
// so it goes through the Service Worker relay to the back-end worker, as the display client's do.
const SLOW_MS = 180_000;
const DEMO = { owner: 'demo-owner', friend: 'demo-friend', analyst: 'demo-analyst', 'svc-importer': 'svc-demo', 'svc-new-model-2': 'svc-demo' };
type User = keyof typeof DEMO;

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** One request through the relay, as `user` (none: no credentials). */
async function call(page: Page, method: string, path: string, user: User | null, body?: unknown, ctype = 'application/json'): Promise<Answer> {
  const auth = user ? 'Basic ' + Buffer.from(`${user}:${DEMO[user]}`).toString('base64') : null;
  return page.evaluate(async ({ method, path, auth, body, ctype }) => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = ctype;
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => (h[k] = v));
    return { status: r.status, headers: h, text: await r.text() };
  }, { method, path, auth, body, ctype });
}

const json = (a: Answer) => JSON.parse(a.text);

async function systems(page: Page, user: User = 'owner'): Promise<Map<string, string>> {
  const a = await call(page, 'GET', 'api/systems?searchMembers=true&f=application/sml%2Bjson&limit=1000', user);
  expect(a.status).toBe(200);
  return new Map(json(a).items.map((s: any) => [s.uniqueId, s.id]));
}

for (const backend of ['standin', 'python'] as const) {
  test.describe(`the server as OpenSensorHub, ${backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in'}`, () => {
    test.describe.configure({ mode: 'serial' });
    let page: Page;

    test.beforeAll(async ({ browser }, info) => {
      const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1920, height: 1080 } });
      page = await context.newPage();
      await page.goto(`demo/?backend=${backend}`);
      await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW_MS });
      await expect(page.getByTestId('backend-state')).toHaveText(backend === 'python' ? 'Python' : 'JavaScript stand-in');
      // In Python mode the models start in their own workers after the server: wait until they have registered (FR-28).
      await expect.poll(async () => (await systems(page)).has('urn:x-barge:process:analysis'), { timeout: SLOW_MS, intervals: [1000] }).toBe(true);
    });

    test.afterAll(async () => {
      await page.context().close();
    });

    test('401 without credentials, an HTML page, and no browser login dialog (AT-49, FR-97, D-226)', async () => {
      for (const path of ['api/', 'api/systems', 'api/datastreams', 'api/profile.json']) {
        const a = await call(page, 'GET', path, null);
        expect(a.status, path).toBe(401);
        expect(a.headers['content-type'], path).toMatch(/^text\/html/);
        expect(a.text).toContain('<title>401 Unauthorized</title>');
        expect(a.headers['www-authenticate'], `${path}: the relay drops the challenge`).toBeUndefined();
      }
      expect((await call(page, 'GET', 'api/', 'owner')).status).toBe(200);
      const bad = await page.evaluate(async () => (await fetch('api/', { headers: { authorization: 'Basic ' + btoa('owner:wrong') } })).status);
      expect(bad).toBe(401);
      // A top-level navigation to the API without credentials: the 401 page, never the browser's own dialog,
      // because no WWW-Authenticate reaches the browser.
      const nav = await page.context().newPage();
      let dialog = false;
      nav.on('dialog', async (d) => {
        dialog = true;
        await d.dismiss();
      });
      const res = await nav.goto(`demo/api/systems`);
      expect(res!.status()).toBe(401);
      expect(await res!.headerValue('www-authenticate')).toBeNull();
      await expect(nav.locator('h1')).toHaveText('401 Unauthorized');
      expect(dialog).toBe(false);
      await nav.close();
    });

    test('discovery by GET /systems?searchMembers=true with credentials (D-193)', async () => {
      const all = await systems(page);
      for (const uid of ['urn:x-barge:platform:barge', 'urn:x-barge:sensor:bow', 'urn:x-barge:sensor:stern', 'urn:x-barge:sensor:bow:co2',
        'urn:x-barge:process:models', 'urn:x-barge:process:data-cleanse', 'urn:x-barge:workspace:owner']) {
        expect(all.has(uid), uid).toBe(true);
      }
      expect([...all.values()].every((id) => /^[0-9a-v]{4}$/.test(id))).toBe(true); // opaque identifiers (§6)
      const top = json(await call(page, 'GET', 'api/systems?f=application/sml%2Bjson', 'owner')).items.map((s: any) => s.uniqueId);
      expect(top).toContain('urn:x-barge:platform:barge');
      expect(top).not.toContain('urn:x-barge:sensor:bow'); // the top level only, without searchMembers
      const listed = json(await call(page, 'GET', 'api/systems?searchMembers=true&f=application/sml%2Bjson', 'owner'));
      expect(listed.items.every((s: any) => !s.links.some((l: any) => l.rel === 'parent'))).toBe(true); // no parent link in a listing
      expect((await call(page, 'GET', 'api/collections/all_systems/items', 'owner')).status).toBe(400);
    });

    test('the friend lists a CO₂ system but gets 403 reading its datastream or schema; the owner reads it (FR-93, AT-55)', async () => {
      const sy = await systems(page);
      const analyser = sy.get('urn:x-barge:sensor:bow:co2')!;
      // A CO₂ datastream, made as the importer makes them (§7): under the analyser, by its service account.
      const made = await call(page, 'POST', `api/systems/${analyser}/datastreams`, 'svc-importer', {
        name: 'Bow CO₂ (e2e)', outputName: 'co2__e2e', schema: { obsFormat: 'application/swe+json', recordSchema: {
          type: 'DataRecord', name: 'record', label: 'CO₂', fields: [
            { type: 'Time', name: 'time', label: 'Time', definition: 'http://www.opengis.net/def/property/OGC/0/SamplingTime', uom: { href: 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian' } },
            { type: 'Quantity', name: 'co2', label: 'CO₂', definition: 'https://deepbluecltd.github.io/barge-monitor/def/co2', uom: { code: '[ppm]' } }] } },
      });
      expect(made.status).toBe(201);
      const ds = made.headers.location.split('/').pop()!;
      expect((await call(page, 'POST', `api/datastreams/${ds}/observations`, 'svc-importer', { time: '2031-04-07T00:00:00Z', co2: 431 }, 'application/swe+json')).status).toBe(201);
      // Listed for the friend, as OpenSensorHub lists it ...
      expect((await systems(page, 'friend')).get('urn:x-barge:sensor:bow:co2')).toBe(analyser);
      const dsList = json(await call(page, 'GET', 'api/datastreams?limit=1000', 'friend')).items.map((d: any) => d.id);
      expect(dsList).toContain(ds);
      // ... and refused with 403; read by the owner.
      for (const path of [`api/systems/${analyser}`, `api/datastreams/${ds}`, `api/datastreams/${ds}/schema?obsFormat=application/swe%2Bjson`,
        `api/datastreams/${ds}/observations?f=application/swe%2Bjson`]) {
        const f = await call(page, 'GET', path, 'friend');
        expect(f.status, `friend ${path}`).toBe(403);
        expect(f.headers['content-type']).toMatch(/^text\/html/);
        expect((await call(page, 'GET', path, 'owner')).status, `owner ${path}`).toBe(200);
      }
      const rows = json(await call(page, 'GET', `api/datastreams/${ds}/observations?f=application/swe%2Bjson`, 'owner'));
      expect(rows).toEqual([{ time: '2031-04-07T00:00:00Z', co2: 431 }]);
      // Another user's workspace is listed and refused too (AT-52).
      expect((await call(page, 'GET', `api/systems/${sy.get('urn:x-barge:workspace:owner')}`, 'friend')).status).toBe(403);
    });

    test('PUT and DELETE answer 405, and nothing is removed (§9.1, D-224)', async () => {
      const sy = await systems(page);
      const bow = sy.get('urn:x-barge:sensor:bow')!;
      const weather = json(await call(page, 'GET', `api/systems/${bow}/datastreams`, 'owner')).items.find((d: any) => d.outputName === 'weather').id;
      for (const [method, path] of [['PUT', `api/systems/${bow}`], ['DELETE', `api/systems/${bow}`], ['DELETE', `api/datastreams/${weather}`],
        ['PUT', `api/datastreams/${weather}/observations`], ['PATCH', `api/systems/${bow}`]]) {
        const a = await call(page, method, path, 'owner', method === 'DELETE' ? undefined : {});
        expect(a.status, `${method} ${path}`).toBe(405);
      }
      expect((await call(page, 'GET', `api/systems/${bow}`, 'owner')).status).toBe(200);
      expect((await call(page, 'GET', `api/datastreams/${weather}`, 'owner')).status).toBe(200);
    });

    test('a pushed command reaches a subscribed receiver, and its outcome reads as non-PENDING (§9.2, D-199, AT-39)', async () => {
      test.setTimeout(120_000);
      const sy = await systems(page);
      const models = sy.get('urn:x-barge:process:models')!;
      // A receiver registers as any model does (FR-28), under its own service account.
      const reg = await call(page, 'POST', `api/systems/${models}/subsystems`, 'svc-new-model-2',
        { type: 'SimpleProcess', uniqueId: 'urn:x-barge:process:new-model-2', label: 'New model 2', assetType: 'Process' }, 'application/sml+json');
      expect(reg.status).toBe(201);
      const sid = reg.headers.location.split('/').pop()!;
      const cs = await call(page, 'POST', `api/systems/${sid}/controlstreams`, 'svc-new-model-2', {
        name: 'E2E', inputName: 'e2e', schema: { commandFormat: 'application/json', parametersSchema: { type: 'DataRecord', name: 'record', label: 'E2E', fields: [
          { type: 'Quantity', name: 'level', label: 'Level', definition: 'https://deepbluecltd.github.io/barge-monitor/def/level', uom: { code: '1' },
            constraint: { type: 'AllowedValues', intervals: [[1, 10]] } }] } },
      });
      expect(cs.status).toBe(201);
      const csId = cs.headers.location.split('/').pop()!;
      // Only a service account subscribes, and only on the internal endpoint (D-223).
      expect((await call(page, 'GET', `api-internal/controlstreams/${csId}/commands?subscribe=1`, 'owner')).status).toBe(403);
      expect((await call(page, 'GET', `api-internal/controlstreams/${csId}/commands?subscribe=1`, null)).status).toBe(401);
      const auth = (u: User) => 'Basic ' + Buffer.from(`${u}:${DEMO[u]}`).toString('base64');
      const out = await page.evaluate(async ({ csId, svc, owner }) => {
        // The receiver: a streaming fetch through the relay, one command JSON per line (§9.2).
        const res = await fetch(`api-internal/controlstreams/${csId}/commands?subscribe=1`, { headers: { authorization: svc } });
        const reader = res.body!.getReader();
        const firstLine = (async () => {
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return null;
            buf += new TextDecoder().decode(value);
            const i = buf.indexOf('\n');
            if (i >= 0) return JSON.parse(buf.slice(0, i));
          }
        })();
        // The sender does not await its answer (held about 5 s) before the receiver has the command (AT-39).
        const t0 = performance.now();
        const sent = fetch(`api/controlstreams/${csId}/commands`, {
          method: 'POST', headers: { authorization: owner, 'content-type': 'application/json' }, body: JSON.stringify({ parameters: { level: 3 } }),
        });
        const cmd = await firstLine;
        const pushedAfter = performance.now() - t0;
        // The receiver validates and reports (FR-27).
        for (const statusCode of ['ACCEPTED', 'COMPLETED']) {
          await fetch(`api/controlstreams/${csId}/status`, {
            method: 'POST', headers: { authorization: svc, 'content-type': 'application/json' },
            body: JSON.stringify({ 'command@id': cmd.id, statusCode }),
          });
        }
        const before = (await (await fetch(`api/controlstreams/${csId}/status`, { headers: { authorization: owner } })).json()).items;
        const answer = await sent;
        const answeredAfter = performance.now() - t0;
        const body = await answer.json();
        const after = (await (await fetch(`api/controlstreams/${csId}/status`, { headers: { authorization: owner } })).json()).items;
        await reader.cancel();
        // The outcome: the latest report other than PENDING (D-199).
        const mine = after.filter((r: any) => r['command@id'] === cmd.id && r.statusCode !== 'PENDING')
          .sort((a: any, b: any) => String(a.reportTime).localeCompare(String(b.reportTime)));
        return { status: res.status, ctype: res.headers.get('content-type'), cmd, pushedAfter, answeredAfter, answer: answer.status,
          current: body.currentStatus, before: before.filter((r: any) => r['command@id'] === cmd.id).map((r: any) => r.statusCode),
          after: after.filter((r: any) => r['command@id'] === cmd.id).map((r: any) => r.statusCode), outcome: mine.length ? mine[mine.length - 1].statusCode : null };
      }, { csId, svc: auth('svc-new-model-2'), owner: auth('owner') });
      expect(out.status).toBe(200);
      expect(out.ctype).toMatch(/^application\/x-ndjson/);
      expect(out.cmd.parameters).toEqual({ level: 3 });
      expect(out.cmd.sender).toBe('owner'); // OpenSensorHub puts the sender's user id on a pushed command (D-152)
      expect(out.pushedAfter).toBeLessThan(3000); // pushed at once, not after the hold
      expect(out.answeredAfter).toBeGreaterThan(4000); // the sender's answer is held about 5 s (§9.1)
      expect(out.answer).toBe(200);
      expect(out.current).toBe('PENDING');
      expect(out.before).toEqual(['ACCEPTED', 'COMPLETED']);
      expect(out.after).toEqual(['ACCEPTED', 'COMPLETED', 'PENDING']); // stored when the POST answered, after COMPLETED
      expect(out.outcome).toBe('COMPLETED'); // so the outcome is read as the latest report other than PENDING
    });
  });
}
