// The data server (C-04; server.py): one running instance of the Connected
// Systems server. An instance is created at each server start: it freezes the
// field offering (FR-51), drops the store adapter's index so the adapter
// rebuilds it while the server waits (FR-47), and carries a fresh instance
// identifier. The store and the registry outlive it. It holds no client
// sessions (FR-06).
import profileJson from '../../../contracts/profile.json';
import { StoreAdapter } from './adapter';
import { SENSORS, SOSA, URN } from './constants';
import { Offering, RAW, schemaId } from './fields';
import { pyRepr, pySlice } from './py';
import { Cols, ControlstreamRec, Registry, Series, SystemRec } from './registry';
import { LoggerStore } from './store';
import { component, DataRecord, qcField, record, timeField } from './swe';
import type { Tap } from './tap';
import { iso } from './time';

export const QC_RANGE: Record<string, [number, number]> = {
  air_temperature: [-30, 50], relative_humidity: [0, 100], pressure: [900, 1100], apparent_wind_speed: [0, 60],
  apparent_wind_direction: [0, 360], solar_irradiance: [0, 1500], water_temperature: [-2, 35],
};
/** A reading further than this from the mean of its two neighbours is suspect (QARTOD spike test). */
export const QC_SPIKE: Record<string, number> = {
  air_temperature: 0.8, relative_humidity: 6.0, pressure: 0.5, apparent_wind_speed: 3.5, solar_irradiance: 150.0,
  water_temperature: 0.4,
};

export interface Profile {
  id: string;
  essentials: { id: string; system: string; datastream: string; field: string; type: string; uom?: string }[];
  [k: string]: unknown;
}
export const PROFILE = profileJson as unknown as Profile;

/** QARTOD flags, computed on the way out; stored records are never altered (FR-32). */
export function qcFlags(name: string, v: Float64Array, wdVariable: Float64Array | null = null): Float64Array {
  const n = v.length;
  const flag = new Float64Array(n).fill(1);
  const [lo, hi] = QC_RANGE[name];
  for (let i = 0; i < n; i++) if (v[i] < lo || v[i] > hi) flag[i] = 4;
  const sp = QC_SPIKE[name];
  if (sp !== undefined && n >= 3) {
    for (let i = 1; i < n - 1; i++) {
      if (Math.abs(v[i] - 0.5 * (v[i - 1] + v[i + 1])) > sp && flag[i] === 1) flag[i] = 3;
    }
  }
  if (wdVariable) for (let i = 0; i < n; i++) if (wdVariable[i] === 1) flag[i] = 2;
  for (let i = 0; i < n; i++) if (Number.isNaN(v[i]) && flag[i] !== 2) flag[i] = 9;
  return flag;
}

export interface DsView {
  id: string;
  key: string;
  name: string;
  outputName: string;
  system: string;
  kind: 'sensor' | 'model';
  sensor?: string;
  schema: DataRecord;
  series?: Series;
}

