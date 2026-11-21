// The logger store (C-02, FR-17, FR-18; logger.py): deliberately awkward,
// append-only files of fixed-width text records, one file per sensor per day
// (BOW_YYYYMMDD.DAT, STN_YYYYMMDD.DAT), time in half-seconds since
// 1994-01-01, coded values, no index, and the last part of a record held back
// on every flush. Written only by the collection platform; read only by the
// store adapter. The stand-in loads the same pre-calculated files the Python
// back end loads (FR-15, FR-06d, AT-27).
//
// Record layout (48 bytes including the newline):
//   0 10 ticks | 11 1 status | 13 4 air T (tenths, M for minus) | 18 3 RH
//   22 5 pressure (tenths) | 28 3 wind speed (tenths) | 32 3 wind dir or VRB
//   36 4 solar | 41 4 water T (tenths, M) | 46 1 precip N/D/R/S
import { FILE_PREFIX, FLUSH_HOLDBACK, LOGGER_EPOCH_UNIX, PRECIP_CODES, REC_LEN, SIM_EPOCH_UNIX, TICKS_PER_SECOND } from './constants';
import { rint } from './py';

export const FIELDS: Record<string, [number, number]> = {
  ticks: [0, 10], status: [11, 1], air_temperature: [13, 4], relative_humidity: [18, 3], pressure: [22, 5],
  apparent_wind_speed: [28, 3], apparent_wind_direction: [32, 3], solar_irradiance: [36, 4],
  water_temperature: [41, 4], precipitation_type: [46, 1],
};

const DAY_BYTES = 86400 * REC_LEN;

interface File {
  buf: Uint8Array;
  len: number;
}

export class LoggerStore {
  private files = new Map<string, File>();
  private held = new Map<string, Uint8Array>();
  private sorted: string[] = [];

  /** A complete file from the pre-calculated history (FR-15): the store's contents at startup. */
  load(name: string, data: Uint8Array): void {
    this.files.set(name, { buf: data, len: data.length });
    this.resort();
  }

  append(name: string, data: Uint8Array): void {
    let f = this.files.get(name);
    if (!f) {
      f = { buf: new Uint8Array(DAY_BYTES), len: 0 };
      this.files.set(name, f);
      this.resort();
    }
    const prev = this.held.get(name);
    let all = data;
    if (prev) {
      all = new Uint8Array(prev.length + data.length);
      all.set(prev);
      all.set(data, prev.length);
      this.held.delete(name);
    }
    if (all.length > FLUSH_HOLDBACK) {
      this.write(f, all.subarray(0, all.length - FLUSH_HOLDBACK));
      this.held.set(name, all.slice(all.length - FLUSH_HOLDBACK));
    } else {
      this.held.set(name, all.slice());
    }
  }

  /** A file is complete (day rollover): write out anything held back. */
  close(name: string): void {
    const h = this.held.get(name);
    const f = this.files.get(name);
    if (h && f) {
      this.write(f, h);
      this.held.delete(name);
    }
  }

  private write(f: File, data: Uint8Array) {
    if (f.len + data.length > f.buf.length) {
      const nb = new Uint8Array(Math.max(f.buf.length * 2, f.len + data.length));
      nb.set(f.buf.subarray(0, f.len));
      f.buf = nb;
    }
    f.buf.set(data, f.len);
    f.len += data.length;
  }

  private resort() {
    this.sorted = [...this.files.keys()].sort();
  }

  /** (name, size) for every file, by name, as `ls` would list them. */
  listFiles(): [string, number][] {
    return this.sorted.map((n) => [n, this.files.get(n)!.len]);
  }

  read(name: string, offset = 0, end?: number): Uint8Array {
    const f = this.files.get(name)!;
    const e = Math.min(end ?? f.len, f.len);
    return f.buf.subarray(Math.min(offset, e), e);
  }

  totalBytes(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.len;
    return n;
  }
}

// --- writing records (the collection platform's side) ----------------------------------

export function simToTicks(t: number): number {
  return rint((SIM_EPOCH_UNIX + t - LOGGER_EPOCH_UNIX) * TICKS_PER_SECOND);
}

export function dayKey(t: number): string {
  const d = new Date((SIM_EPOCH_UNIX + t) * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function fileName(sensor: string, t: number): string {
  return `${FILE_PREFIX[sensor]}_${dayKey(t)}.DAT`;
}

function putDigits(out: Uint8Array, off: number, width: number, v: number) {
  for (let k = 0; k < width; k++) {
    out[off + width - 1 - k] = 48 + (Math.floor(v / 10 ** k) % 10);
  }
}

function putMetar(out: Uint8Array, off: number, x: number) {
  if (!Number.isFinite(x)) {
    out.fill(47, off, off + 4);
    return;
  }
  const n = rint(x * 10);
  putDigits(out, off, 4, Math.min(Math.abs(n), 9999));
  if (n < 0) {
    out[off] = 77; // M for minus
    putDigits(out, off + 1, 3, Math.min(-n, 999));
  }
}

function putInt(out: Uint8Array, off: number, width: number, x: number, scale = 1) {
  if (!Number.isFinite(x)) {
    out.fill(47, off, off + width);
    return;
  }
  putDigits(out, off, width, Math.min(Math.max(rint(x * scale), 0), 10 ** width - 1));
}

export interface Reading {
  air_temperature: number;
  relative_humidity: number;
  pressure: number;
  apparent_wind_speed: number;
  apparent_wind_direction: number;
  solar_irradiance: number;
  water_temperature: number;
  precipitation_type: number;
}

/** One fixed-width record (logger.format_records), written at off in out. */
export function formatRecord(out: Uint8Array, off: number, t: number, v: Reading): void {
  const r = out.subarray(off, off + REC_LEN);
  r.fill(32);
  r[REC_LEN - 1] = 10;
  putDigits(r, 0, 10, simToTicks(t));
  r[11] = 65; // A = normal
  putMetar(r, 13, v.air_temperature);
  putInt(r, 18, 3, v.relative_humidity);
  putInt(r, 22, 5, v.pressure, 10);
  putInt(r, 28, 3, v.apparent_wind_speed, 10);
  const wd = Number.isFinite(v.apparent_wind_direction) ? ((rint(v.apparent_wind_direction) % 360) + 360) % 360 : NaN;
  putInt(r, 32, 3, wd);
  if (Number.isFinite(v.apparent_wind_speed) && v.apparent_wind_speed < 0.5) r.set([86, 82, 66], 32); // VRB
  putInt(r, 36, 4, v.solar_irradiance);
  putMetar(r, 41, v.water_temperature);
  r[46] = PRECIP_CODES.charCodeAt(v.precipitation_type);
}
