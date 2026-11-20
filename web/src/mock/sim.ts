// An ILLUSTRATIVE stand-in for the Python backend, used only when the browser
// has WebAssembly switched off and Pyodide cannot run (decision D-41).
//
// It is not a port. Readings are simple deterministic functions of time (a day
// cycle, reach-like steps, noise, the odd spike); analysis outputs are
// plausible but unscored. It answers the same Connected Systems interface the
// display client uses, so the client, the relay and the shell run unchanged,
// and it reports lettered messages on the same flowchart edges.
import profile from '../../../contracts/profile.json';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const SIM_EPOCH_UNIX = 1933286400;
const SOSA = 'http://www.w3.org/ns/sosa/';
const DEF = 'https://deepbluecltd.github.io/barge-monitor/def/';
const QARTOD = 'https://ioos.github.io/qartod/';
const RATES = [0.1, 0.25, 0.5, 1, 2];
const HISTORY_S = 28 * 86400;
const MAX_LIMIT = 100_000;

// --- message capture, as the Python tap does ---------------------------------------
export interface TapMsg { id: number; t: number; src: string; dst: string; letter: string; summary: string; content: string; failed: boolean; chain: string | null; hop: number }
let ids = 1;
export class Tap {
  buffer: TapMsg[] = [];
  counts: Record<string, number> = {};
  chain: { id: string; hop: number } | null = null;
  constructor(private now: () => number) {}
  emit(src: string, dst: string, letter: string, summary: string, content: unknown = '', failed = false) {
    const key = `${src}>${dst}:${letter}`;
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    const c = typeof content === 'string' ? content : JSON.stringify(content);
    this.buffer.push({ id: ids++, t: this.now(), src, dst, letter, summary, content: c.slice(0, 4000), failed,
      chain: this.chain?.id ?? null, hop: this.chain ? ++this.chain.hop : 0 });
  }
  drain() {
    const b = this.buffer;
    this.buffer = [];
    return b;
  }
}

// --- the clock ------------------------------------------------------------------------
export class Clock {
  t = HISTORY_S;
  rate = 0.5;
  playing = false;
  private last = performance.now();
  now() {
    const h = performance.now();
    if (this.playing) this.t += ((h - this.last) / 1000) * this.rate;
    this.last = h;
    return this.t;
  }
  state() {
    return { t: this.now(), rate: this.rate, playing: this.playing, rates: RATES, default_rate: 0.5 };
  }
}

