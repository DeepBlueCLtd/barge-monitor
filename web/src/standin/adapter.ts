// Store adapter (C-03, FR-20..FR-22; adapter.py): the only code that
// understands the logger's format. It holds its own index over the store
// (for every file, the time of each complete record, so a time range maps to
// a byte range), dropped on every server start and rebuilt a step at a time
// while the server waits (FR-47). Records are parsed only when asked for,
// exactly as adapter.py parses them: METAR `M` for minus, `VRB`, `/` for
// missing, precipitation letter codes.
import { INDEX_CHUNK_RECORDS, LOGGER_EPOCH_UNIX, PRECIP_CODES, REC_LEN, SENSOR_OF_PREFIX, SIM_EPOCH_UNIX, TICKS_PER_SECOND } from './constants';
import { searchsorted } from './py';
import { FIELDS, LoggerStore } from './store';
import type { Tap } from './tap';

export const COLUMNS = ['t', 'air_temperature', 'relative_humidity', 'pressure', 'apparent_wind_speed',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature', 'precipitation_type', 'wd_variable'] as const;
export type Columns = Record<(typeof COLUMNS)[number], Float64Array>;

const TICK_OFFSET = LOGGER_EPOCH_UNIX - SIM_EPOCH_UNIX;

/** `_digits`: the characters of a field as a base-10 number, whatever they are. */
function digits(b: Uint8Array, off: number, width: number): number {
  let v = 0;
  for (let k = 0; k < width; k++) v = v * 10 + (b[off + k] - 48);
  return v;
}

function missing(b: Uint8Array, off: number, width: number): boolean {
  for (let k = 0; k < width; k++) if (b[off + k] === 47) return true;
  return false;
}

function ticksToSim(ticks: number): number {
  return ticks / TICKS_PER_SECOND + TICK_OFFSET;
}

const [AT, RH, PR, WS, WD, SO, WT, PT] = ['air_temperature', 'relative_humidity', 'pressure', 'apparent_wind_speed',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature', 'precipitation_type'].map((n) => FIELDS[n][0]);

function plain(b: Uint8Array, at: number, width: number, scale = 1): number {
  return missing(b, at, width) ? NaN : digits(b, at, width) / scale;
}

/** Tenths with M for minus (METAR), 4 characters. */
function metar(b: Uint8Array, at: number): number {
  if (missing(b, at, 4)) return NaN;
  return b[at] === 77 ? -digits(b, at + 1, 3) / 10 : digits(b, at, 4) / 10;
}

/** adapter.parse_records: a block of whole records as columns. */
export function parseRecords(data: Uint8Array): Columns {
  const n = Math.floor(data.length / REC_LEN);
  const out = Object.fromEntries(COLUMNS.map((c) => [c, new Float64Array(n)])) as Columns;
  const pcode = new Float64Array(256).fill(NaN);
  for (let i = 0; i < PRECIP_CODES.length; i++) pcode[PRECIP_CODES.charCodeAt(i)] = i;
  for (let i = 0; i < n; i++) {
    const base = i * REC_LEN;
    if (data[base + REC_LEN - 1] !== 10) throw new Error('misaligned record block');
    out.t[i] = ticksToSim(digits(data, base, 10));
    out.air_temperature[i] = metar(data, base + AT);
    out.relative_humidity[i] = plain(data, base + RH, 3);
    out.pressure[i] = plain(data, base + PR, 5, 10);
    out.apparent_wind_speed[i] = plain(data, base + WS, 3, 10);
    const vrb = data[base + WD] === 86; // V of VRB
    out.apparent_wind_direction[i] = vrb || missing(data, base + WD, 3) ? NaN : digits(data, base + WD, 3);
    out.wd_variable[i] = vrb ? 1 : 0;
    out.solar_irradiance[i] = plain(data, base + SO, 4);
    out.water_temperature[i] = metar(data, base + WT);
    out.precipitation_type[i] = pcode[data[base + PT]];
  }
  return out;
}

class FileIndex {
  readonly sensor: string;
  t = new Float64Array(0);
  n = 0;
  bytes = 0; // complete records indexed
  constructor(readonly name: string) {
    this.sensor = SENSOR_OF_PREFIX[name.split('_')[0]];
  }
  push(times: Float64Array) {
    if (this.n + times.length > this.t.length) {
      const nt = new Float64Array(Math.max(86400, this.t.length * 2, this.n + times.length));
      nt.set(this.t.subarray(0, this.n));
      this.t = nt;
    }
    this.t.set(times, this.n);
    this.n += times.length;
  }
}

export class StoreAdapter {
  private files = new Map<string, FileIndex>();
  private sortedNames: string[] = [];

  constructor(private readonly logger: LoggerStore, private readonly tap: Tap | null) {}

  /** Drop the index. It is rebuilt from the store (FR-22). */
  reset(): void {
    this.files.clear();
    this.sortedNames = [];
  }

  /** Index up to maxRecords new complete records. True when up to date. */
  indexStep(maxRecords = INDEX_CHUNK_RECORDS): boolean {
    let budget = maxRecords;
    for (const [name, size] of this.logger.listFiles()) {
      let fi = this.files.get(name);
      if (!fi) {
        fi = new FileIndex(name);
        this.files.set(name, fi);
        this.sortedNames = [...this.files.keys()].sort();
      }
      const complete = size - (size % REC_LEN);
      if (complete <= fi.bytes) continue;
      const take = Math.min(complete - fi.bytes, budget * REC_LEN);
      const data = this.logger.read(name, fi.bytes, fi.bytes + take);
      const n = take / REC_LEN;
      const times = new Float64Array(n);
      for (let i = 0; i < n; i++) times[i] = ticksToSim(digits(data, i * REC_LEN, 10));
      fi.push(times);
      fi.bytes += take;
      budget -= n;
      if (budget <= 0) return false;
    }
    return true;
  }

  indexedRecords(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.n;
    return n;
  }

  storeRecords(): number {
    let n = 0;
    for (const [, s] of this.logger.listFiles()) n += Math.floor(s / REC_LEN);
    return n;
  }

  private sorted(sensor: string): FileIndex[] {
    return this.sortedNames.map((n) => this.files.get(n)!).filter((f) => f.sensor === sensor);
  }

  timeRange(sensor: string): [number, number] | null {
    const files = this.sorted(sensor).filter((f) => f.n);
    if (!files.length) return null;
    const last = files[files.length - 1];
    return [files[0].t[0], last.t[last.n - 1]];
  }

  count(sensor: string, t0: number, t1: number): number {
    let n = 0;
    for (const f of this.sorted(sensor)) {
      if (f.n && f.t[0] <= t1 && f.t[f.n - 1] >= t0) {
        n += searchsorted(f.t, t1, 'right', f.n) - searchsorted(f.t, t0, 'left', f.n);
      }
    }
    return n;
  }

  /** Records with t0 <= t <= t1, oldest first, after skipping `offset` (adapter.read). */
  read(sensor: string, t0: number, t1: number, limit: number | null = null, offset = 0, quiet = false): Columns {
    const blocks: Columns[] = [];
    let want = limit;
    let skip = offset;
    for (const f of this.sorted(sensor)) {
      if (!f.n || f.t[0] > t1 || f.t[f.n - 1] < t0) continue;
      let i0 = searchsorted(f.t, t0, 'left', f.n);
      let i1 = searchsorted(f.t, t1, 'right', f.n);
      if (skip) {
        const d = Math.min(skip, i1 - i0);
        i0 += d;
        skip -= d;
      }
      if (want !== null) i1 = Math.min(i1, i0 + want);
      if (i1 <= i0) continue;
      this.tap?.emit('adapter', 'store', 'S', `read ${f.name} at byte ${i0 * REC_LEN}, found through the index`, {
        op: 'read', file: f.name, offset: i0 * REC_LEN, length: (i1 - i0) * REC_LEN, records: i1 - i0,
        found_by: 'index: time to file and offset',
      }, { quiet });
      const data = this.logger.read(f.name, i0 * REC_LEN, i1 * REC_LEN);
      if (this.tap && !quiet) {
        this.tap.emit('store', 'adapter', 'L', `${i1 - i0} records from ${f.name}`,
          new TextDecoder('ascii').decode(data.subarray(0, REC_LEN * 3)) + (i1 - i0 > 3 ? '…' : ''));
      } else this.tap?.count('store', 'adapter', 'L');
      blocks.push(parseRecords(data));
      if (want !== null) {
        want -= i1 - i0;
        if (want <= 0) break;
      }
    }
    return concatColumns(blocks);
  }
}

export function concatColumns(blocks: Columns[]): Columns {
  if (blocks.length === 1) return blocks[0];
  const n = blocks.reduce((a, b) => a + b.t.length, 0);
  const out = {} as Columns;
  for (const c of COLUMNS) {
    const arr = new Float64Array(n);
    let o = 0;
    for (const b of blocks) {
      arr.set(b[c], o);
      o += b[c].length;
    }
    out[c] = arr;
  }
  return out;
}
