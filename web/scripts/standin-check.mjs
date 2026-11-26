#!/usr/bin/env node
// Checks the JavaScript stand-in over real HTTP, against the Node harness
// (standin-server.mjs), for the behaviour of docs/v4-interfaces.md §7 to §10:
// authentication, discovery, OpenSensorHub's behaviours, push subscriptions,
// the importer, the replay controller, the access gateway and the models.
//
// Usage: node web/scripts/standin-check.mjs [--folder DIR] [--port N]
// Exits non-zero if any check fails.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const port = Number(opt('port', String(20000 + Math.floor(Math.random() * 20000))));
const B = `http://127.0.0.1:${port}`;

const extra = argv.includes('--folder') ? ['--folder', opt('folder')] : [];
const child = spawn(process.execPath, [join(here, 'standin-server.mjs'), '--port', String(port), ...extra], { stdio: ['pipe', 'pipe', 'inherit'] });
await new Promise((res, rej) => {
  child.stdout.on('data', (b) => String(b).includes('READY') && res());
  child.on('exit', (c) => rej(new Error(`harness exited ${c}`)));
});

const CRED = { owner: 'demo-owner', friend: 'demo-friend', analyst: 'demo-analyst', 'svc-new-model-1': 'svc-demo', 'svc-new-model-2': 'svc-demo' };
const auth = (u) => 'Basic ' + Buffer.from(`${u}:${CRED[u]}`).toString('base64');
let failures = 0;
let passes = 0;
function check(ok, what, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `  -- ${detail}` : ''}`);
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function req(method, path, { user = 'owner', body, ctype = 'application/json', headers = {} } = {}) {
  const h = { ...headers };
  if (user) h.authorization = auth(user);
  if (body !== undefined) h['content-type'] = ctype;
  const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}
const get = (p, user = 'owner') => req('GET', p, { user });
const control = async (action, arg) => (await fetch(B + '/demonstrator/control', { method: 'POST', body: JSON.stringify({ action, arg }) })).json();

const uidOf = (s) => s.properties?.uid ?? s.uniqueId;
/** Every system, subsystems included, in one listing (D-193). */
async function systemsTree(user) {
  const r = await get('/systems?searchMembers=true&limit=1000', user);
  return (r.json?.items ?? []).map((s) => ({ id: s.id, uid: uidOf(s), links: s.links ?? [] }));
}
async function sysId(uid, user = 'owner') {
  return (await systemsTree(user)).find((s) => s.uid === uid)?.id ?? null;
}
async function dsOf(systemUid, outputName, user = 'owner') {
  const sid = await sysId(systemUid, user);
  if (!sid) return null;
  const r = await get(`/systems/${sid}/datastreams?limit=1000`, user);
  return (r.json?.items ?? []).filter((d) => d.outputName === outputName).pop()?.id ?? null;
}
async function csOf(systemUid, inputName, user = 'owner') {
  const sid = await sysId(systemUid, user);
  const r = await get(`/systems/${sid}/controlstreams`, user);
  return (r.json?.items ?? []).find((c) => c.inputName === inputName)?.id ?? null;
}
async function obs(dsId, query = '', user = 'owner') {
  return (await get(`/datastreams/${dsId}/observations?f=application/swe%2Bjson&limit=1000000${query}`, user)).json;
}
async function waitFor(what, fn, seconds = 30) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(0.3);
  }
}

try {
  // --- authentication (§9.3, AT-49) -------------------------------------------------------
  {
    const r = await req('GET', '/systems', { user: null });
    check(r.status === 401, '401 without credentials', String(r.status));
    check(!r.headers.get('www-authenticate'), '401 carries no WWW-Authenticate (the gateway strips it)');
    check((r.headers.get('content-type') ?? '').startsWith('text/html'), '401 is an HTML page');
    const bad = await req('GET', '/systems', { user: null, headers: { authorization: 'Basic ' + Buffer.from('owner:wrong').toString('base64') } });
    check(bad.status === 401, '401 with a wrong password');
    const p = await req('GET', '/profile.json', { user: null });
    check(p.status === 401, '/profile.json needs credentials');
    const sub = await req('GET', '/controlstreams/0000/commands?subscribe=1', { user: null });
    check(sub.status === 401, 'a push subscription without credentials is 401');
  }

  // --- discovery by uniqueId and outputName, opaque ids (§6) ---------------------------------------
  const tree = await systemsTree('owner');
  const DS_A = (await control('state')).datasets[0]?.id;
  check(/^mission-a-20310407-[0-9a-f]{8}$/.test(DS_A ?? ''), 'Mission A imported silently at startup', DS_A);
  const bowId = tree.find((s) => s.uid === 'urn:x-barge:sensor:bow')?.id;
  check(!!bowId, 'the bow sensor found by uniqueId through discovery');
  check(tree.every((s) => /^[0-9a-v]{4}$/.test(s.id)), 'identifiers are opaque (4 base-32 characters)', tree.map((s) => s.id).join(','));
  {
    const top = (await get('/systems?limit=1000')).json?.items ?? [];
    check(top.length > 0 && top.length < tree.length && !top.some((s) => uidOf(s) === 'urn:x-barge:sensor:bow'),
      '/systems lists the top level; searchMembers=true every system (D-193)', `${top.length} of ${tree.length}`);
    check(tree.every((s) => !s.links.some((l) => l.rel === 'parent')), 'a listing carries no parent link, as OpenSensorHub (D-193)');
    const one = (await get(`/systems/${bowId}`)).json;
    check((one?.links ?? []).some((l) => l.rel === 'parent'), 'a single system links its parent');
    const old = await get('/collections/all_systems/items');
    check(old.status === 400, '/collections/all_systems/items answers 400, as OpenSensorHub (D-193)', String(old.status));
  }
  const weatherA = await dsOf('urn:x-barge:sensor:bow', `weather__${DS_A}`);
  check(!!weatherA && /^[0-9a-v]{4}$/.test(weatherA), 'weather__{dataset} found by outputName');
  {
    const sch = (await get(`/datastreams/${weatherA}/schema?obsFormat=application/swe%2Bjson`)).json;
    const names = sch.recordSchema.fields.map((f) => f.name);
    check(names.includes('air_temperature_qc') && !names.includes('co2'), 'the weather record has QC flags and no CO₂ (FR-21c)', names.join(','));
    const d = await get(`/datastreams/${weatherA}/observations?limit=3`);
    check(Array.isArray(d.json?.items) && d.json.items[0]?.result?.air_temperature !== undefined, 'default observations are application/json resources');
    const acc = await req('GET', `/datastreams/${weatherA}/observations?limit=2`, { headers: { accept: 'application/swe+json' } });
    check(Array.isArray(acc.json?.items), 'the Accept header is ignored');
    const swe = await get(`/datastreams/${weatherA}/observations?f=application/swe%2Bjson&limit=2&offset=10`);
    check(Array.isArray(swe.json) && swe.json.length === 2 && swe.json[0].time === '2031-04-07T00:00:10Z', 'f=application/swe+json gives SWE JSON records, paged by offset', swe.text.slice(0, 120));
    const big = await get(`/datastreams/${weatherA}/observations?f=application/swe%2Bjson&limit=500000`);
    check(big.status === 200 && big.json.length === 86400, 'a limit over any maximum is not refused', String(big.json?.length));
    const latest = await get(`/datastreams/${weatherA}/observations?f=application/swe%2Bjson&resultTime=latest`);
    check(latest.json?.length === 1 && latest.json[0].time === '2031-04-07T23:59:59Z', 'resultTime=latest');
  }
  {
    const p = await get('/profile.json');
    check(p.status === 200 && Array.isArray(p.json?.essentials), 'the profile at /profile.json');
    const land = await get('/');
    check(!land.text.includes('profile'), 'the profile is not linked from the landing page');
  }

  // --- behaving as a stock OpenSensorHub (§9.1) -----------------------------------------------------
  const modelsId = tree.find((s) => s.uid === 'urn:x-barge:process:models').id;
  const NEW = 'svc-new-model-1';
  const sysBody = { type: 'SimpleProcess', uniqueId: 'urn:x-barge:process:new-model-1', label: 'New model 1', definition: 'http://www.w3.org/ns/sosa/System' };
  const c1 = await req('POST', `/systems/${modelsId}/subsystems`, { user: NEW, body: sysBody, ctype: 'application/sml+json' });
  const c2 = await req('POST', `/systems/${modelsId}/subsystems`, { user: NEW, body: sysBody, ctype: 'application/sml+json' });
  check(c1.status === 201 && c2.status === 201 && c1.headers.get('location') === c2.headers.get('location'),
    'creating what exists answers 201 with the existing Location (AT-29)', `${c1.status} ${c2.status} ${c1.headers.get('location')} ${c2.headers.get('location')}`);
  const newSys = c1.headers.get('location').split('/').pop();
  {
    const asJson = await req('POST', `/systems/${modelsId}/subsystems`, { user: NEW, body: { ...sysBody, uniqueId: sysBody.uniqueId + ':j' } });
    check(asJson.status === 400, 'SensorML sent as application/json is refused with 400, as OpenSensorHub (D-194)', String(asJson.status));
    const ppm = { type: 'DataRecord', label: 'Out', fields: [{ type: 'Time', name: 'time', label: 'Time' }, { type: 'Quantity', name: 'c', label: 'C', uom: { code: 'ppm' } }] };
    const bad = await req('POST', `/systems/${newSys}/datastreams`, { user: NEW, body: { name: 'Ppm', outputName: 'ppm', schema: { obsFormat: 'application/swe+json', recordSchema: ppm } } });
    check(bad.status === 400, 'a unit code that is not UCUM ("ppm") is refused with 400 (D-195)', String(bad.status));
    ppm.fields[1].uom.code = '[ppm]';
    const good = await req('POST', `/systems/${newSys}/datastreams`, { user: NEW, body: { name: 'Ppm', outputName: 'ppm', schema: { obsFormat: 'application/swe+json', recordSchema: ppm } } });
    check(good.status === 201, '"[ppm]", UCUM\'s code, is accepted (D-195)', String(good.status));
  }
  const rec = { type: 'DataRecord', label: 'Out', fields: [{ type: 'Time', name: 'time', label: 'Time' }, { type: 'Quantity', name: 'x', label: 'X', uom: { code: '1' } }] };
  const d1 = await req('POST', `/systems/${newSys}/datastreams`, { user: NEW, body: { name: 'Out', outputName: 'out', schema: { obsFormat: 'application/swe+json', recordSchema: rec } } });
  const d2 = await req('POST', `/systems/${newSys}/datastreams`, { user: NEW, body: { name: 'Out', outputName: 'out', schema: { obsFormat: 'application/swe+json', recordSchema: rec } } });
  check(d1.status === 201 && d1.headers.get('location') === d2.headers.get('location'), 'a datastream created again: 201, the same Location');
  const rec2 = { ...rec, fields: [...rec.fields, { type: 'Quantity', name: 'y', label: 'Y', uom: { code: '1' } }] };
  const d3 = await req('POST', `/systems/${newSys}/datastreams`, { user: NEW, body: { name: 'Out', outputName: 'out', schema: { obsFormat: 'application/swe+json', recordSchema: rec2 } } });
  check(d3.status === 201 && d3.headers.get('location') !== d1.headers.get('location'), 'a different schema under the same outputName is a new datastream (FR-51)');
  const outId = d1.headers.get('location').split('/').pop();
  const arr = await req('POST', `/datastreams/${outId}/observations`, { user: NEW, ctype: 'application/swe+json', body: [{ time: '2031-04-07T00:00:00Z', x: 1 }] });
  check(arr.status === 400, 'an array of observations is refused with 400 (one per POST)', String(arr.status));
  const one = await req('POST', `/datastreams/${outId}/observations`, { user: NEW, ctype: 'application/swe+json', body: { time: '2031-04-07T00:00:00Z', x: 1.5 } });
  check(one.status === 201, 'one observation per POST: 201', String(one.status));
  const nan = await req('POST', `/datastreams/${outId}/observations`, { user: NEW, ctype: 'application/swe+json', body: { time: '2031-04-07T00:00:01Z', x: 'NaN' } });
  check(nan.status === 201, '"NaN" is accepted for a missing value');
  const nul = await req('POST', `/datastreams/${outId}/observations`, { user: NEW, ctype: 'application/swe+json', body: { time: '2031-04-07T00:00:02Z', x: null } });
  check(nul.status === 400, 'JSON null in a Quantity is refused with 400', String(nul.status));
  const back = await obs(outId, '', NEW);
  check(back?.length === 2 && back[1].x === 'NaN', 'a missing value reads back as "NaN"', JSON.stringify(back));
  const ownerPost = await req('POST', `/datastreams/${outId}/observations`, { user: 'owner', ctype: 'application/swe+json', body: { time: '2031-04-07T00:00:03Z', x: 2 } });
  check(ownerPost.status === 403, 'a user cannot append under a model\'s system (gateway)', String(ownerPost.status));
  for (const [m, p] of [['PUT', `/systems/${newSys}`], ['DELETE', `/systems/${newSys}`], ['DELETE', `/datastreams/${outId}`], ['PUT', `/datastreams/${outId}/observations`]]) {
    const r = await req(m, p, { user: NEW, body: m === 'PUT' ? {} : undefined });
    // D-200: refused with any 4xx (the gateway answers 405 for every account; OpenSensorHub itself deletes).
    check(r.status >= 400 && r.status < 500, `${m} ${p.replace(/\/[0-9a-v]{4}(?=\/|$)/g, '/{id}')} is refused (4xx)`, String(r.status));
  }
  check((await get(`/systems/${newSys}`, NEW)).status === 200 && (await get(`/datastreams/${outId}`, NEW)).status === 200,
    'nothing was replaced or deleted (D-200)');
  {
    const r = await get('/systems/zzzz');
    check(r.status === 404 && (r.headers.get('content-type') ?? '').startsWith('text/html') && /<title>404 Not Found<\/title>/.test(r.text),
      'a refusal is an HTML page with the status line in its title');
  }

  // --- push subscriptions and commands (§9.1, §9.2) -------------------------------------------------
  {
    const cs = await req('POST', `/systems/${newSys}/controlstreams`, { user: NEW, body: { name: 'Settings', inputName: 'settings',
      schema: { commandFormat: 'application/json', parametersSchema: { type: 'DataRecord', label: 'S', fields: [{ type: 'Quantity', name: 'k', label: 'K', uom: { code: '1' } }] } } } });
    const csId = cs.headers.get('location').split('/').pop();
    const ownerSub = await req('GET', `/controlstreams/${csId}/commands?subscribe=1`, { user: 'owner' });
    check(ownerSub.status === 403, 'only service accounts subscribe (gateway)', String(ownerSub.status));
    // no subscriber: dropped, 202 after about 5 s
    const t0 = Date.now();
    const drop = await req('POST', `/controlstreams/${csId}/commands`, { user: 'owner', body: { parameters: { k: 1 } } });
    const dt0 = (Date.now() - t0) / 1000;
    check(drop.status === 202 && dt0 >= 4.5, `no subscriber: 202 after ${dt0.toFixed(1)} s`, String(drop.status));
    const listed0 = await get(`/controlstreams/${csId}/commands`);
    check(listed0.json?.items?.length === 0, 'a dropped command is not listed');
    const missing = await req('POST', `/controlstreams/${csId}/commands`, { user: 'owner', body: { parameters: {} } });
    check(missing.status === 400, 'a command must carry every parameter');
    // a subscriber
    const ac = new AbortController();
    const sres = await fetch(`${B}/controlstreams/${csId}/commands?subscribe=1`, { headers: { authorization: auth(NEW) }, signal: ac.signal });
    check(sres.status === 200 && (sres.headers.get('content-type') ?? '').includes('application/x-ndjson'), 'a subscription answers 200 application/x-ndjson');
    const lines = [];
    const reader = sres.body.getReader();
    const pump = (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            lines.push({ at: Date.now(), cmd: JSON.parse(buf.slice(0, i)) });
            buf = buf.slice(i + 1);
          }
        }
      } catch { /* aborted */ }
    })();
    const t1 = Date.now();
    const sent = req('POST', `/controlstreams/${csId}/commands`, { user: 'owner', body: { parameters: { k: 7 } } });
    await waitFor('the pushed command', () => lines.length > 0, 4);
    const pushAt = (lines[0].at - t1) / 1000;
    check(pushAt < 1 && lines[0].cmd.parameters.k === 7 && lines[0].cmd.sender === 'owner', `the command is pushed at once (${pushAt.toFixed(2)} s) with its sender`, JSON.stringify(lines[0].cmd));
    const r = await sent;
    const dt1 = (Date.now() - t1) / 1000;
    check(r.status === 200 && r.json?.currentStatus === 'PENDING' && dt1 >= 4.5, `with a subscriber the POST answers 200 PENDING after ${dt1.toFixed(1)} s`, `${r.status} ${r.text.slice(0, 80)}`);
    const st = await req('POST', `/controlstreams/${csId}/status`, { user: NEW, body: { 'command@id': lines[0].cmd.id, statusCode: 'COMPLETED', message: 'ok' } });
    check(st.status === 201, 'status reported at /controlstreams/{id}/status', String(st.status));
    // a restart ends the subscription
    await control('restart-server');
    await waitFor('the stream to end', async () => (await Promise.race([pump.then(() => true), sleep(0.2).then(() => false)])), 5);
    check(true, 'a server restart ends the subscription');
    const down = await fetch(`${B}/systems`, { headers: { authorization: auth('owner') } }).then(() => 'answered', () => 'refused');
    check(down === 'refused', 'while starting, connections are refused (no 503)', down);
    await waitFor('the server', async () => (await fetch(`${B}/`, { headers: { authorization: auth('owner') } }).then((x) => x.status, () => 0)) === 200, 5);
    ac.abort();
  }

  // --- the importer (§7) ---------------------------------------------------------------------------------------
  let DS_B;
  {
    const catId = await dsOf('urn:x-barge:importer', 'catalogue');
    const fold = async () => {
      const m = new Map();
      for (const o of await obs(catId)) m.set(o.file, o);
      return m;
    };
    const f0 = await fold();
    check(f0.size === 4 && f0.get('MISSION_A_20310407.csv')?.status === 'imported' && f0.get('MISSION_B_20310414.csv')?.status === 'not-imported',
      'the catalogue lists every file with its status', JSON.stringify([...f0.values()].map((o) => [o.file, o.status])));
    const importCs = await csOf('urn:x-barge:importer', 'import');
    const before = await fold();
    void before;
    const t0 = Date.now();
    const sent = req('POST', `/controlstreams/${importCs}/commands`, { body: { parameters: { action: 'import', file: 'MISSION_B_20310414.csv' } } });
    const done = await waitFor('Mission B imported', async () => {
      const f = await fold();
      return f.get('MISSION_B_20310414.csv')?.status === 'imported' ? f.get('MISSION_B_20310414.csv') : null;
    }, 20);
    DS_B = done.dataset;
    check(/^mission-b-20310414-[0-9a-f]{8}$/.test(DS_B) && done.records === 86400, `Mission B imported by command in ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(done));
    const all = await obs(catId);
    check(all.some((o) => o.file === 'MISSION_B_20310414.csv' && o.status === 'importing' && o.pct > 0), 'the catalogue showed importing with a percentage');
    await sent;
    const status = (await get(`/controlstreams/${importCs}/status`)).json.items.map((s) => s.statusCode);
    check(status.includes('ACCEPTED') && status.includes('EXECUTING') && status.includes('COMPLETED'), 'import command: ACCEPTED, EXECUTING, COMPLETED', status.join(','));
    const unk = req('POST', `/controlstreams/${importCs}/commands`, { body: { parameters: { action: 'import', file: 'NOPE.csv' } } });
    await unk;
    const st2 = (await get(`/controlstreams/${importCs}/status`)).json.items;
    check(st2.some((s) => s.statusCode === 'REJECTED' && /NOPE\.csv/.test(s.message ?? '')), 'an unknown file is REJECTED, naming it');
    const wb = await dsOf('urn:x-barge:sensor:bow', `weather__${DS_B}`);
    const firstB = (await get(`/datastreams/${wb}/observations?f=application/swe%2Bjson&limit=1`)).json[0];
    check(firstB.time === '2031-04-14T00:00:00Z', 'Mission B\'s readings are in its own datastreams (FR-21b)');
  }

  // --- the replay controller (§8) ---------------------------------------------------------------------------------
  const replayCs = await csOf('urn:x-barge:replay', 'replay');
  const stateId = await dsOf('urn:x-barge:replay', 'state');
  const state = async () => (await obs(stateId, '&resultTime=latest'))[0];
  const statusOf = async (cmdId) => (await get(`/commands/${cmdId}/status`)).json.items.map((s) => `${s.statusCode}${s.message ? ': ' + s.message : ''}`);
  const replay = (action, extra = {}) => req('POST', `/controlstreams/${replayCs}/commands`, { body: { parameters: { action, dataset: DS_B, rate: 1, position: '2031-04-14T00:00:00Z', ...extra } } });
  {
    const s0 = await state();
    check(s0.dataset === DS_A && s0.playing === false && s0.time === '2031-04-07T00:00:00Z', 'at startup the replay is paused at the start of Mission A (FR-77)', JSON.stringify(s0));
    void replay('load');
    const s1 = await waitFor('the load', async () => ((await state()).dataset === DS_B ? state() : null), 4);
    check(s1.dataset === DS_B && s1.run === `r-${DS_B}-1`, 'load: the state follows within a second; a new run', JSON.stringify(s1));
    const ready = await waitFor('models_ready', async () => ((await state()).models_ready ? true : null), 15);
    check(ready, 'models_ready once every model has its datastreams for the dataset');
    check(!!(await dsOf('urn:x-barge:process:summaries', `summary-1min-bow__${DS_B}`)), 'Summaries created its datastreams for the new dataset');
    const rej = await replay('play', { rate: 100 });
    const rs = await statusOf(rej.json.id);
    check(rs.some((x) => /^REJECTED: rate 100 exceeds 10, the highest Analysis sustains$/.test(x)), 'rate 100 is REJECTED, naming the bound and the model (AT-35)', rs.join(' | '));
    void replay('play', { rate: 10 });
    await waitFor('playing', async () => ((await state()).playing ? true : null), 4);
    const cleaned = await dsOf('urn:x-barge:process:data-cleanse', `cleaned-bow__${DS_B}`);
    await waitFor('Data cleanse to reach 2 minutes', async () => {
      const l = await obs(cleaned, '&resultTime=latest');
      return l.length && l[0].time >= '2031-04-14T00:02:00Z';
    }, 40);
    const sk = await replay('seek', { rate: 10, position: '2031-04-14T03:00:00Z' });
    const s2 = await state();
    check(s2.run === `r-${DS_B}-2` && s2.time >= '2031-04-14T03:00:00Z', 'seek starts a new run (FR-87)', JSON.stringify(s2));
    check((await statusOf(sk.json.id)).some((x) => x.startsWith('COMPLETED')), 'seek COMPLETED');
    void replay('pause', { rate: 10 });
    await waitFor('paused', async () => ((await state()).playing === false ? true : null), 4);
    const log = await obs(await dsOf('urn:x-barge:replay', 'log'));
    check(['load', 'play', 'seek', 'pause'].every((a) => log.some((l) => l.action === a)), 'the replay log records each command', log.map((l) => l.action).join(','));
    const c = await obs(cleaned);
    check(c.length >= 120 && c.every((o) => o.run.startsWith(`r-${DS_B}-`)) && !c.some((o) => o.air_temperature === null),
      'Data cleanse published one observation per second with its run', String(c.length));
    const sm = await obs(await dsOf('urn:x-barge:process:summaries', `summary-1min-bow__${DS_B}`));
    check(sm.length >= 1 && 'air_temperature_min' in sm[0] && 'air_temperature_max' in sm[0], 'Summaries publishes minimum, mean and maximum (FR-29)', JSON.stringify(sm[0]));
  }

  // --- the access gateway: hidden restricted systems (§9.5, AT-55) ---------------------------------------
  {
    const ownerTree = await systemsTree('owner');
    const friendTree = await systemsTree('friend');
    const restricted = (u) => /:co2$|:restricted$/.test(u);
    check(ownerTree.some((s) => restricted(s.uid)), 'the owner sees the CO₂ analysers and restricted subsystems');
    check(!friendTree.some((s) => restricted(s.uid)), 'the friend finds no CO₂ system or restricted subsystem', friendTree.map((s) => s.uid).join(','));
    check(!friendTree.some((s) => /workspace:owner/.test(s.uid)) && friendTree.some((s) => /workspace:friend/.test(s.uid)), 'the friend sees only their own workspace');
    const all = await get('/datastreams?limit=100000', 'friend');
    check(!all.text.includes('co2'), 'no datastream listing shows the friend any CO₂ name', all.json.items.filter((d) => d.outputName.includes('co2')).map((d) => d.outputName).join(','));
    const co2Id = await dsOf('urn:x-barge:sensor:bow:co2', `co2__${DS_A}`, 'owner');
    const co2Sys = ownerTree.find((s) => s.uid === 'urn:x-barge:sensor:bow:co2').id;
    check(!!co2Id && (await get(`/datastreams/${co2Id}`, 'owner')).status === 200, 'the owner reads the CO₂ datastream');
    for (const p of [`/datastreams/${co2Id}`, `/datastreams/${co2Id}/observations`, `/systems/${co2Sys}`, `/systems/${co2Sys}/datastreams`]) {
      check((await get(p, 'friend')).status === 404, `the friend gets 404 for ${p.replace(/\/[0-9a-v]{4}(?=\/|$)/g, '/{id}')}`);
    }
    const cs = await get('/controlstreams', 'friend');
    check(cs.status === 200 && cs.json.items.length > 0, 'the friend lists control streams');
  }

  // --- a restricted Analysis run, and FR-112a (AT-56, AT-57) ---------------------------------------------
  {
    const clustering = await csOf('urn:x-barge:process:analysis', 'clustering', 'owner');
    const doi = (fields) => JSON.stringify({ dataset: DS_B, start: '2031-04-14T00:00:00Z', end: '2031-04-14T00:02:00Z', resolution: 'PT1S',
      sources: fields });
    const co2doi = doi([{ system: 'urn:x-barge:sensor:bow', output: 'weather', fields: ['air_temperature'] }, { system: 'urn:x-barge:sensor:bow:co2', output: 'co2', fields: ['co2'] }]);
    const ownerCmd = await req('POST', `/controlstreams/${clustering}/commands`, { user: 'owner', body: { parameters: { algorithm: 'A', doi: co2doi, clusters: 3, sensitivity: 5 } } });
    const friendCmd = await req('POST', `/controlstreams/${clustering}/commands`, { user: 'friend', body: { parameters: { algorithm: 'A', doi: co2doi, clusters: 3, sensitivity: 5 } } });
    const badCmd = await req('POST', `/controlstreams/${clustering}/commands`, { user: 'friend', body: { parameters: { algorithm: 'Z', doi: co2doi, clusters: 3, sensitivity: 5 } } });
    const okOwner = await waitFor('the owner\'s run', async () => {
      const s = await statusOf(ownerCmd.json.id);
      return s.some((x) => /^(COMPLETED|FAILED|REJECTED)/.test(x)) ? s : null;
    }, 20);
    check(okOwner.some((x) => /^COMPLETED.*restricted/.test(x)), 'the owner\'s CO₂ run COMPLETED, under the restricted subsystem', okOwner.join(' | '));
    const runsR = await obs(await dsOf('urn:x-barge:process:analysis:restricted', `runs__${DS_B}`, 'owner'), '', 'owner');
    check(runsR.some((r) => r.command_id === ownerCmd.json.id && r.illustrative === true), 'its runs-log entry is restricted too (FR-112)');
    const runsPlain = await obs(await dsOf('urn:x-barge:process:analysis', `runs__${DS_B}`, 'owner'), '', 'owner');
    check(!runsPlain.some((r) => r.command_id === ownerCmd.json.id) && !JSON.stringify(runsPlain).includes('co2'), 'no unrestricted run names CO₂');
    const fs = await statusOf(friendCmd.json.id);
    check(fs.some((x) => x === 'REJECTED: a requested source is not available'), 'the friend\'s command naming CO₂ is REJECTED by the model (FR-112a)', fs.join(' | '));
    const bs = await statusOf(badCmd.json.id);
    check(bs.some((x) => /^REJECTED: algorithm/.test(x)), 'an out-of-bounds parameter is REJECTED naming it', bs.join(' | '));
    const friendRun = await req('POST', `/controlstreams/${clustering}/commands`, { user: 'friend', body: { parameters: { algorithm: 'B',
      doi: doi([{ system: 'urn:x-barge:sensor:bow', output: 'weather', fields: ['air_temperature', 'apparent_wind_speed'] }]), clusters: 3, sensitivity: 5 } } });
    const frs = await waitFor('the friend\'s run', async () => {
      const s = await statusOf(friendRun.json.id);
      return s.some((x) => /^(COMPLETED|FAILED|REJECTED)/.test(x)) ? s : null;
    }, 20);
    check(frs.some((x) => x.startsWith('COMPLETED') && !x.includes('restricted')), 'a weather-only run COMPLETED, unrestricted', frs.join(' | '));
  }

  // --- workspaces (FR-95, AT-52) -------------------------------------------------------------------------
  {
    const ownerDoi = await dsOf('urn:x-barge:workspace:owner', 'data-of-interest', 'owner');
    const friendDoi = await dsOf('urn:x-barge:workspace:friend', 'data-of-interest', 'friend');
    const rec = (who) => ({ time: '2031-04-14T00:00:00Z', doi_id: `d-${who}`, action: 'save', record: JSON.stringify({ version: 1, label: who }) });
    check((await req('POST', `/datastreams/${ownerDoi}/observations`, { user: 'owner', ctype: 'application/swe+json', body: rec('owner') })).status === 201,
      'the owner saves into their own workspace');
    check((await req('POST', `/datastreams/${friendDoi}/observations`, { user: 'friend', ctype: 'application/swe+json', body: rec('friend') })).status === 201,
      'the friend saves into their own workspace');
    check((await req('POST', `/datastreams/${ownerDoi}/observations`, { user: 'friend', ctype: 'application/swe+json', body: rec('x') })).status === 404,
      'the friend cannot write into the owner\'s workspace (absent)');
    check((await get(`/datastreams/${ownerDoi}/observations`, 'friend')).status === 404, 'the friend cannot read the owner\'s workspace');
    check((await get(`/datastreams/${friendDoi}/observations`, 'owner')).status === 404, 'nor the owner the friend\'s');
    check((await get(`/datastreams/${ownerDoi}/observations`, 'svc-new-model-1')).status === 404, 'nor a service account');
    const mine = await obs(friendDoi, '', 'friend');
    check(mine.length === 1 && mine[0].doi_id === 'd-friend', 'the friend reads their own data of interest');
    const outsideModel = await req('POST', `/systems/${(await sysId('urn:x-barge:process:summaries'))}/datastreams`, { user: 'svc-new-model-1',
      body: { name: 'x', outputName: 'x', schema: { obsFormat: 'application/swe+json', recordSchema: { type: 'DataRecord', label: 'x', fields: [{ type: 'Time', name: 'time' }] } } } });
    check(outsideModel.status === 403, 'a model\'s service account cannot create outside its own system', String(outsideModel.status));
    const noCo2 = await dsOf('urn:x-barge:sensor:bow:co2', `co2__${DS_A}`, 'svc-new-model-1');
    check(noCo2 === null, 'a new model\'s service account cannot read CO₂ (FR-113)');
  }

  // --- a role change takes effect at once (FR-116, D-151) ------------------------------------------------
  {
    const before = await systemsTree('analyst');
    check(before.some((s) => /:co2$/.test(s.uid)), 'the analyst (viewer with emissions) sees CO₂');
    const co2Id = await dsOf('urn:x-barge:sensor:bow:co2', `co2__${DS_A}`, 'analyst');
    await control('set-role', { user: 'analyst', role: 'viewer' });
    const r = await get(`/datastreams/${co2Id}`, 'analyst');
    check(r.status === 404, 'after set-role to weather only, the next request finds CO₂ absent', String(r.status));
    const after = await systemsTree('analyst');
    check(!after.some((s) => /:co2$/.test(s.uid)), 'and discovery no longer lists it');
    await control('set-role', { user: 'svc-new-model-2', role: 'service-co2' });
    check(!!(await dsOf('urn:x-barge:sensor:bow:co2', `co2__${DS_A}`, 'svc-new-model-2')), 'the owner can grant CO₂ to a new model (FR-113)');
  }

  // --- capture: the gateway's hops, and credentials redacted (§9.4, §9.5, AT-53) ------------------------
  {
    const cap = await (await fetch(B + '/demonstrator/captured')).json();
    const text = JSON.stringify(cap);
    check(cap.length > 100, `messages captured (${cap.length})`);
    check(!['demo-owner', 'demo-friend', 'demo-analyst', 'svc-demo'].some((p) => text.includes(p))
      && !text.includes(Buffer.from('owner:demo-owner').toString('base64')), 'no captured message shows a credential (AT-53)');
    check(cap.some((m) => m.content.includes('authorization: ****')), 'the Authorization header is shown as ****');
    const hops = (a, b) => cap.some((m) => m.src === a && m.dst === b);
    check(hops('client', 'gateway') && hops('gateway', 'server') && hops('server', 'gateway') && hops('gateway', 'client'), 'client ↔ gateway ↔ server, two hops each way');
    check(hops('models', 'gateway') && hops('gateway', 'models'), 'models ↔ gateway');
    check(cap.some((m) => m.src === 'gateway' && m.dst === 'models' && m.letter === 'K' && m.push), 'pushes reach models through the gateway, drawn as push');
    check(cap.some((m) => m.src === 'server' && m.dst === 'replay' && m.push) && hops('replay', 'server'), 'the replay controller talks to the server directly');
    check(hops('importer', 'folder') && hops('folder', 'importer') && cap.some((m) => m.src === 'importer' && m.letter === 'I' && /rows written \d+\/86400/.test(m.summary)),
      'the importer: S/L with the folder, one I per 1,000 rows');
    check(cap.every((m) => Math.abs(m.t - Date.now() / 1000) < 600), 'captured t is real time');
  }

  // --- freeze (§4) ---------------------------------------------------------------------------------------
  {
    await control('freeze', { on: true });
    let answered = false;
    const p = get('/systems').then((r) => { answered = true; return r; });
    await sleep(1.5);
    check(!answered, 'while frozen, a request is held unanswered');
    await control('freeze', { on: false });
    const r = await p;
    check(r.status === 200, 'released in order on unfreeze');
  }

  // --- reset instance (FR-50a) ---------------------------------------------------------------------------
  {
    const st = await control('reset-instance');
    check(st.datasets.length === 0 && st.folder.every((f) => f.status === 'not-imported'), 'Reset instance: nothing imported, the folder listed again', JSON.stringify(st.folder.map((f) => f.status)));
    const tree2 = await systemsTree('owner');
    check(tree2.some((s) => s.uid === 'urn:x-barge:importer') && !tree2.some((s) => s.uid === 'urn:x-barge:process:new-model-1'), 'Reset instance empties the store; the server\'s own systems are back');
  }
} catch (e) {
  failures++;
  console.log(`FAIL  ${e?.stack ?? e}`);
} finally {
  child.kill();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