// --- illustrative signals ------------------------------------------------------------
/** Deterministic pseudo-noise in [-1, 1) from integers: no stored state. */
function hash(a: number, b: number, c: number) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
}
const REACH = [ // illustrative reaches the barge passes through, 12 minutes each
  { dT: 0, dRH: 0, wind: 1, sun: 1 }, { dT: 0.4, dRH: 3, wind: 0.45, sun: 0.75 }, { dT: -3, dRH: 9, wind: 0.08, sun: 0 },
  { dT: -0.8, dRH: 5, wind: 0.5, sun: 0.45 }, { dT: -0.6, dRH: -2, wind: 1.5, sun: 1 }, { dT: 1.6, dRH: -6, wind: 0.7, sun: 0.9 },
];
const PARAMS = ['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure', 'apparent_wind_direction', 'solar_irradiance', 'water_temperature'];
const SIGMA: Record<string, number> = { air_temperature: 0.08, apparent_wind_speed: 0.25, relative_humidity: 0.8, pressure: 0.05, apparent_wind_direction: 4, solar_irradiance: 8, water_temperature: 0.04 };
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function reading(sensor: string, t: number): Record<string, number | string> {
  const tt = sensor === 'stern' ? t - 11 : t; // the stern meets each reach about 11 s later
  const r = REACH[Math.floor(tt / 720) % REACH.length];
  const h = ((t / 3600) % 24 + 24) % 24;
  const front = Math.tanh((((t / 86400) % 3.3) - 1.6) * 3); // an air-mass change every few days
  const day = Math.max(0, Math.sin((Math.PI * (h - 6)) / 12));
  const s = sensor === 'bow' ? 1 : 2;
  const n = (k: number) => hash(Math.floor(t), s, k);
  const v: Record<string, number> = {
    air_temperature: 14 + 3 * front + 3.5 * Math.cos((2 * Math.PI * (h - 15)) / 24) + r.dT + SIGMA.air_temperature * n(1),
    relative_humidity: Math.min(100, 72 - 8 * front - 6 * Math.cos((2 * Math.PI * (h - 15)) / 24) + r.dRH + SIGMA.relative_humidity * n(2)),
    pressure: 1012 + 6 * front + 1.5 * Math.sin((2 * Math.PI * t) / 40000) + SIGMA.pressure * n(3),
    apparent_wind_speed: Math.max(0, (5 + 2 * Math.sin((2 * Math.PI * t) / 10800) + 0.8 * Math.sin((2 * Math.PI * t) / 300)) * r.wind + SIGMA.apparent_wind_speed * n(4)),
    apparent_wind_direction: ((((220 + 60 * front + 40 * Math.sin((2 * Math.PI * t) / 18000) + 4 * n(5)) % 360) + 360) % 360),
    solar_irradiance: Math.max(0, 850 * day * r.sun + SIGMA.solar_irradiance * n(6)),
    water_temperature: 13 + 1.5 * front + 0.3 * Math.cos((2 * Math.PI * (h - 17)) / 24) + SIGMA.water_temperature * n(7),
  };
  const out: Record<string, number | string> = {};
  for (const p of PARAMS) {
    let x = v[p];
    const spike = hash(Math.floor(t), s, 100 + PARAMS.indexOf(p)) > 0.9996;
    if (spike) x += 25 * SIGMA[p];
    out[p] = round(x, p === 'apparent_wind_direction' ? 0 : 1);
    out[`${p}_qc`] = spike ? '3' : '1';
  }
  out.precipitation_type = front > 0.5 && h > 12 ? 'drizzle' : 'none';
  return out;
}

function record(t: number, v: Record<string, number | string>) {
  // An illustrative fixed-width record, for the L messages on the flowchart.
  const ticks = Math.round((SIM_EPOCH_UNIX + t - 757382400) * 2);
  const m = (x: number) => (x < 0 ? 'M' + String(Math.round(-x * 10)).padStart(3, '0') : String(Math.round(x * 10)).padStart(4, '0'));
  return `${String(ticks).padStart(10, '0')} A ${m(+v.air_temperature)} ${String(Math.round(+v.relative_humidity)).padStart(3, '0')} ${String(Math.round(+v.pressure * 10)).padStart(5, '0')} ${String(Math.round(+v.apparent_wind_speed * 10)).padStart(3, '0')} ${String(Math.round(+v.apparent_wind_direction)).padStart(3, '0')} ${String(Math.round(+v.solar_irradiance)).padStart(4, '0')} ${m(+v.water_temperature)} N`;
}

