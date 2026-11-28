#!/usr/bin/env node
// Checks the JavaScript stand-in over real HTTP, against the Node harness
// (standin-server.mjs), for the behaviour of docs/v4-interfaces.md §9.1-§9.3:
// the server-neutral contract (PR-04) as the Python suite has it
// (backend/contract_suite/suite.py), with credentials and 403 checks, plus a
// push subscription held with `PushChannel` (web/src/push.ts) on the internal
// endpoint. There is no replay controller and no gateway (4.7).
//
// Usage: node web/scripts/standin-check.mjs [--port N] [--folder DIR]
// Exits non-zero if any check fails.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const port = Number(opt('port', String(20000 + Math.floor(Math.random() * 20000))));
const B = `http://127.0.0.1:${port}`;
const HOLD_S = 1;

const extra = ['--mission-a', ...(argv.includes('--folder') ? ['--folder', opt('folder')] : [])];
const child = spawn(process.execPath, [join(here, 'standin-server.mjs'), '--port', String(port), '--hold', String(HOLD_S), ...extra],
  { stdio: ['pipe', 'pipe', 'inherit'] });
await new Promise((res, rej) => {
  child.stdout.on('data', (b) => String(b).includes('READY') && res());
  child.on('exit', (c) => rej(new Error(`harness exited ${c}`)));
});
const control = (action, arg) => new Promise((res) => {
  const on = (b) => {
    const line = String(b).split('\n').find((l) => l.startsWith('STATE ') || l.startsWith('ERROR '));
    if (line) {
      child.stdout.off('data', on);
      res(line);
    }
  };
  child.stdout.on('data', on);
  child.stdin.write(JSON.stringify({ action, arg }) + '\n');
});

