// The data server's store (OpenSensorHub's database, in the stand-in): systems,
// datastreams with their observations, control streams and commands. It
// outlives server restarts, as OpenSensorHub's does, and is deleted only by
// Reset instance (FR-50a). Identifiers are opaque, four base-32 characters
// assigned by the server (docs/v4-interfaces.md §6).
//
// Observations are kept as columns. A datastream's observations are appended
// in segments, each in time order: results are appended, never replaced
// (FR-28a), so a later replay run may append times earlier than the last.
import type { Component, DataRecord } from './swe';

export const NUMERIC = new Set(['Quantity', 'Count', 'Boolean']);

export type Col = Float64Array | unknown[];
/** Columns of observations: `t` (Unix seconds) and one column per field. */
export type Cols = { t: Float64Array } & Record<string, Col>;

class NumCol {
  buf: Float64Array;
  end = 0;
  constructor(cap = 256) {
    this.buf = new Float64Array(cap);
  }
  get length() {
    return this.end;
  }
  reserve(n: number) {
    if (this.end + n <= this.buf.length) return;
    const nb = new Float64Array(Math.max(2 * this.buf.length, this.end + n));
    nb.set(this.buf.subarray(0, this.end));
    this.buf = nb;
  }
  push(src: ArrayLike<number>, a = 0, b = src.length) {
    this.reserve(b - a);
    if (src instanceof Float64Array) this.buf.set(src.subarray(a, b), this.end);
    else for (let i = a; i < b; i++) this.buf[this.end + i - a] = src[i];
    this.end += b - a;
  }
  push1(x: number) {
    this.reserve(1);
    this.buf[this.end++] = x;
  }
  at(i: number) {
    return this.buf[i];
  }
  slice(i0: number, i1: number): Float64Array {
    return this.buf.slice(i0, i1);
  }
}

class ObjCol {
  arr: unknown[] = [];
  get length() {
    return this.arr.length;
  }
  push(src: ArrayLike<unknown>, a = 0, b = src.length) {
    for (let i = a; i < b; i++) this.arr.push(src[i]);
  }
  push1(x: unknown) {
    this.arr.push(x);
  }
  at(i: number) {
    return this.arr[i];
  }
  slice(i0: number, i1: number): unknown[] {
    return this.arr.slice(i0, i1);
  }
}

type AnyCol = NumCol | ObjCol;

class Segment {
  t = new NumCol();
  cols = new Map<string, AnyCol>();
  constructor(readonly start: number, kinds: Map<string, 'num' | 'obj'>) {
    for (const [n, k] of kinds) this.cols.set(n, k === 'num' ? new NumCol() : new ObjCol());
  }
  get length() {
    return this.t.length;
  }
  last() {
    return this.t.at(this.t.length - 1);
  }
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 'NaN') return NaN;
  return Number(v);
}

/** A field stored as numbers: Quantity, Count, Boolean, and Category whose tokens are all whole numbers (QC flags). */
export function storedAsNumber(f: Component): boolean {
  if (NUMERIC.has(f.type)) return true;
  const vals: unknown = f.constraint?.values;
  return f.type === 'Category' && Array.isArray(vals) && vals.length > 0 && vals.every((v) => /^\d+$/.test(String(v)));
}

/** Which rows a query selects: parts of segments, in time order once merged. */
export interface Pick {
  parts: [number, number, number][]; // segment, first row, end row
  total: number;
}

/** Append-only observations of one datastream. */
export class Series {
  readonly types = new Map<string, string>();
  readonly kinds = new Map<string, 'num' | 'obj'>();
  private segs: Segment[] = [];
  private count = 0;

  constructor(fields: Component[]) {
    for (const f of fields) {
      if (f.name === 'time') continue;
      this.types.set(f.name, f.type);
      this.kinds.set(f.name, storedAsNumber(f) ? 'num' : 'obj');
    }
  }

  get length(): number {
    return this.count;
  }

  private segFor(t0: number): Segment {
    const last = this.segs[this.segs.length - 1];
    if (last && (last.length === 0 || t0 >= last.last())) return last;
    const s = new Segment(this.count, this.kinds);
    this.segs.push(s);
    return s;
  }