// --- fields and schemas --------------------------------------------------------------
interface F { name: string; label: string; type: string; uom?: string; kind: 'measured' | 'calculated'; inputs: string[]; on: boolean; essential?: boolean; extra?: boolean; tokens?: string[] }
const MEASURED: F[] = [
  { name: 'air_temperature', label: 'Air temperature', type: 'Quantity', uom: 'Cel', kind: 'measured', inputs: [], on: true, essential: true },
  { name: 'apparent_wind_speed', label: 'Apparent wind speed', type: 'Quantity', uom: 'm/s', kind: 'measured', inputs: [], on: true, essential: true },
  { name: 'relative_humidity', label: 'Relative humidity', type: 'Quantity', uom: '%', kind: 'measured', inputs: [], on: true },
  { name: 'pressure', label: 'Barometric pressure (station)', type: 'Quantity', uom: 'hPa', kind: 'measured', inputs: [], on: true },
  { name: 'apparent_wind_direction', label: 'Apparent wind direction, relative to the bow', type: 'Quantity', uom: 'deg', kind: 'measured', inputs: [], on: true },
  { name: 'solar_irradiance', label: 'Solar irradiance', type: 'Quantity', uom: 'W/m2', kind: 'measured', inputs: [], on: true },
  { name: 'water_temperature', label: 'Water temperature', type: 'Quantity', uom: 'Cel', kind: 'measured', inputs: [], on: true },
  { name: 'precipitation_type', label: 'Precipitation type', type: 'Category', kind: 'measured', inputs: [], on: false, extra: true, tokens: ['none', 'drizzle', 'rain', 'showers'] },
];
const CALCULATED: F[] = [
  { name: 'dew_point', label: 'Dew point (bow)', type: 'Quantity', uom: 'Cel', kind: 'calculated', inputs: ['air_temperature', 'relative_humidity'], on: true, essential: true },
  { name: 'air_minus_water', label: 'Air minus water temperature (bow)', type: 'Quantity', uom: 'Cel', kind: 'calculated', inputs: ['air_temperature', 'water_temperature'], on: true },
  ...MEASURED.filter((m) => m.type === 'Quantity').map((m): F => ({ name: `bow_minus_stern_${m.name}`, label: `Bow minus stern: ${m.label.toLowerCase()}`, type: 'Quantity', uom: m.uom, kind: 'calculated', inputs: [m.name], on: true })),
  { name: 'pressure_tendency_3h', label: 'Pressure tendency over three hours (bow)', type: 'Quantity', uom: 'hPa', kind: 'calculated', inputs: ['pressure'], on: false, extra: true },
  { name: 'spikes_last_hour', label: 'Readings flagged as spikes in the last hour (both sensors)', type: 'Count', kind: 'calculated', inputs: ['air_temperature'], on: false, extra: true },
];
const ALL = [...MEASURED, ...CALCULATED];