const pushBundle = await build({ entryPoints: [join(here, '..', 'src', 'push.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'error' });
const { PushChannel } = await import('data:text/javascript;base64,' + Buffer.from(pushBundle.outputFiles[0].text).toString('base64'));

const DEMO = { owner: 'demo-owner', friend: 'demo-friend', analyst: 'demo-analyst', 'svc-importer': 'svc-demo', 'svc-new-model-2': 'svc-demo' };
const auth = (u) => 'Basic ' + Buffer.from(`${u}:${DEMO[u] ?? 'wrong'}`).toString('base64');
const URN = 'urn:x-barge:';
const SWE = 'application/swe+json';
const SML = 'application/sml+json';
const DEF = 'https://deepbluecltd.github.io/barge-monitor/def/';
const TIME = { type: 'Time', name: 'time', label: 'Time', definition: 'http://www.opengis.net/def/property/OGC/0/SamplingTime', uom: { href: 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian' } };
let failures = 0;
let passes = 0;
function check(ok, what, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `  -- ${detail}` : ''}`);
}

/** One request; `user` null sends no credentials. A body is read as JSON whatever its Content-Type (D-196). */
async function req(method, path, { user = 'owner', body, ctype = 'application/json', headers = {} } = {}) {
  const h = { ...headers };
  if (user) h.authorization = auth(user);
  if (body !== undefined) h['content-type'] = ctype;
  const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}
const get = (p, user = 'owner', headers = {}) => req('GET', p, { user, headers });
const post = (p, body, user = 'owner', ctype = 'application/json') => req('POST', p, { user, body, ctype });
const last = (loc) => loc.replace(/\/+$/, '').split('/').pop();

async function systems(user = 'owner') {
  const r = await get(`/systems?searchMembers=true&f=${encodeURIComponent(SML)}&limit=100000`, user);
  return new Map((r.json?.items ?? []).map((s) => [s.uniqueId, s.id]));
}

try {
  // --- authentication (§9.3, AT-49) ---------------------------------------------------------------
  for (const p of ['/', '/systems', '/datastreams', '/profile.json']) {
    const r = await get(p, null);
    check(r.status === 401 && (r.headers.get('content-type') ?? '').startsWith('text/html'), `${p} without credentials: 401, an HTML page`, String(r.status));
    check((r.headers.get('www-authenticate') ?? '').toLowerCase() === 'basic', `${p}: WWW-Authenticate: basic, as OpenSensorHub (the relay drops it, D-226)`);
    check((await get(p, 'nobody')).status === 401, `${p} with a wrong password: 401`);
  }
  check((await get('/')).status === 200, 'the landing page with credentials');
  const conf = (await get('/conformance')).json;
  check(['datastream', 'controlstream', 'swecommon-json'].every((c) => conf.conformsTo.includes(`http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/${c}`)), 'conformance claims Part 2');

  // --- discovery (§9.1, D-193) ----------------------------------------------------------------------
  const sy = await systems();
  for (const u of ['platform:barge', 'sensor:bow', 'sensor:stern', 'sensor:bow:co2', 'sensor:stern:co2', 'process:models', 'process:data-cleanse',
    'process:summaries', 'process:analysis', 'workspace:owner', 'workspace:friend']) check(sy.has(URN + u), `discovery by searchMembers finds ${u}`);
  check([...sy.values()].every((id) => /^[0-9a-v]{4}$/.test(id)), 'identifiers are opaque (four base-32 characters)');
  const top = (await get(`/systems?f=${encodeURIComponent(SML)}`)).json.items.map((s) => s.uniqueId);
  check(top.includes(URN + 'platform:barge') && !top.includes(URN + 'sensor:bow'), 'GET /systems lists the top level only');
  const listed = (await get('/systems?searchMembers=true')).json.items;
  check(listed.every((s) => s.type === 'Feature' && s.properties.uid), 'the default listing is GeoJSON, with properties.uid');
  check(listed.every((s) => !s.links.some((l) => l.rel === 'parent')), 'a listing carries no parent link');
  check((await get(`/systems/${sy.get(URN + 'sensor:bow')}`)).json.links.some((l) => l.rel === 'parent'), 'a single system links its parent');
  check((await get('/collections/all_systems/items')).status === 400, 'collections/all_systems/items answers 400, as OpenSensorHub');
  const prof = await get('/profile.json');
  check(prof.status === 200 && prof.json?.essentials?.length > 0, 'the profile is beside the API, with credentials');
  check(!(await get('/')).json.links.some((l) => String(l.href).endsWith('profile.json')), 'the profile is not linked from the landing page');
  check(!(await get('/')).headers.get('x-server-instance') && !(await get('/')).headers.get('etag'), 'no instance identifier');

  // --- observations (§9.1) -------------------------------------------------------------------------
  const bow = sy.get(URN + 'sensor:bow');
  const weather = (await get(`/systems/${bow}/datastreams`)).json.items.find((d) => d.outputName.startsWith('weather__'));
  const start = weather.phenomenonTime[0];
  const a = (await get(`/datastreams/${weather.id}/observations?f=${encodeURIComponent(SWE)}&phenomenonTime=${start}/..&limit=20`)).json;
  const b = await get(`/datastreams/${weather.id}/observations?f=${encodeURIComponent(SWE)}&phenomenonTime=${start}/..&limit=10&offset=10`);
  check(a.length === 20 && a[0].time === start, 'SWE JSON observations from the start');
  check(JSON.stringify(b.json) === JSON.stringify(a.slice(10)) && !b.headers.get('link'), 'paged by offset, with no next link in SWE JSON');
  const def = await get(`/datastreams/${weather.id}/observations?limit=2`, 'owner', { accept: SWE });
  check(def.json?.items?.length === 2, 'Accept is ignored: the default is application/json observation resources');
  check(Array.isArray((await get(`/datastreams/${weather.id}/observations?f=${encodeURIComponent(SWE)}&limit=200001`)).json), 'a limit over the maximum is served');

  // --- a model registers (FR-28): 201 with the existing Location; one observation per POST --------------
  const user = 'svc-new-model-2';
  const models = sy.get(URN + 'process:models');
  const sysBody = { type: 'SimpleProcess', uniqueId: URN + 'process:new-model-2', label: 'New model 2', assetType: 'Process' };
  const s1 = await post(`/systems/${models}/subsystems`, sysBody, user, SML);
  const s2 = await post(`/systems/${models}/subsystems`, sysBody, user, SML);
  check(s1.status === 201 && s2.status === 201 && s1.headers.get('location') === s2.headers.get('location'), 'creating again: 201 with the existing Location (AT-29)');
  const sid = last(s1.headers.get('location'));
  check((await post(`/systems/${models}/subsystems`, { ...sysBody, uniqueId: URN + 'process:new-model-2:x' }, user)).status === 400, 'SensorML as application/json is read as GeoJSON and refused (D-194)');
  const dsBody = (out, uom) => ({ name: out, outputName: out, schema: { obsFormat: SWE, recordSchema: { type: 'DataRecord', name: 'record', label: out,
    fields: [TIME, { type: 'Quantity', name: 'x', label: 'X', definition: DEF + 'x', uom: { code: uom } }] } } });
  check((await post(`/systems/${sid}/datastreams`, dsBody('check-ppm', 'ppm'), user)).status === 400, 'a unit code that is not UCUM is refused (ppm, D-195)');
  const d1 = await post(`/systems/${sid}/datastreams`, dsBody('check', '1'), user);
  const d2 = await post(`/systems/${sid}/datastreams`, dsBody('check', '1'), user);
  check(d1.status === 201 && d1.headers.get('location') === d2.headers.get('location'), 'a datastream created again: the same Location');
  const ds = last(d1.headers.get('location'));
  check((await post(`/datastreams/${ds}/observations`, [{ time: '2031-04-07T00:00:00Z', x: 1 }], user, SWE)).status === 400, 'an array of observations is refused');
  check((await post(`/datastreams/${ds}/observations`, { time: '2031-04-07T00:00:00Z', x: null }, user, SWE)).status === 400, 'null in a Quantity is refused');
  check((await post(`/datastreams/${ds}/observations`, { time: '2031-04-07T00:00:00Z', x: 1.5 }, user, SWE)).status === 201, 'one observation per POST');
  check((await post(`/datastreams/${ds}/observations`, { time: '2031-04-07T00:00:01Z', x: 'NaN' }, user, SWE)).status === 201, '"NaN" for a missing value');
  const rows = (await get(`/datastreams/${ds}/observations?f=${encodeURIComponent(SWE)}`, user)).json;
  check(JSON.stringify(rows.map((r) => r.x)) === '[1.5,"NaN"]', 'a missing value is read back as "NaN"', JSON.stringify(rows));

  // --- PUT, PATCH, DELETE (§9.1, D-224) ------------------------------------------------------------
  for (const [m, p, u] of [['PUT', `/systems/${bow}`, 'owner'], ['DELETE', `/systems/${bow}`, 'owner'], ['PATCH', `/systems/${sid}`, user],
    ['DELETE', `/datastreams/${ds}`, user], ['PUT', `/datastreams/${ds}/observations`, user]]) {
    check((await req(m, p, { user: u, body: m === 'DELETE' ? undefined : {} })).status === 405, `${m} ${p.split('/')[1]}: 405`);
  }
  check((await get(`/datastreams/${ds}`)).status === 200 && (await get(`/systems/${bow}`)).status === 200, 'nothing was removed');

  // --- permissions (§9.3, FR-93 as relaxed in 4.7) ----------------------------------------------------
  const analyser = sy.get(URN + 'sensor:bow:co2');
  const co2Body = { name: 'Bow CO₂', outputName: 'co2__check', schema: { obsFormat: SWE, recordSchema: { type: 'DataRecord', name: 'record', label: 'CO₂',
    fields: [TIME, { type: 'Quantity', name: 'co2', label: 'CO₂', definition: DEF + 'co2', uom: { code: '[ppm]' } }] } } };
  const c1 = await post(`/systems/${analyser}/datastreams`, co2Body, 'svc-importer');
  check(c1.status === 201, 'the importer\'s account creates a CO₂ datastream under the analyser');
  const co2 = last(c1.headers.get('location'));
  await post(`/datastreams/${co2}/observations`, { time: '2031-04-07T00:00:00Z', co2: 430 }, 'svc-importer', SWE);
  check((await systems('friend')).has(URN + 'sensor:bow:co2'), 'the friend finds the CO₂ analyser listed');
  check((await get('/datastreams?limit=1000', 'friend')).json.items.some((d) => d.id === co2), 'and its datastream listed');
  // D-351: a stream's title and schema may be known; its contents are refused.
  for (const p of [`/systems/${analyser}`, `/datastreams/${co2}`, `/datastreams/${co2}/schema?obsFormat=${encodeURIComponent(SWE)}`]) {
    check((await get(p, 'friend')).status === 200, `the friend reading ${p.split('?')[0]}: described (D-351)`);
  }
  for (const p of [`/datastreams/${co2}/observations`, `/datastreams/${co2}/observations?resultTime=latest`]) {
    check((await get(p, 'friend')).status === 403, `the friend reading ${p}: 403`);
    check((await get(p, 'owner')).status === 200 && (await get(p, 'analyst')).status === 200, `the owner and the analyst read ${p}`);
  }
  check((await get(`/systems/${sy.get(URN + 'workspace:owner')}`, 'friend')).status === 403, 'another user\'s workspace: 403 (AT-52)');
  check((await post(`/systems/${bow}/datastreams`, dsBody('x', '1'), 'friend')).status === 403, 'a user creates nothing under a sensor');
  check((await post(`/systems/${sy.get(URN + 'process:data-cleanse')}/datastreams`, dsBody('x', '1'), user)).status === 403, 'a service account creates nothing under another model');
  check((await post(`/systems/${sy.get(URN + 'workspace:friend')}/datastreams`, dsBody('mine', '1'), 'friend')).status === 201, 'a user creates under its own workspace');
  check((await post(`/datastreams/${ds}/observations`, { time: '2031-04-07T00:00:09Z', x: 1 }, 'owner', SWE)).status === 403, 'the owner appends nothing to a model\'s datastream');
  await control('set-role', { user: 'friend', role: 'viewer-emissions' });
  check((await get(`/datastreams/${co2}/observations`, 'friend')).status === 200, 'a role change takes effect on the next request (FR-116)');
  await control('set-role', { user: 'friend', role: 'viewer' });
  check((await get(`/datastreams/${co2}/observations`, 'friend')).status === 403, 'and back');

  // --- commands: pushed on the internal endpoint (§9.1, §9.2) ------------------------------------------
  const csBody = { name: 'Check', inputName: 'check', schema: { commandFormat: 'application/json', parametersSchema: { type: 'DataRecord', name: 'record', label: 'Check',
    fields: [{ type: 'Quantity', name: 'level', label: 'Level', definition: DEF + 'level', uom: { code: '1' }, constraint: { type: 'AllowedValues', intervals: [[1, 10]] } }] } } };
  const cs = last((await post(`/systems/${sid}/controlstreams`, csBody, user)).headers.get('location'));
  let t0 = Date.now();
  const dropped = await post(`/controlstreams/${cs}/commands`, { parameters: { level: 2 } });
  check(dropped.status === 202 && Date.now() - t0 >= HOLD_S * 1000 - 50, 'without a subscriber: 202 after the hold, and dropped');
  check(!(await get(`/controlstreams/${cs}/commands`)).json.items.length, 'a dropped command is not listed');
  check((await post(`/controlstreams/${cs}/commands`, { parameters: {} })).status === 400, 'every parameter on every command');
  check((await get(`/controlstreams/${cs}/commands?subscribe=1`, user)).status === 403, 'no subscription on the public endpoint (D-223)');
  check((await get(`/api-internal/controlstreams/${cs}/commands?subscribe=1`, 'owner')).status === 403, 'the internal endpoint is for service accounts only');
  check((await get(`/api-internal/controlstreams/${cs}/commands?subscribe=1`, null)).status === 401, 'and needs credentials');
  const got = [];
  const ch = new PushChannel(`${B}/api-internal/controlstreams/${cs}/commands`, auth(user));
  const opened = await new Promise((res) => {
    ch.onopen = () => res(true);
    ch.onclose = () => res(false);
    setTimeout(() => res(false), 5000);
  });
  check(opened && ch.readyState === PushChannel.OPEN, 'PushChannel opens a subscription on the internal endpoint');
  const line = new Promise((res) => {
    ch.onmessage = (e) => {
      got.push(JSON.parse(e.data));
      res(true);
    };
    setTimeout(() => res(false), 5000);
  });
  t0 = Date.now();
  const sent = post(`/controlstreams/${cs}/commands`, { parameters: { level: 3 } });
  check(await line, 'a command is pushed to the subscriber');
  check(Date.now() - t0 < HOLD_S * 1000, 'at once, before the sender\'s answer');
  const cmd = got[0];
  check(cmd?.parameters?.level === 3 && cmd?.sender === 'owner' && !!cmd?.id && !!cmd?.issueTime, 'with its parameters, id, issueTime and sender (D-152)', JSON.stringify(cmd));
  for (const statusCode of ['ACCEPTED', 'COMPLETED']) await post(`/controlstreams/${cs}/status`, { 'command@id': cmd.id, statusCode }, user);
  check((await post(`/controlstreams/${cs}/status`, { 'command@id': cmd.id, statusCode: 'COMPLETED' }, 'owner')).status === 403, 'only the receiver reports status');
  const answer = await sent;
  check(answer.status === 200 && answer.json.currentStatus === 'PENDING', 'the sender\'s answer: 200 after the hold, PENDING');
  const reports = (await get(`/controlstreams/${cs}/status`)).json.items.filter((r) => r['command@id'] === cmd.id);
  check(JSON.stringify(reports.map((r) => r.statusCode)) === '["ACCEPTED","COMPLETED","PENDING"]', 'PENDING is stored when the POST answers, after COMPLETED', JSON.stringify(reports));
  check(reports.every((r) => r.id && r.reportTime), 'every report has its own id and reportTime (D-181)');
  const outcome = reports.filter((r) => r.statusCode !== 'PENDING').sort((x, y) => x.reportTime.localeCompare(y.reportTime)).pop();
  check(outcome?.statusCode === 'COMPLETED', 'the outcome is the latest report other than PENDING (D-199)');
  const closed = new Promise((res) => {
    ch.onclose = (e) => res(e);
    setTimeout(() => res(null), 5000);
  });
  await control('restart-server');
  check(!!(await closed), 'a restart ends the subscription (the receiver resubscribes, AT-38)');
  ch.close();

  // --- the core models are subscribed and take commands -------------------------------------------------
  for (let i = 0; i < 100 && (await fetch(B + '/', { headers: { authorization: auth('owner') } }).then((r) => r.status, () => 0)) !== 200; i++) await new Promise((r) => setTimeout(r, 100));
  const dc = (await get(`/systems/${(await systems()).get(URN + 'process:data-cleanse')}/controlstreams`)).json.items[0];
  let sent2 = null;
  for (let i = 0; i < 30; i++) { // the models resubscribe after the restart
    if ((await get(`/controlstreams/${dc.id}`)).json.live) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  sent2 = await post(`/controlstreams/${dc.id}/commands`, { parameters: { spike_threshold: 40 } });
  check(sent2.status === 200, 'Data cleanse is subscribed again after the restart', String(sent2.status));
  const rej = (await get(`/controlstreams/${dc.id}/status`)).json.items.find((r) => r['command@id'] === sent2.json?.id && r.statusCode === 'REJECTED');
  check(!!rej && /spike_threshold/.test(rej.message ?? ''), 'the receiver rejects a bound, naming it (FR-27)', JSON.stringify(rej));

  // --- the CSV importer (interfaces §7), when the harness has the data folder -------------------------
  const imp = (await systems()).get(URN + 'importer');
  check(!!imp, 'the importer registers its system (urn:x-barge:importer)');
  const catDs = (await get(`/systems/${imp}/datastreams`)).json.items.find((d) => d.outputName === 'catalogue');
  const fold = async () => {
    const rows = (await get(`/datastreams/${catDs.id}/observations?f=${encodeURIComponent(SWE)}&limit=100000`)).json;
    const latest = new Map();
    for (const r of rows) latest.set(r.file, r);
    return latest;
  };
  const cat = await fold();
  if (!cat.size) console.log('SKIP  the importer: the harness has no data folder (scripts/build_data_folder.py)');
  else {
    const A = 'MISSION_A_20310407.csv';
    const Cf = 'MISSION_C_20310421.csv';
    check(cat.size === 4 && cat.get(A)?.status === 'imported' && cat.get(A)?.records === 86400, 'the catalogue lists four files, Mission A imported silently');
    check([...cat.values()].filter((r) => r.file !== A).every((r) => r.status === 'not-imported' && r.records === 0 && r.dataset === ''), 'the others not imported, records 0 (D-197)');
    const ics = (await get(`/systems/${imp}/controlstreams`)).json.items.find((c) => c.inputName === 'import');
    const send = (parameters) => post(`/controlstreams/${ics.id}/commands`, { parameters });
    const settle = async (id) => {
      for (let i = 0; i < 100; i++) {
        const st = (await get(`/commands/${id}/status`)).json.items.filter((r) => r.statusCode !== 'PENDING');
        if (st.length && ['COMPLETED', 'FAILED', 'REJECTED'].includes(st[st.length - 1].statusCode)) return st.map((r) => r.statusCode);
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const bad = await send({ action: 'import', file: 'NO_SUCH.csv' });
    check((await settle(bad.json.id))?.pop() === 'REJECTED', 'an unknown file is REJECTED');
    const ok = await send({ action: 'import', file: Cf });
    const codes = await settle(ok.json.id);
    check(codes?.join(',') === ['ACCEPTED', ...Array(10).fill('EXECUTING'), 'COMPLETED'].join(','), 'import: ACCEPTED, EXECUTING every 10 %, COMPLETED', String(codes));
    const c = (await fold()).get(Cf);
    check(c?.status === 'imported' && c.records === 43200 && /^mission-c-20310421-[0-9a-f]{8}$/.test(c.dataset), 'Mission C imported as <slug>-<h8>');
    const sy2 = await systems();
    const stern = (await get(`/systems/${sy2.get(URN + 'sensor:stern')}/datastreams`)).json.items.find((d) => d.outputName === `weather__${c.dataset}`);
    const fields = (await get(`/datastreams/${stern.id}/schema?obsFormat=${encodeURIComponent(SWE)}`)).json.recordSchema.fields.map((f) => f.name);
    check(!fields.includes('apparent_wind_speed') && fields.includes('air_temperature'), 'its stern record has no apparent wind speed (FR-21)');
    const co2ds = (await get(`/systems/${sy2.get(URN + 'sensor:stern:co2')}/datastreams`)).json.items.find((d) => d.outputName === `co2__${c.dataset}`);
    check((await get(`/datastreams/${co2ds.id}/observations`, 'friend')).status === 403 && (await get(`/datastreams/${co2ds.id}/observations`)).status === 200,
      'its CO₂ datastream: 403 for the friend, read by the owner (FR-93)');
  }
} catch (e) {
  failures++;
  console.log(`FAIL  ${e?.stack ?? e}`);
} finally {
  child.kill();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
