// The data server (C-04; server.py): one start of the stand-in for OpenSensorHub. An
// instance is created at each server start: it freezes the field offering (FR-51) and
// drops the store adapter's index so the adapter rebuilds it; then its modules start (the
// CSV importer registers, lists the folder and, at the first start of a page load, imports
// Mission A silently, FR-15). Until then the server answers nothing (4.7, §9.1: no 503 and
// no instance identifier). The store of created
// resources (resources.ts) outlives it, as OpenSensorHub's database does.
//
// The profile served is the one the 4.1 display client is built against; the 4.7
// template (contracts/profile.json) is served from plan Phase 7 (D-252).
import profileJson from '../../../contracts/interim/profile-v4.1.json';
import { USERS } from './accounts';
import { StoreAdapter } from './adapter';
import { SENSORS, SOSA, URN } from './constants';
import { Offering, RAW } from './fields';
import { pySlice } from './py';
import { Cols, DatastreamRec, Store } from './resources';
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
  essentials: { id: string; system: string; datastream: string; field: string; type: string; uom?: string | null }[];
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

export interface ServerHost {
  seed: number;
  logger: LoggerStore;
  store: Store;
  lieAboutProfile: boolean;
  now(): number;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class Server {
  readonly offering: Offering;
  readonly adapter: StoreAdapter;
  /** The adapter's index is rebuilt. */
  indexed = false;
  /** Its modules (the CSV importer) are starting. */
  starting = false;
  /** Answering requests: once indexed and its modules have started. */
  ready = false;
  readonly store: Store;
  readonly lieAboutProfile: boolean;
  readonly profile = PROFILE;
  readonly sensorSchema: Record<string, DataRecord> = {};

  /** `number` counts server starts, for the shell only: the server serves no instance identifier (§9.1). */
  constructor(readonly rt: ServerHost, readonly number: number, offering: Offering, readonly tap: Tap) {
    this.offering = offering.copy();
    this.adapter = new StoreAdapter(rt.logger, tap);
    this.store = rt.store;
    this.lieAboutProfile = rt.lieAboutProfile;
    const fields = [timeField()];
    for (const f of this.offering.raw()) {
      fields.push(component(f, f.swe_type === 'Quantity'));
      if (f.swe_type === 'Quantity') fields.push(qcField(f));
    }
    for (const s of SENSORS) this.sensorSchema[s] = record(fields, `${capitalize(s)} sensor record`);
    this.configure();
  }

  /**
   * What OpenSensorHub's configuration creates at start (server._configure; interfaces §6): the platform,
   * its sensors and their CO₂ analysers (restricted), Models, and a workspace per user. Each sensor's
   * `weather` datastream is read from the 4.1 logger store, for the 4.1 display client and models (D-271); its schema
   * is this start's offering, so a new offering is a new datastream (FR-51).
   */
  private configure(): void {
    const st = this.store;
    const [barge] = st.addSystem(URN + 'platform:barge', 'Collection platform', 'The uncrewed electric cargo barge. It records no position.',
      SOSA + 'Platform', 'Platform');
    for (const s of SENSORS) {
      const [sensor] = st.addSystem(`${URN}sensor:${s}`, `${capitalize(s)} sensor`, 'Seven parameters at 1 Hz.', SOSA + 'Sensor', 'Equipment', barge.id);
      st.addSystem(`${URN}sensor:${s}:co2`, `${capitalize(s)} CO₂ analyser`, 'Carbon dioxide at the sensor, in parts per million. Restricted (FR-93).',
        SOSA + 'Sensor', 'Equipment', sensor.id);
      st.addDatastream(sensor.id, 'weather', `${capitalize(s)} sensor record`, this.sensorSchema[s], null, 'sensor', s);
    }
    st.addSystem(URN + 'process:models', 'Models',
      'A home for models that turn sensor data into insight. Each model is a process system of its own, created by the model itself.',
      SOSA + 'System', 'Process');
    for (const u of USERS) {
      st.addSystem(`${URN}workspace:${u}`, `Workspace of ${u}`, 'Data of interest saved by this user (FR-94).', SOSA + 'System', 'Other', null, u);
    }
  }

  // --- start-up: the index is rebuilt; meanwhile the server answers nothing (§9.1) -----------------------
  /** One step of rebuilding the index; true once it is rebuilt. The runtime then starts the modules. */
  indexStep(): boolean {
    if (!this.indexed) this.indexed = this.adapter.indexStep();
    return this.indexed;
  }

  phase(): 'index' | 'import' | 'ready' {
    return this.ready ? 'ready' : this.indexed ? 'import' : 'index';
  }

  progress(): { indexed: number; stored: number } {
    return { indexed: this.adapter.indexedRecords(), stored: this.adapter.storeRecords() };
  }

  // --- datastreams: the offering applied to every schema (FR-50..52) ---------------------
  visible(rec: DataRecord): DataRecord {
    return { ...rec, fields: rec.fields.filter((f) => f.name === 'time' || this.offering.keep(f.name)) };
  }

  /** Listed and served: not replaced, and with at least one output published (FR-52). */
  served(d: DatastreamRec): boolean {
    return !d.replaced && this.visible(d.schema).fields.length > 1;
  }

  timeRange(d: DatastreamRec): [number, number] | null {
    if (d.kind === 'sensor') return this.adapter.timeRange(d.sensor!);
    return d.series!.span();
  }

  // --- profile (FR-40, FR-41) ----------------------------------------------------------------
  satisfiesProfile(): { id: string; reason: string }[] {
    const problems: { id: string; reason: string }[] = [];
    for (const e of this.profile.essentials) {
      const ds = this.store.datastream(e.system, e.datastream) ?? this.perDataset(e.system, e.datastream);
      const rec = ds && this.served(ds) ? this.visible(ds.schema) : null;
      const fld = rec?.fields.find((f) => f.name === e.field);
      if (!fld) problems.push({ id: e.id, reason: 'missing' });
      else if (fld.type !== e.type) problems.push({ id: e.id, reason: 'wrong type' });
      else if ((fld.uom?.code ?? null) !== (e.uom ?? null)) problems.push({ id: e.id, reason: 'wrong unit' });
    }
    return problems;
  }

  /**
   * The 4.1 profile names outputs without a dataset; 4.7 outputs are per dataset (§6). Until the profile switches with
   * the display client (Phase 7, D-252), an essential is met by the newest dataset's output that carries it (D-285).
   */
  private perDataset(systemUid: string, output: string): DatastreamRec | null {
    const s = this.store.systemByUid(systemUid);
    if (!s) return null;
    const found = [...this.store.datastreams.values()].filter((d) => d.system === s.id && d.outputName.startsWith(output + '__') && this.served(d));
    return found.length ? found[found.length - 1] : null;
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
}