const timeField = (name = 'time', label = 'Sampling time') => ({ type: 'Time', name, label, definition: 'http://www.opengis.net/def/property/OGC/0/SamplingTime', uom: { href: 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian' } });
function component(f: F, quality = false): any {
  const c: any = { type: f.type, name: f.name, label: f.label, definition: DEF + f.name };
  if (f.type === 'Quantity') { c.uom = { code: f.uom }; if (quality) c.quality = [{ href: `#${f.name}_qc` }]; }
  if (f.type === 'Category') { c.codeSpace = DEF + f.name; c.constraint = { type: 'AllowedTokens', values: f.tokens }; }
  return c;
}
const qc = (f: F) => ({ type: 'Category', name: `${f.name}_qc`, label: `QC flag: ${f.label}`, definition: QARTOD + 'flag', codeSpace: QARTOD, constraint: { type: 'AllowedTokens', values: ['1', '2', '3', '4', '9'] } });
const simple = (type: string, name: string, label: string, uom?: string, extra: any = {}) => ({ type, name, label, definition: DEF + name, ...(uom ? { uom: { code: uom } } : {}), ...extra });
function shortHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).slice(0, 6).padStart(6, '0');
}

// --- one server instance -----------------------------------------------------------------
class Server {
  ready = false;
  readyAt: number;
  ds: Record<string, any> = {};
  csId: string;
  control: any;
  run: any = null;
  commands: Record<string, any> = {};
  pub: Set<string>;
  constructor(public instance: string, on: Record<string, boolean>, public lie: boolean, realNow: number) {
    this.readyAt = realNow + 2500; // a short, illustrative waiting mode
    const meas = MEASURED.filter((f) => on[f.name]);
    const pubMeas = new Set(meas.map((f) => f.name));
    const calc = CALCULATED.filter((f) => on[f.name] && f.inputs.every((i) => pubMeas.has(i)));
    this.pub = new Set([...pubMeas, ...calc.map((f) => f.name)]);
    const sensorFields: any[] = [timeField()];
    meas.forEach((f) => { sensorFields.push(component(f, f.type === 'Quantity')); if (f.type === 'Quantity') sensorFields.push(qc(f)); });
    const add = (base: string, system: string, output: string, name: string, fields: any[]) => {
      const id = `${base}-${shortHash(fields.map((f) => f.name).join(','))}`;
      this.ds[id] = { id, name, outputName: output, system, schema: { type: 'DataRecord', label: name, fields } };
    };
    for (const s of ['bow', 'stern']) add(`${s}-weather`, s, 'weather', `${s === 'bow' ? 'Bow' : 'Stern'} sensor weather record`, sensorFields);
    add('analysis-derived', 'analysis', 'derived', 'Derived values', [timeField(), ...calc.map((f) => component(f))]);
    add('analysis-changes', 'analysis', 'changes', 'Detected changes', [timeField(), simple('Text', 'run_id', 'Analysis run'),
      simple('Category', 'scale', 'Scale of the change', undefined, { constraint: { type: 'AllowedTokens', values: ['minutes', 'hours'] } }), simple('Quantity', 'strength', 'Strength of the change', '1')]);
    add('analysis-correlation', 'analysis', 'correlation', 'Correlation matrix', [timeField(), simple('Text', 'run_id', 'Analysis run'), simple('Text', 'parameters', 'Parameters, in matrix order'),
      { type: 'Matrix', name: 'matrix', label: 'Pearson correlation matrix', definition: DEF + 'matrix', elementCount: { type: 'Count' }, elementType: { type: 'DataArray', name: 'row', elementType: { type: 'Quantity', name: 'r', uom: { code: '1' } } } }]);
    add('analysis-clusters', 'analysis', 'clusters', 'Clustering into regimes', [timeField(), simple('Text', 'run_id', 'Analysis run'),
      simple('Category', 'regime', 'Regime', undefined, { constraint: { type: 'AllowedTokens', values: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] } })]);
    add('analysis-runs', 'analysis', 'runs', 'Analysis runs: settings and data range (illustrative: not scored)', [timeField('time', 'Time the run completed'), simple('Text', 'run_id', 'Analysis run'),
      timeField('window_start', 'Data range: start'), timeField('window_end', 'Data range: end'), simple('Count', 'records', 'Records used'),
      simple('Quantity', 'window_hours', 'Window', 'h'), simple('Count', 'clusters', 'Clusters'), simple('Quantity', 'sensitivity', 'Detector sensitivity', '1'), simple('Text', 'parameters', 'Parameters')]);
    const params = meas.filter((f) => f.type === 'Quantity').map((f) => f.name);
    this.control = { type: 'DataRecord', label: 'Analysis settings', fields: [
      simple('Quantity', 'window_hours', 'Window, ending now', 'h', { constraint: { type: 'AllowedValues', intervals: [[0.25, 168]] } }),
      simple('Count', 'clusters', 'Number of clusters', undefined, { constraint: { type: 'AllowedValues', intervals: [[2, 8]] } }),
      simple('Quantity', 'sensitivity', 'Detector sensitivity', '1', { constraint: { type: 'AllowedValues', intervals: [[1, 10]] } }),
      ...params.map((p) => simple('Boolean', `include_${p}`, `Include ${p.replace(/_/g, ' ')}`)),
    ] };
    this.csId = `analysis-settings-${shortHash(this.control.fields.map((f: any) => f.name).join(','))}`;
  }
  satisfies() {
    return (profile.essentials as any[]).every((e) => {
      const d = Object.values(this.ds).find((x: any) => x.system === e.system.split(':').pop() && x.outputName === e.datastream);
      return d && d.schema.fields.some((f: any) => f.name === e.field);
    });
  }
}

// --- the backend ------------------------------------------------------------------------------
const iso = (t: number) => new Date(Math.round(SIM_EPOCH_UNIX + t) * 1000).toISOString().replace('.000Z', 'Z');
const parseIso = (s: string) => Date.parse(s.endsWith('Z') ? s : s + 'Z') / 1000 - SIM_EPOCH_UNIX;

export interface Reply { status: number; headers: [string, string][]; body: string }

export class SimBackend {
  clock = new Clock();
  tap = new Tap(() => this.clock.now());
  on: Record<string, boolean> = Object.fromEntries(ALL.map((f) => [f.name, f.on]));
  lie = false;
  starts = 0;
  server: Server | null = null;
  down = false;
  sampled = Math.floor(HISTORY_S);

