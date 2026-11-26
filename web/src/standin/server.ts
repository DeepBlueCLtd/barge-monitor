// The data server (C-04; server.py): one start of the stand-in for OpenSensorHub. An
// instance is created at each server start: it freezes the field offering (FR-51); then its
// modules start (the CSV importer registers, lists the folder and, at the first start of a page
// load, imports Mission A silently, FR-15). Until then the server answers nothing (4.7, §9.1: no
// 503 and no instance identifier). The store of created resources (resources.ts) outlives it, as
// OpenSensorHub's database does. The 4.1 logger's `weather` datastreams and the store adapter are
// retired (plan Phase 8, D-320).
//
// The profile served is the 4.7 template (contracts/profile.json, FR-40a); the interim 4.1
// profile of D-252 is retired with the 4.1 display client (D-301).
import profileJson from '../../../contracts/profile.json';
import { USERS } from './accounts';
import { SENSORS, SOSA, URN } from './constants';
import { Offering } from './fields';
import { DatastreamRec, Store } from './resources';
import type { DataRecord } from './swe';
import type { Tap } from './tap';

export interface Profile {
  id: string;
  essentials: { id: string; system: string; datastream: string; field: string; type: string; uom?: string | null; kind?: string }[];
  [k: string]: unknown;
}
export const PROFILE = profileJson as unknown as Profile;

export interface ServerHost {
  store: Store;
  lieAboutProfile: boolean;
  now(): number;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class Server {
  readonly offering: Offering;
  /** Its modules (the CSV importer) are starting. */
  starting = false;
  /** Answering requests: once its modules have started. */
  ready = false;
  readonly store: Store;
  readonly lieAboutProfile: boolean;
  readonly profile = PROFILE;

  /** `number` counts server starts, for the shell only: the server serves no instance identifier (§9.1). */
  constructor(readonly rt: ServerHost, readonly number: number, offering: Offering, readonly tap: Tap) {
    this.offering = offering.copy();
    this.store = rt.store;
    this.lieAboutProfile = rt.lieAboutProfile;
    this.configure();
  }

  /**
   * What OpenSensorHub's configuration creates at start (server._configure; interfaces §6): the platform,
   * its sensors and their CO₂ analysers (restricted), Models, and a workspace per user. The CSV importer registers
   * itself at each start (importer.ts) and makes each dataset's datastreams.
   */
  private configure(): void {
    const st = this.store;
    const [barge] = st.addSystem(URN + 'platform:barge', 'Collection platform', 'The uncrewed electric cargo barge. It records no position.',
      SOSA + 'Platform', 'Platform');
    for (const s of SENSORS) {
      const [sensor] = st.addSystem(`${URN}sensor:${s}`, `${capitalize(s)} sensor`, 'Seven parameters at 1 Hz.', SOSA + 'Sensor', 'Equipment', barge.id);
      st.addSystem(`${URN}sensor:${s}:co2`, `${capitalize(s)} CO₂ analyser`, 'Carbon dioxide at the sensor, in parts per million. Restricted (FR-93).',
        SOSA + 'Sensor', 'Equipment', sensor.id);
    }
    st.addSystem(URN + 'process:models', 'Models',
      'A home for models that turn sensor data into insight. Each model is a process system of its own, created by the model itself.',
      SOSA + 'System', 'Process');
    for (const u of USERS) {
      st.addSystem(`${URN}workspace:${u}`, `Workspace of ${u}`, 'Data of interest saved by this user (FR-94).', SOSA + 'System', 'Other', null, u);
    }
  }

  phase(): 'import' | 'ready' {
    return this.ready ? 'ready' : 'import';
  }

  // --- datastreams: the offering applied to every schema (FR-50..52) ---------------------
  /**
   * A datastream's schema as this start serves it: fields switched off are left out. A misconfigured server
   * (FR-79a, D-210) serves the importer's catalogue without `status`, a fixed essential, while it still claims
   * the profile: the display client refuses it at the handshake.
   */
  visible(d: DatastreamRec): DataRecord {
    const rec = d.schema;
    const broken = this.lieAboutProfile && d.outputName === 'catalogue' ? 'status' : null;
    return { ...rec, fields: rec.fields.filter((f) => f.name === 'time' || (this.offering.keep(f.name) && f.name !== broken)) };
  }

  /** Listed and served: not replaced, and with at least one output published (FR-52). */
  served(d: DatastreamRec): boolean {
    return !d.replaced && this.visible(d).fields.length > 1;
  }

  timeRange(d: DatastreamRec): [number, number] | null {
    return d.series.span();
  }

  // --- profile (FR-40, FR-41) ----------------------------------------------------------------
  satisfiesProfile(): { id: string; reason: string }[] {
    const problems: { id: string; reason: string }[] = [];
    for (const e of this.profile.essentials) {
      if (e.kind === 'controlstream') {
        if (!this.store.controlstream(e.system, e.datastream)) problems.push({ id: e.id, reason: 'missing' });
        continue;
      }
      let found = this.perDataset(e.system, e.datastream);
      if (!found) {
        const ds = this.store.datastream(e.system, e.datastream);
        found = ds && this.served(ds) ? [ds] : [];
      }
      const reasons = found.map((ds) => {
        const fld = this.visible(ds).fields.find((f) => f.name === e.field);
        return !fld ? 'missing' : fld.type !== e.type ? 'wrong type' : (fld.uom?.code ?? null) !== (e.uom ?? null) ? 'wrong unit' : '';
      });
      if (!reasons.includes('')) problems.push({ id: e.id, reason: reasons[reasons.length - 1] ?? 'missing' });
    }
    return problems;
  }

  /**
   * A template essential (`weather__{dataset}`, FR-40a) is met for the claim when some dataset's datastream carries it
   * (D-301): the client checks each dataset when it opens it, and a dataset missing one is degraded (FR-45), not the server.
   */
  private perDataset(systemUid: string, template: string): DatastreamRec[] | null {
    if (!template.includes('{dataset}')) return null;
    const s = this.store.systemByUid(systemUid);
    if (!s) return null;
    const prefix = template.replace('{dataset}', '');
    return [...this.store.datastreams.values()].filter((d) => d.system === s.id && d.outputName.startsWith(prefix) && this.served(d));
  }

  claimsProfile(): boolean {
    return this.lieAboutProfile || !this.satisfiesProfile().length;
  }
}