  /** Append rows given as columns (t ascending within the call, as the importer writes them). */
  append(cols: Record<string, unknown>): number {
    const t = cols.t as ArrayLike<number>;
    const n = t ? t.length : 0;
    let a = 0;
    while (a < n) {
      // the longest run in time order from a
      let b = a + 1;
      while (b < n && t[b] >= t[b - 1]) b++;
      const s = this.segFor(t[a]);
      s.t.push(t, a, b);
      for (const [name, col] of s.cols) {
        const v = cols[name] as ArrayLike<unknown> | undefined;
        if (col instanceof NumCol) {
          if (v === undefined || v === null) for (let i = a; i < b; i++) col.push1(NaN);
          else if (v instanceof Float64Array) col.push(v, a, b);
          else for (let i = a; i < b; i++) col.push1(toNumber((v as ArrayLike<unknown>)[i]));
        } else if (v === undefined || v === null) for (let i = a; i < b; i++) col.push1(null);
        else col.push(v as ArrayLike<unknown>, a, b);
      }
      this.count += b - a;
      a = b;
    }
    return n;
  }

  /** Append one observation; returns its ordinal (for its identifier). */
  appendRow(t: number, row: Record<string, unknown>): number {
    const s = this.segFor(t);
    s.t.push1(t);
    for (const [name, col] of s.cols) {
      const v = row[name];
      if (col instanceof NumCol) col.push1(toNumber(v));
      else col.push1(v === undefined ? null : v);
    }
    return this.count++;
  }

  timeRange(): [number, number] | null {
    if (!this.count) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.segs) {
      if (!s.length) continue;
      lo = Math.min(lo, s.t.at(0));
      hi = Math.max(hi, s.last());
    }
    return [lo, hi];
  }

  /** Rows with t0 <= t <= t1. */
  select(t0: number, t1: number): Pick {
    const parts: [number, number, number][] = [];
    let total = 0;
    this.segs.forEach((s, k) => {
      const i0 = bisect(s.t.buf, t0, true, s.length);
      const i1 = bisect(s.t.buf, t1, false, s.length);
      if (i1 > i0) {
        parts.push([k, i0, i1]);
        total += i1 - i0;
      }
    });
    return { parts, total };
  }

  /** The observation received last (resultTime=latest). */
  latest(): Pick {
    if (!this.count) return { parts: [], total: 0 };
    const k = this.segs.length - 1;
    const n = this.segs[k].length;
    return { parts: [[k, n - 1, n]], total: 1 };
  }

  /** One observation by its ordinal, or null. */
  byOrdinal(o: number): Pick | null {
    for (let k = this.segs.length - 1; k >= 0; k--) {
      const s = this.segs[k];
      if (o >= s.start && o < s.start + s.length) return { parts: [[k, o - s.start, o - s.start + 1]], total: 1 };
    }
    return null;
  }

  /**
   * Rows [offset, offset+limit) of a pick, in time order (earlier segments first among equal
   * times), as columns, with each row's ordinal.
   */
  rows(p: Pick, offset: number, limit: number, names: string[] | null = null): Cols & { ord: Float64Array } {
    const want = (names ?? [...this.kinds.keys()]).filter((n) => this.kinds.has(n));
    if (p.parts.length <= 1) {
      const out = { t: new Float64Array(0), ord: new Float64Array(0) } as Cols & { ord: Float64Array };
      if (!p.parts.length) {
        for (const n of want) out[n] = this.kinds.get(n) === 'num' ? new Float64Array(0) : [];
        return out;
      }
      const [k, i0, i1] = p.parts[0];
      const s = this.segs[k];
      const a = Math.min(i1, i0 + offset);
      const b = Math.min(i1, a + limit);
      out.t = s.t.slice(a, b);
      out.ord = Float64Array.from({ length: b - a }, (_, i) => s.start + a + i);
      for (const n of want) out[n] = s.cols.get(n)!.slice(a, b);
      return out;
    }
    // merge the parts by time
    const refs: [number, number][] = [];
    for (const [k, i0, i1] of p.parts) for (let i = i0; i < i1; i++) refs.push([k, i]);
    refs.sort((x, y) => this.segs[x[0]].t.at(x[1]) - this.segs[y[0]].t.at(y[1]) || x[0] - y[0] || x[1] - y[1]);
    const sel = refs.slice(offset, offset + limit);
    const out = {
      t: Float64Array.from(sel, ([k, i]) => this.segs[k].t.at(i)),
      ord: Float64Array.from(sel, ([k, i]) => this.segs[k].start + i),
    } as Cols & { ord: Float64Array };
    for (const n of want) {
      if (this.kinds.get(n) === 'num') out[n] = Float64Array.from(sel, ([k, i]) => (this.segs[k].cols.get(n) as NumCol).at(i));
      else out[n] = sel.map(([k, i]) => (this.segs[k].cols.get(n) as ObjCol).at(i));
    }
    return out;
  }
}