  constructor(public seed: number) {
    this.tap.counts['sensors>logger:L'] = 2 * HISTORY_S; // the history the illustrative store stands for
    this.start();
  }

  start() {
    this.starts += 1;
    this.down = false;
    this.server = new Server(`${this.seed}-${this.starts}`, this.on, this.lie, performance.now());
  }

  tick() {
    const now = this.clock.now();
    while (this.clock.playing && this.sampled < Math.floor(now)) {
      const t = this.sampled++;
      this.tap.emit('clock', 'barge', 'I', `tick ${t}`, { t });
      this.tap.emit('barge', 'sensors', 'I', 'barge state for sampling', { t, note: 'illustrative' });
      this.tap.emit('world', 'sensors', 'I', 'conditions at bow and stern', { t });
      for (const s of ['bow', 'stern']) this.tap.emit('sensors', 'logger', 'L', `${s} record`, record(t, reading(s, t)));
    }
    const s = this.server;
    if (s && !s.ready && performance.now() >= s.readyAt) {
      s.ready = true;
      this.analyse({ window_hours: 12, clusters: 4, sensitivity: 5 }, '');
    }
  }

  control(action: string, arg: any) {
    if (action === 'play') { this.clock.now(); this.clock.playing = true; this.tap.emit('shell', 'clock', 'I', 'play'); }
    else if (action === 'pause') { this.clock.now(); this.clock.playing = false; this.tap.emit('shell', 'clock', 'I', 'pause'); }
    else if (action === 'rate') { this.clock.now(); this.clock.rate = Number(arg); }
    else if (action === 'restart-server' || action === 'up') { this.tap.emit('shell', 'server', 'I', action); this.start(); }
    else if (action === 'down') { this.tap.emit('shell', 'server', 'I', 'take server down'); this.down = true; this.server = null; }
    else if (action === 'field') { this.on[arg.name] = !!arg.on; this.tap.emit('shell', 'server', 'I', `field ${arg.name} (pending)`); }
    else if (action === 'profile-lie') this.lie = !!arg;
    return this.state();
  }

  state() {
    const s = this.server;
    const nextPub = new Set(MEASURED.filter((f) => this.on[f.name]).map((f) => f.name));
    CALCULATED.filter((f) => this.on[f.name] && f.inputs.every((i) => nextPub.has(i))).forEach((f) => nextPub.add(f.name));
    const fields = ALL.map((f) => ({ name: f.name, label: f.label, kind: f.kind, inputs: f.inputs, extra: !!f.extra, essential: !!f.essential, type: f.type,
      on_next_start: this.on[f.name], published_next_start: nextPub.has(f.name), published_now: !!s?.pub.has(f.name) }));
    return {
      server: this.down ? 'down' : s && s.ready ? 'running' : 'waiting', instance: s?.instance ?? null,
      progress: s ? { indexed: s.ready ? 2 * HISTORY_S : 0, stored: 2 * HISTORY_S } : null,
      fields, pending: fields.some((f) => f.published_now !== f.published_next_start) || (!!s && s.lie !== this.lie),
      lie_about_profile: this.lie, clock: this.clock.state(), store: { bytes: 0, files: 0, records: 0 }, capture_counts: this.tap.counts,
    };
  }

