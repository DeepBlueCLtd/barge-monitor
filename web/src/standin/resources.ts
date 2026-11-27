// The data server's store of resources (backend/barge/store.py): systems, datastreams, control
// streams, commands and status reports. Like OpenSensorHub's database it outlives a server restart.
// Identifiers are opaque (four base-32 characters, like OpenSensorHub's `040g`): nobody may rely on
// them; clients find everything by uniqueId and outputName (docs/v4-interfaces.md §6, §9.1).
//
// Every datastream's observations are kept here. The CSV importer writes its datasets in bulk
// (`appendCols`, FR-20a). Each
// resource carries its `owner`, for the permission checks of §9.3, which are the server's own.
import type { PushStream } from './stream';
import type { Account } from './accounts';
import type { Component, DataRecord } from './swe';

export const NUMERIC = new Set(['Quantity', 'Count', 'Boolean']);
const B32 = '0123456789abcdefghijklmnopqrstuv';

export type Col = Float64Array | unknown[];
/** Columns of observations: `t` (simulated seconds) and one column per field. */
export type Cols = { t: Float64Array } & Record<string, Col>;

function b32(n: number): string {
  return [3, 2, 1, 0].map((i) => B32[(n >> (5 * i)) & 31]).join('');
}

/** Opaque, deterministic identifiers: a scrambled counter per kind (store.Ids). */
export class Ids {
  private n = new Map<string, number>();
  private static readonly OFFSET: Record<string, number> = { system: 4, datastream: 9001, controlstream: 17011, command: 23023, status: 29021 };

  next(kind: string): string {
    const k = (this.n.get(kind) ?? 0) + 1;
    this.n.set(kind, k);
    return b32((k * 7919 + (Ids.OFFSET[kind] ?? 0)) % 32 ** 4);
  }
}

/** Observations of one stored datastream, kept in phenomenon-time order (store.Series). */
export class Series {
  readonly types = new Map<string, string>();
  private t: number[] = [];
  private seq: number[] = [];
  private cols = new Map<string, unknown[]>();

  constructor(fields: Component[]) {
    for (const f of fields) if (f.name !== 'time') this.types.set(f.name, f.type);
    for (const n of this.types.keys()) this.cols.set(n, []);
  }

  get length(): number {
    return this.t.length;
  }

  appendRow(t: number, values: Record<string, unknown>, seq: number): void {
    let i = this.t.length;
    if (i && t < this.t[i - 1]) i = this.upper(t); // late: in its place, after its equals (stable)
    this.t.splice(i, 0, t);
    this.seq.splice(i, 0, seq);
    for (const [n, ty] of this.types) {
      const v = values[n];
      this.cols.get(n)!.splice(i, 0, NUMERIC.has(ty) || ty === 'Time' ? (v === undefined || v === null ? NaN : v) : v ?? null);
    }
  }

