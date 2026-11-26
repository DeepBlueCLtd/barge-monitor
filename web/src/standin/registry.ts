// Resources the models create, and the observations they publish (FR-28;
// registry.py). Like a real server's database it outlives server restarts.
// Observations are kept as columns: numeric fields (Quantity, Count, Boolean)
// as float arrays with NaN for missing, everything else as plain arrays. A
// datastream may declare a retention: older rows are dropped once every
// model that reads it has read past them.
import { searchsorted } from './py';
import type { Component, DataRecord } from './swe';

export const NUMERIC = new Set(['Quantity', 'Count', 'Boolean']);

export type Col = Float64Array | unknown[];
/** Columns of observations: `t` (simulated seconds) and one column per field. */
export type Cols = { t: Float64Array } & Record<string, Col>;

class NumCol {
  buf = new Float64Array(1024);
  start = 0;
  end = 0;
  get length() {
    return this.end - this.start;
  }
  push(src: ArrayLike<number>, idx: number[] | null) {
    const n = idx ? idx.length : src.length;
    if (this.end + n > this.buf.length) {
      const live = this.end - this.start;
      const nb = live + n > this.buf.length / 2 ? new Float64Array(Math.max(2 * this.buf.length, 2 * (live + n))) : this.buf;
      if (nb === this.buf) this.buf.copyWithin(0, this.start, this.end);
      else nb.set(this.buf.subarray(this.start, this.end));
      this.buf = nb;
      this.start = 0;
      this.end = live;
    }
    if (idx) for (let i = 0; i < n; i++) this.buf[this.end + i] = src[idx[i]];
    else this.buf.set(src as ArrayLike<number>, this.end);
    this.end += n;
  }
  at(i: number) {
    return this.buf[this.start + i];
  }
  slice(i0: number, i1: number): Float64Array {
    return this.buf.slice(this.start + i0, this.start + i1);
  }
  drop(n: number) {
    this.start += n;
  }
  clear() {
    this.start = this.end = 0;
  }
}

class ObjCol {
  arr: unknown[] = [];
  start = 0;
  get length() {
    return this.arr.length - this.start;
  }
  push(src: unknown[]) {
    for (const v of src) this.arr.push(v);
  }
  slice(i0: number, i1: number): unknown[] {
    return this.arr.slice(this.start + i0, this.start + i1);
  }
  drop(n: number) {
    this.start += n;
    if (this.start > 4096 && this.start > this.arr.length / 2) {
      this.arr = this.arr.slice(this.start);
      this.start = 0;
    }
  }
  clear() {
    this.arr = [];
    this.start = 0;
  }
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v);
}

/** Append-only columns ordered by time (registry.Series). */
export class Series {
  readonly types = new Map<string, string>();
  private tcol = new NumCol();
  private cols = new Map<string, NumCol | ObjCol>();
  readers = new Map<string, number>(); // model -> latest time it has read

  constructor(fields: Component[], readonly retention: number | null = null) {
    for (const f of fields) if (f.name !== 'time') this.types.set(f.name, f.type);
    for (const [n, ty] of this.types) this.cols.set(n, NUMERIC.has(ty) ? new NumCol() : new ObjCol());
  }

  get length(): number {
    return this.tcol.length;
  }

  colNames(): string[] {
    return [...this.cols.keys()];
  }

  tAt(i: number): number {
    return this.tcol.at(i);
  }

  clear(): void {
    this.tcol.clear();
    for (const c of this.cols.values()) c.clear();
  }

  append(cols: Record<string, unknown>): number {
    const t = cols.t as ArrayLike<number>;
    if (!t || !t.length) return 0;
    // equal times allowed: two runs in one second
    const last = this.length ? this.tAt(this.length - 1) : -Infinity;
    const idx: number[] = [];
    for (let i = 0; i < t.length; i++) if (t[i] >= last) idx.push(i);
    if (!idx.length) return 0;
    const all = idx.length === t.length;
    this.tcol.push(Float64Array.from(t), all ? null : idx);
    for (const [n, ty] of this.types) {
      const v = cols[n] as ArrayLike<unknown> | undefined;
      const c = this.cols.get(n)!;
      if (NUMERIC.has(ty)) {
        const arr = v === undefined || v === null ? new Float64Array(t.length).fill(NaN)
          : v instanceof Float64Array ? v : Float64Array.from(Array.from(v as ArrayLike<unknown>, toNumber));
        (c as NumCol).push(arr, all ? null : idx);
      } else {
        const vals = v === undefined || v === null ? new Array(t.length).fill(null) : Array.from(v as ArrayLike<unknown>);
        (c as ObjCol).push(all ? vals : idx.map((i) => vals[i]));
      }
    }
    return idx.length;
  }

  prune(now: number): void {
    // nothing is dropped before some model has said it reads this datastream
    if (this.retention === null || !this.length || !this.readers.size) return;
    let cut = now - this.retention;
    for (const r of this.readers.values()) cut = Math.min(cut, r);
    const i = this.range(cut, Infinity)[0];
    if (i) {
      this.tcol.drop(i);
      for (const c of this.cols.values()) c.drop(i);
    }
  }

  range(t0: number, t1: number): [number, number] {
    const n = this.length;
    const buf = this.tcol.buf.subarray(this.tcol.start, this.tcol.end);
    return [searchsorted(buf, t0, 'left', n), searchsorted(buf, t1, 'right', n)];
  }

  /** Rows [i0, i1) of the named columns (all when names is null). */
  slice(i0: number, i1: number, names: string[] | null = null): Cols {
    const n = this.length;
    const a = Math.max(0, Math.min(i0 < 0 ? n + i0 : i0, n));
    const b = Math.max(a, Math.min(i1 < 0 ? n + i1 : i1, n));
    const out: Cols = { t: this.tcol.slice(a, b) };
    for (const name of names ?? this.colNames()) {
      const c = this.cols.get(name);
      if (c) out[name] = c.slice(a, b);
    }
    return out;
  }
}

export interface SystemRec {
  type: string;
  id: string;
  uniqueId: string;
  label: string;
  description: string;
  definition: string;
  systemType: string;
  assetType: string;
  parent?: string;
}

export interface DatastreamRec {
  key: string;
  system: string;
  outputName: string;
  name: string;
  schema: DataRecord;
  series: Series;
}

export interface ControlstreamRec {
  key: string;
  system: string;
  inputName: string;
  name: string;
  schema: DataRecord;
}

export interface StatusReport {
  statusCode: string;
  reportTime: string;
  message?: string;
}

export interface CommandRec {
  id: string;
  'controlstream@id': string;
  cs_key: string;
  issueTime: string;
  parameters: Record<string, unknown>;
  status: StatusReport[];
}

/** Created resources. Keys are stable (system:name); public ids carry a schema hash. */
export class Registry {
  systems = new Map<string, SystemRec>();
  datastreams = new Map<string, DatastreamRec>();
  controlstreams = new Map<string, ControlstreamRec>();
  commands = new Map<string, CommandRec>();
  commandSeq = 0;

  systemIdFor(uniqueId: string): string {
    const parts = uniqueId.split(':');
    const base = parts[parts.length - 1] || 'system';
    let sid = base;
    let n = 1;
    while (this.systems.has(sid)) {
      n += 1;
      sid = `${base}-${n}`;
    }
    return sid;
  }
}