  // --- analysis: illustrative, not scored ---------------------------------------------------
  analyse(settings: any, commandId: string) {
    const now = Math.floor(this.clock.now());
    const t0 = Math.max(0, now - settings.window_hours * 3600);
    this.tap.emit('server', 'analysis', 'I', 'run with settings', settings);
    this.tap.emit('analysis', 'scilibs', 'I', 'illustrative arithmetic (JS)', {});
    const params = PARAMS.filter((p) => this.server!.pub.has(p) && (settings[`include_${p}`] ?? true)).slice(0, 6);
    const ts: number[] = [];
    for (let t = t0; t <= now; t += 60) ts.push(t);
    const rows = ts.map((t) => reading('bow', t));
    const col = (p: string) => rows.map((r) => +r[p]);
    const R = params.map((a) => params.map((b) => round(pearson(col(a), col(b)), 4)));
    const changes = ts.filter((t) => t % 720 < 60 && Math.floor(t / 720) % 2 === 0).map((t) => ({ t, scale: 'minutes', strength: round(20 + 10 * Math.abs(hash(t, 9, 9)), 2) }));
    const k = Math.round(settings.clusters);
    const temps = col('air_temperature');
    const lo = Math.min(...temps), hi = Math.max(...temps);
    const regimes = temps.map((x) => `r${Math.min(k - 1, Math.floor(((x - lo) / (hi - lo + 1e-9)) * k))}`);
    this.tap.emit('scilibs', 'analysis', 'I', 'results', { records: ts.length });
    const id = `run-${this.server!.instance}-${Object.keys(this.server!.commands).length + 1}`;
    this.server!.run = { id, commandId, time: now, t0, t1: now, settings, params, R, changes, ts, regimes, records: ts.length * 60 };
    this.tap.emit('analysis', 'server', 'I', `${id} complete`, { run_id: id });
  }

  // --- HTTP ----------------------------------------------------------------------------------
  handle(method: string, path: string, query: string, body: string | null, root: string, origin: string, chain: string | null): Reply | null {
    if (this.down) return null;
    this.tap.chain = { id: chain ?? `s${ids}`, hop: 1 };
    const letter = method === 'POST' && path.endsWith('/commands') ? 'K' : 'Q';
    this.tap.emit('relay', 'fastapi', letter, `${method} ${path}${query ? '?' + query : ''}`, body ?? `${method} ${path}`);
    const s = this.server!;
    let r: Reply;
    if (!s.ready) r = json(503, { code: 'ServiceUnavailable', description: 'waiting mode: rebuilding the index (illustrative)' }, [['retry-after', '2']]);
    else {
      this.tap.emit('fastapi', 'server', 'I', `route ${method} ${path}`, { path });
      try {
        r = this.route(method, path, new URLSearchParams(query), body, origin + root);
      } catch (e: any) {
        r = json(e.status ?? 500, { code: e.code ?? 'InternalError', description: String(e.message ?? e), refused: e.refused });
      }
      this.tap.emit('server', 'fastapi', 'I', `result ${r.status}`, { status: r.status });
    }
    r.headers.push(['x-server-instance', s.instance], ['x-tap-hops', String(this.tap.chain.hop + 1)]);
    if (path === '/' || path === '') r.headers.push(['etag', `"${s.instance}"`]);
    const respLetter = r.status >= 400 ? 'H' : path.endsWith('/profile') ? 'P' : path.endsWith('/observations') ? 'O' : path.includes('/commands') ? 'K' : 'D';
    this.tap.emit('fastapi', 'relay', respLetter, `${r.status} ${path}`, r.body);
    this.tap.chain = null;
    return r;
  }