export interface ServerHost {
  seed: number;
  logger: LoggerStore;
  registry: Registry;
  lieAboutProfile: boolean;
  now(): number;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class Server {
  readonly offering: Offering;
  readonly instance: string;
  readonly adapter: StoreAdapter;
  ready = false;
  readonly registry: Registry;
  readonly lieAboutProfile: boolean;
  readonly profile = PROFILE;
  readonly sensorSchema: Record<string, DataRecord> = {};
  readonly systems: Record<string, SystemRec>;

  constructor(readonly rt: ServerHost, number: number, offering: Offering, readonly tap: Tap) {
    this.offering = offering.copy();
    this.instance = `${rt.seed}-${number}`;
    this.adapter = new StoreAdapter(rt.logger, tap);
    this.registry = rt.registry;
    this.lieAboutProfile = rt.lieAboutProfile;
    const fields = [timeField()];
    for (const f of this.offering.raw()) {
      fields.push(component(f, f.swe_type === 'Quantity'));
      if (f.swe_type === 'Quantity') fields.push(qcField(f));
    }
    for (const s of SENSORS) this.sensorSchema[s] = record(fields, `${capitalize(s)} sensor record`);
    this.systems = {
      barge: sys('barge', 'Platform', 'Collection platform', 'PhysicalSystem', 'The uncrewed electric cargo barge. It records no position.'),
      bow: sys('bow', 'Sensor', 'Bow sensor', 'PhysicalSystem', 'Seven parameters at 1 Hz.', 'barge'),
      stern: sys('stern', 'Sensor', 'Stern sensor', 'PhysicalSystem', 'Seven parameters at 1 Hz.', 'barge'),
      models: sys('models', 'System', 'Models', 'AggregateProcess',
        'A home for models that turn sensor data into insight. Each model is a process system of its own, created by the model itself.',
        undefined, 'Process'),
    };
  }

  // --- start-up: waiting mode while the index is rebuilt (FR-47) -----------------------
  indexStep(): boolean {
    const done = this.adapter.indexStep();
    if (done) this.ready = true;
    return done;
  }

  progress(): { indexed: number; stored: number } {
    return { indexed: this.adapter.indexedRecords(), stored: this.adapter.storeRecords() };
  }

  allSystems(): Map<string, SystemRec> {
    return new Map([...Object.entries(this.systems), ...this.registry.systems]);
  }

  // --- datastreams: the offering applied to every schema (FR-50..52) ---------------------
  private visible(rec: DataRecord): DataRecord {
    return { ...rec, fields: rec.fields.filter((f) => f.name === 'time' || this.offering.keep(f.name)) };
  }

  /** Public id -> datastream, for this instance's offering. */
  datastreams(hidden = false): Map<string, DsView> {
    const out = new Map<string, DsView>();
    for (const s of SENSORS) {
      const rec = this.visible(this.sensorSchema[s]);
      const id = schemaId(`${s}-weather`, rec.fields.map((f) => f.name));
      out.set(id, { id, key: `${s}:weather`, name: `${capitalize(s)} sensor record`, outputName: 'weather', system: s, kind: 'sensor', sensor: s, schema: rec });
    }
    for (const [key, d] of this.registry.datastreams) {
      if (!this.registry.systems.has(d.system)) continue;
      const rec = this.visible(d.schema);
      if (rec.fields.length < 2 && !hidden) continue; // every output switched off: nothing to publish (FR-52)
      const id = schemaId(`${d.system}-${d.outputName}`, rec.fields.map((f) => f.name));
      out.set(id, { id, key, name: d.name, outputName: d.outputName, system: d.system, kind: 'model', schema: rec, series: d.series });
    }
    return out;
  }

  controlstreams(): Map<string, ControlstreamRec & { id: string }> {
    const out = new Map<string, ControlstreamRec & { id: string }>();
    for (const c of this.registry.controlstreams.values()) {
      if (!this.registry.systems.has(c.system)) continue;
      const id = schemaId(`${c.system}-${c.inputName}`, c.schema.fields.map((f) => f.name));
      out.set(id, { ...c, id });
    }
    return out;
  }

  timeRange(d: DsView): [number, number] | null {
    if (d.kind === 'sensor') return this.adapter.timeRange(d.sensor!);
    const s = d.series!;
    return s.length ? [s.tAt(0), s.tAt(s.length - 1)] : null;
  }

  // --- profile (FR-40, FR-41) ----------------------------------------------------------------
  satisfiesProfile(): { id: string; reason: string }[] {
    const problems: { id: string; reason: string }[] = [];
    const systems = [...this.allSystems().values()];
    const dss = [...this.datastreams().values()];
    for (const e of this.profile.essentials) {
      const sysm = systems.find((s) => s.uniqueId === e.system);
      const ds = sysm && dss.find((d) => d.system === sysm.id && d.outputName === e.datastream);
      const fld = ds && ds.schema.fields.find((f) => f.name === e.field);
      if (!fld) problems.push({ id: e.id, reason: 'missing' });
      else if (fld.type !== e.type) problems.push({ id: e.id, reason: 'wrong type' });
      else if ((fld.uom?.code ?? null) !== (e.uom ?? null)) problems.push({ id: e.id, reason: 'wrong unit' });
    }
    return problems;
  }

  claimsProfile(): boolean {
    return this.lieAboutProfile || !this.satisfiesProfile().length;
  }

  // --- reading the store through the adapter (FR-21) -------------------------------------
  /** Records from the store, with QARTOD flags computed on the way out (FR-32). */
  sensorRecords(sensor: string, t0: number, t1: number, limit: number | null = null, offset = 0, fields: string[] | null = null,
    why = 'observation request', quiet = false): Cols {
    const rawNames = RAW.map((f) => f.name);
    const names = fields === null ? rawNames : fields.filter((n) => rawNames.includes(n));
    this.tap.emit('server', 'adapter', 'S', `store query: ${sensor}, ${names.length} fields`, {
      op: 'read', sensors: [sensor], fields: names,
      period: [Number.isFinite(t0) ? iso(Math.max(t0, 0)) : '..', Number.isFinite(t1) ? iso(t1) : '..'],
      limit, offset, source: 'raw records', for: why,
    }, { quiet });
    const pad = 1;
    const loOff = Math.max(0, offset - pad);
    const lead = offset - loOff;
    const r = this.adapter.read(sensor, t0, t1, limit === null ? null : limit + lead + pad, loOff, quiet);
    const len = r.t.length;
    const n = Math.max(0, Math.min(len - lead, limit !== null ? limit : len));
    const [a, b] = pySlice(len, lead, lead + n);
    const out: Cols = { t: r.t.slice(a, b) };
    for (const name of names) {
      const v = (r as unknown as Record<string, Float64Array>)[name];
      out[name] = v.slice(a, b);
      if (name === 'precipitation_type') continue;
      const flags = qcFlags(name, v, name === 'apparent_wind_direction' ? r.wd_variable : null);
      out[`${name}_qc`] = flags.slice(a, b);
    }
    const rows = b - a;
    this.tap.emit('adapter', 'server', 'I', `${rows} ${sensor} records as columns`, { columns: Object.keys(out), records: rows }, { quiet });
    return out;
  }

  // --- commands (FR-27) ---------------------------------------------------------------------
  /** Check a command against its control stream's schema; throws [name, message]. */
  validateCommand(cs: ControlstreamRec, params: Record<string, unknown>): void {
    const fields = new Map(cs.schema.fields.map((f) => [f.name, f]));
    for (const [k, v] of Object.entries(params)) {
      const f = fields.get(k);
      if (!f) throw new CommandError(k, `unknown parameter ${k}; the control stream's schema accepts ${[...fields.keys()].join(', ')}`);
      const con = f.constraint ?? {};
      const t = f.type;
      if (t === 'Boolean') {
        if (typeof v !== 'boolean') throw new CommandError(k, `${k} must be true or false`);
      } else if (t === 'Quantity' || t === 'Count') {
        if (typeof v !== 'number') throw new CommandError(k, `${k} must be a number`);
        if (t === 'Count' && !Number.isInteger(v)) throw new CommandError(k, `${k} must be a whole number`);
        if (con.intervals?.length) {
          const [lo, hi] = con.intervals[0];
          if (!(lo <= v && v <= hi)) throw new CommandError(k, `${k}=${v} is outside the schema's AllowedValues interval [${lo}, ${hi}]`);
        }
      } else if (t === 'Category' || t === 'Text') {
        if (typeof v !== 'string') throw new CommandError(k, `${k} must be text`);
        const allowed: string[] | undefined = con.values;
        const items = t === 'Text' ? v.split(',').map((x) => x.trim()) : [v];
        if (allowed?.length) {
          const bad = items.filter((x) => !allowed.includes(x));
          if (bad.length || !items.length || (items.length === 1 && items[0] === '')) {
            throw new CommandError(k, `${k}=${pyRepr(v)}: ${bad.join(', ') || 'nothing'} not in the schema's AllowedTokens ${pyRepr(allowed)}`);
          }
        }
      }
    }
  }
}

export class CommandError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

function sys(sid: string, stype: string, label: string, smlType: string, desc: string, parent?: string, asset?: string): SystemRec {
  const s: SystemRec = {
    type: smlType, id: sid, uniqueId: `${URN}${asset ? 'process' : stype.toLowerCase()}:${sid}`, label, description: desc,
    definition: SOSA + stype, systemType: SOSA + stype, assetType: asset ?? 'Equipment',
  };
  if (parent) s.parent = parent;
  return s;
}