function bisect(a: Float64Array, v: number, left: boolean, n: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (left ? a[mid] < v : a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SystemRec {
  id: string;
  uid: string;
  label: string;
  description: string;
  featureType: string; // sosa:Platform, sosa:Sensor, sosa:System
  assetType: string; // Platform, Equipment, Simulation, Process, Other
  smlType: string; // PhysicalSystem, SimpleProcess, AggregateProcess
  parent: string | null;
  owner: string; // the account that created it ('server' for server configuration)
  characteristics?: unknown;
  extra: Record<string, unknown>;
}

export interface DatastreamRec {
  id: string;
  system: string;
  outputName: string;
  name: string;
  description: string;
  schema: DataRecord;
  series: Series;
  /** Field names, for "a different schema makes a new datastream" (FR-51). */
  sig: string;
}

export interface ControlstreamRec {
  id: string;
  system: string;
  inputName: string;
  name: string;
  description: string;
  schema: DataRecord;
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
  cs: string;
  issueTime: string;
  parameters: Record<string, unknown>;
  sender: string;
  status: StatusReport[];
}

const B32 = '0123456789abcdefghijklmnopqrstuv';

/** Everything the server holds. A new Store is an empty instance (Reset instance). */
export class Store {
  systems = new Map<string, SystemRec>();
  datastreams = new Map<string, DatastreamRec>();
  controlstreams = new Map<string, ControlstreamRec>();
  commands = new Map<string, CommandRec>();
  /** Served datastream id for a datastream seen through an offering that hides fields: `${id}|${fields}` -> id. */
  views = new Map<string, string>();
  private n = 0;
  private used = new Set<string>();

  /** A fresh opaque identifier: four base-32 characters, like OpenSensorHub's (`040g`). */
  newId(): string {
    for (;;) {
      this.n += 1;
      let x = (Math.imul(this.n, 0x9e3b) + 0x1000) & 0xfffff; // a bijection on 20 bits: ids do not look sequential
      let s = '';
      for (let i = 0; i < 4; i++) {
        s = B32[x & 31] + s;
        x >>>= 5;
      }
      if (!this.used.has(s)) {
        this.used.add(s);
        return s;
      }
    }
  }

  systemByUid(uid: string): SystemRec | undefined {
    for (const s of this.systems.values()) if (s.uid === uid) return s;
    return undefined;
  }

  /** The datastream under a system with this output name; the newest when several schemas were registered. */
  datastream(systemId: string, outputName: string): DatastreamRec | undefined {
    let found: DatastreamRec | undefined;
    for (const d of this.datastreams.values()) if (d.system === systemId && d.outputName === outputName) found = d;
    return found;
  }

  controlstream(systemId: string, inputName: string): ControlstreamRec | undefined {
    for (const c of this.controlstreams.values()) if (c.system === systemId && c.inputName === inputName) return c;
    return undefined;
  }

  /** The system and every ancestor, nearest first. */
  lineage(systemId: string): SystemRec[] {
    const out: SystemRec[] = [];
    let s = this.systems.get(systemId);
    while (s && out.length < 16) {
      out.push(s);
      s = s.parent ? this.systems.get(s.parent) : undefined;
    }
    return out;
  }
}