  private route(method: string, path: string, q: URLSearchParams, body: string | null, base: string): Reply {
    const s = this.server!;
    const parts = path.split('/').filter(Boolean);
    const link = (href: string, rel: string) => ({ href: base + href, rel, type: 'application/json' });
    const sys = (id: string, type: string, label: string, parent?: string) => ({
      type: type === 'Platform' || type === 'Sensor' ? 'PhysicalSystem' : 'SimpleProcess', id,
      uniqueId: `urn:x-barge:${type === 'System' ? 'process' : type.toLowerCase()}:${id}`, label,
      definition: SOSA + type, systemType: SOSA + type, ...(type === 'System' ? { assetType: 'Process' } : {}),
      links: [link(`/systems/${id}`, 'self'), link(`/systems/${id}/datastreams`, 'datastreams')], ...(parent ? { parent } : {}),
    });
    const systems = [sys('barge', 'Platform', 'Cargo barge'), sys('bow', 'Sensor', 'Bow weather sensor', 'barge'), sys('stern', 'Sensor', 'Stern weather sensor', 'barge'), sys('analysis', 'System', 'Analysis service')];
    const dsJson = (d: any) => ({ id: d.id, name: d.name, outputName: d.outputName, 'system@id': d.system, resultType: 'record', live: true,
      formats: ['application/swe+json', 'application/json'], phenomenonTime: [iso(0), iso(this.clock.now())], links: [link(`/datastreams/${d.id}`, 'self')] });
    const page = (items: any[]) => ({ items, links: [link(path, 'self')] });
    const getDs = (id: string) => { const d = s.ds[id]; if (!d) throw refusal(404, 'NotFound', `datastream ${id} does not exist`, `datastream:${id}`); return d; };
    if (method === 'GET') {
      if (!parts.length) return json(200, { title: 'Canal barge weather demonstrator (illustrative JS simulation)', description: 'WebAssembly is blocked in this browser, so an illustrative JS simulation answers in place of the Python server.',
        links: [link('/', 'self'), link('/conformance', 'conformance'), link('/systems', 'systems'), link('/datastreams', 'datastreams'), link('/profile', 'profile')] });
      if (path === '/conformance') return json(200, { conformsTo: (s.lie || s.satisfies()) ? [profile.id] : [] });
      if (path === '/profile') return json(200, profile);
      if (path === '/systems') return json(200, page(systems.filter((x) => !x.parent)));
      if (parts[0] === 'systems' && parts[2] === 'subsystems') return json(200, page(systems.filter((x) => x.parent === parts[1])));
      if (parts[0] === 'systems' && parts[2] === 'datastreams') return json(200, page(Object.values(s.ds).filter((d: any) => d.system === parts[1]).map(dsJson)));
      if (parts[0] === 'systems' && parts.length === 2) return json(200, systems.find((x) => x.id === parts[1]) ?? (() => { throw refusal(404, 'NotFound', 'no such system', `system:${parts[1]}`); })());
      if (path === '/datastreams') return json(200, page(Object.values(s.ds).map(dsJson)));
      if (path === '/controlstreams') return json(200, page([{ id: s.csId, name: 'Analysis settings', 'system@id': 'analysis' }]));
      if (parts[0] === 'controlstreams' && parts[2] === 'schema') return json(200, { commandFormat: 'application/json', parametersSchema: s.control });
      if (parts[0] === 'datastreams' && parts[2] === 'schema') {
        const d = getDs(parts[1]);
        if (!q.get('obsFormat')) throw refusal(400, 'MissingParameterValue', 'obsFormat is required', 'obsFormat');
        return json(200, { obsFormat: 'application/swe+json', recordSchema: d.schema, encoding: { type: 'JSONEncoding' } });
      }
      if (parts[0] === 'datastreams' && parts[2] === 'observations') return this.observations(getDs(parts[1]), q, path, base);
      if (parts[0] === 'datastreams' && parts.length === 2) return json(200, dsJson(getDs(parts[1])));
    }
    if (method === 'POST' && parts[0] === 'controlstreams' && parts[2] === 'commands') {
      const params = JSON.parse(body || '{}').parameters ?? {};
      const fields = Object.fromEntries(s.control.fields.map((f: any) => [f.name, f]));
      const settings: any = { window_hours: 12, clusters: 4, sensitivity: 5 };
      for (const [k, v] of Object.entries(params)) {
        const f = fields[k];
        if (!f) throw refusal(400, 'InvalidParameterValue', `unknown parameter ${k}`, k);
        if (f.constraint) {
          const [lo, hi] = f.constraint.intervals[0];
          if (typeof v !== 'number' || v < lo || v > hi) throw refusal(400, 'InvalidParameterValue', `${k}=${v} is outside the schema's AllowedValues interval [${lo}, ${hi}]`, k);
        }
        settings[k] = v;
      }
      const id = `cmd-${s.instance}-${Object.keys(s.commands).length + 1}`;
      s.commands[id] = { id, parameters: params };
      this.analyse(settings, id);
      return json(201, { id, 'controlstream@id': s.csId, issueTime: iso(this.clock.now()), parameters: params, currentStatus: 'COMPLETED' });
    }
    if (method === 'POST' && parts[0] === 'systems') throw refusal(405, 'OperationNotSupported', 'promotion needs the Python workspace, which cannot run without WebAssembly', 'POST');
    throw refusal(404, 'NotFound', `no resource at ${path} in the illustrative simulation`, `path:${path}`);
  }