  /** Many observations at once, as columns, in time order after what is there: the importer's bulk write (FR-20a). */
  appendCols(t: ArrayLike<number>, cols: Record<string, ArrayLike<unknown>>, seq0: number): void {
    const n = t.length;
    if (!n) return;
    if (this.t.length && t[0] < this.t[this.t.length - 1]) { // not after what is there: row by row, in place
      for (let i = 0; i < n; i++) {
        const row: Record<string, unknown> = {};
        for (const k of this.types.keys()) row[k] = cols[k]?.[i];
        this.appendRow(t[i], row, seq0 + i);
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      this.t.push(t[i]);
      this.seq.push(seq0 + i);
    }
    for (const [name, ty] of this.types) {
      const out = this.cols.get(name)!;
      const v = cols[name];
      const numeric = NUMERIC.has(ty) || ty === 'Time';
      for (let i = 0; i < n; i++) out.push(v ? v[i] : numeric ? NaN : null);
    }
  }

  private upper(t: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private lower(t: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  range(t0: number, t1: number): [number, number] {
    return [this.lower(t0), this.upper(t1)];
  }

  latest(): number | null {
    if (!this.seq.length) return null;
    let best = 0;
    for (let i = 1; i < this.seq.length; i++) if (this.seq[i] > this.seq[best]) best = i;
    return best;
  }

  span(): [number, number] | null {
    return this.t.length ? [this.t[0], this.t[this.t.length - 1]] : null;
  }

  take(idx: number[], names: string[]): Cols {
    const out: Cols = { t: Float64Array.from(idx, (i) => this.t[i]) };
    for (const n of names) {
      const c = this.cols.get(n);
      if (!c) continue;
      const ty = this.types.get(n)!;
      out[n] = NUMERIC.has(ty) || ty === 'Time' ? Float64Array.from(idx, (i) => c[i] as number) : idx.map((i) => c[i]);
    }
    return out;
  }
}

export interface SystemRec {
  id: string;
  uid: string;
  label: string;
  description: string;
  feature: string;
  asset: string;
  parent: string | null;
  owner: string | null;
}

export interface DatastreamRec {
  id: string;
  system: string;
  outputName: string;
  name: string;
  schema: DataRecord;
  owner: string | null;
  series: Series;
  replaced: boolean;
}

export interface ControlstreamRec {
  id: string;
  system: string;
  inputName: string;
  name: string;
  schema: DataRecord;
  owner: string | null;
  replaced: boolean;
}

export interface StatusReport {
  id: string;
  'command@id': string;
  statusCode: string;
  reportTime: string;
  message?: string;
}

export interface CommandRec {
  id: string;
  'controlstream@id': string;
  issueTime: string;
  parameters: Record<string, unknown>;
  sender: string;
  status: StatusReport[];
}

const sameSchema = (a: DataRecord, b: DataRecord) =>
  a.fields.length === b.fields.length && a.fields.every((f, i) => f.name === b.fields[i].name && f.type === b.fields[i].type);

/** Created resources. Everything is kept across restarts. */
export class Store {
  /** Reset instance makes a new store that keeps counting identifiers, so that none is reused (FR-50a). */
  constructor(readonly ids: Ids = new Ids()) {}

  readonly systems = new Map<string, SystemRec>();
  readonly datastreams = new Map<string, DatastreamRec>();
  readonly controlstreams = new Map<string, ControlstreamRec>();
  readonly commands = new Map<string, CommandRec>();
  readonly statusReports = new Map<string, StatusReport[]>();
  private seq = 0;

  systemByUid(uid: string): SystemRec | null {
    for (const s of this.systems.values()) if (s.uid === uid) return s;
    return null;
  }

  /** The system with this uniqueId: [system, created]. Creating what exists is not an error (§9.1). */
  addSystem(uid: string, label: string, description = '', feature = 'http://www.w3.org/ns/sosa/System', asset = 'Equipment',
    parent: string | null = null, owner: string | null = null): [SystemRec, boolean] {
    const old = this.systemByUid(uid);
    if (old) return [old, false];
    const s: SystemRec = { id: this.ids.next('system'), uid, label, description, feature, asset, parent, owner };
    this.systems.set(s.id, s);
    return [s, true];
  }

  /** A system and its ancestors, nearest first. */
  chain(sid: string | null): SystemRec[] {
    const out: SystemRec[] = [];
    const seen = new Set<string>();
    let cur = sid ? this.systems.get(sid) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parent ? this.systems.get(cur.parent) : undefined;
    }
    return out;
  }

  /** store.add_datastream: the same fields are the datastream already there; a new schema a new one (FR-51). */
  addDatastream(system: string, outputName: string, name: string, schema: DataRecord, owner: string | null = null,
): [DatastreamRec, boolean] {
    const same = [...this.datastreams.values()].filter((d) => d.system === system && d.outputName === outputName);
    const live = same.find((d) => !d.replaced);
    if (live && sameSchema(live.schema, schema)) return [live, false];
    const back = same.find((d) => d.replaced && sameSchema(d.schema, schema));
    for (const d of same) d.replaced = true;
    if (back) {
      back.replaced = false;
      return [back, false];
    }
    const d: DatastreamRec = { id: this.ids.next('datastream'), system, outputName, name, schema, owner,
      series: new Series(schema.fields), replaced: false };
    this.datastreams.set(d.id, d);
    return [d, true];
  }

  addControlstream(system: string, inputName: string, name: string, schema: DataRecord, owner: string | null = null): [ControlstreamRec, boolean] {
    for (const c of this.controlstreams.values()) {
      if (c.system === system && c.inputName === inputName && !c.replaced) {
        if (JSON.stringify(c.schema.fields) === JSON.stringify(schema.fields)) return [c, false];
        c.replaced = true;
      }
    }
    const c: ControlstreamRec = { id: this.ids.next('controlstream'), system, inputName, name, schema, owner, replaced: false };
    this.controlstreams.set(c.id, c);
    return [c, true];
  }

  datastream(systemUid: string, outputName: string): DatastreamRec | null {
    const s = this.systemByUid(systemUid);
    if (!s) return null;
    for (const d of this.datastreams.values()) if (d.system === s.id && d.outputName === outputName && !d.replaced) return d;
    return null;
  }

  controlstream(systemUid: string, inputName: string): ControlstreamRec | null {
    const s = this.systemByUid(systemUid);
    if (!s) return null;
    for (const c of this.controlstreams.values()) if (c.system === s.id && c.inputName === inputName && !c.replaced) return c;
    return null;
  }

  appendRow(d: DatastreamRec, t: number, values: Record<string, unknown>): void {
    d.series.appendRow(t, values, ++this.seq);
  }

  /** Rows in bulk, inside the server (FR-20a): the CSV importer's write. */
  appendCols(d: DatastreamRec, t: ArrayLike<number>, cols: Record<string, ArrayLike<unknown>>): void {
    d.series.appendCols(t, cols, this.seq + 1);
    this.seq += t.length;
  }
}

/** One push subscription to a control stream (§9.2). */
export class Subscription {
  closed = false;
  constructor(readonly csId: string, readonly account: Account, readonly model: string | null, readonly stream: PushStream) {}

  put(cmd: Record<string, unknown>): void {
    this.stream.write(JSON.stringify(cmd) + '\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.end();
  }
}

/** Command delivery: pushed to every subscriber at once; dropped without one (§9.1). */
export class Hub {
  subs: Subscription[] = [];

  subscribe(s: Subscription): Subscription {
    this.subs.push(s);
    return s;
  }

  unsubscribe(s: Subscription): void {
    s.close();
    this.subs = this.subs.filter((x) => x !== s);
  }

  subscribers(csId: string): Subscription[] {
    return this.subs.filter((s) => s.csId === csId && !s.closed);
  }

  closeAll(): void {
    for (const s of this.subs) s.close();
    this.subs = [];
  }
}