  private observations(d: any, q: URLSearchParams, path: string, base: string): Reply {
    const now = Math.floor(this.clock.now());
    const limit = Number(q.get('limit') ?? 1000);
    if (limit > MAX_LIMIT) throw refusal(400, 'InvalidParameterValue', `limit ${limit} is over the maximum of ${MAX_LIMIT}`, 'limit');
    const offset = Number(q.get('offset') ?? 0);
    const names = d.schema.fields.filter((f: any) => f.name !== 'time').map((f: any) => f.name);
    let rows: any[] = [];
    let total = 0;
    const run = this.server!.run;
    if (d.outputName === 'weather' || d.outputName === 'derived') {
      let t0 = 0, t1 = now;
      const pt = q.get('phenomenonTime');
      if (q.get('resultTime') === 'latest') t0 = t1 = now;
      else if (pt) {
        const [a, b] = pt.split('/');
        t0 = a && a !== '..' ? Math.ceil(parseIso(a)) : 0;
        t1 = b && b !== '..' ? Math.floor(parseIso(b)) : now;
      }
      t1 = Math.min(t1, now);
      total = Math.max(0, t1 - t0 + 1);
      const from = t0 + offset;
      const to = Math.min(t1, from + limit - 1);
      for (let t = from; t <= to; t++) {
        const pick = (v: Record<string, any>) => Object.fromEntries([['time', iso(t)], ...names.map((n: string) => [n, v[n] ?? null])]);
        if (d.outputName === 'weather') rows.push(pick(reading(d.system, t)));
        else {
          const b = reading('bow', t), st = reading('stern', t);
          const v: Record<string, any> = { dew_point: round(+b.air_temperature - (100 - +b.relative_humidity) / 5, 2), air_minus_water: round(+b.air_temperature - +b.water_temperature, 2),
            pressure_tendency_3h: round(+b.pressure - +reading('bow', t - 10800).pressure, 2), spikes_last_hour: 0 };
          for (const p of PARAMS) v[`bow_minus_stern_${p}`] = round(+b[p] - +st[p], 2);
          rows.push(pick(v));
        }
      }
    } else if (run) {
      if (d.outputName === 'runs') rows = [{ time: iso(run.time), run_id: run.id, window_start: iso(run.t0), window_end: iso(run.t1), records: run.records,
        window_hours: run.settings.window_hours, clusters: run.settings.clusters, sensitivity: run.settings.sensitivity, parameters: run.params.join(',') }];
      if (d.outputName === 'correlation') rows = [{ time: iso(run.time), run_id: run.id, parameters: run.params.join(','), matrix: run.R }];
      if (d.outputName === 'changes') rows = run.changes.map((c: any) => ({ time: iso(c.t), run_id: run.id, scale: c.scale, strength: c.strength }));
      if (d.outputName === 'clusters') rows = run.ts.map((t: number, i: number) => ({ time: iso(t), run_id: run.id, regime: run.regimes[i] }));
      total = rows.length;
      rows = rows.slice(offset, offset + limit);
    }
    const headers: [string, string][] = [['content-type', 'application/swe+json']];
    if (offset + limit < total) headers.push(['link', `<${base}${path}?limit=${limit}&offset=${offset + limit}>; rel="next"`]);
    return { status: 200, headers, body: JSON.stringify(rows) };
  }
}

function pearson(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
function json(status: number, body: unknown, extra: [string, string][] = []): Reply {
  return { status, headers: [['content-type', 'application/json'], ...extra], body: JSON.stringify(body) };
}
function refusal(status: number, code: string, description: string, refused: string) {
  return Object.assign(new Error(description), { status, code, refused });
}
