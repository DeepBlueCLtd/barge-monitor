// The collection platform, continued (C-01; FR-06d, FR-09, FR-15a). The
// stand-in cannot run the Python world generator, so from the end of the
// pre-calculated history it continues each sensor with illustrative values
// that join the last history values without a seam: the mean of each
// parameter over the last ten seconds, plus smooth seeded drifts and a diurnal
// cycle measured from the end of history, plus declared noise and occasional
// spikes. One 48-byte record per sensor per simulated second goes to the
// logger store (platform → store, L), exactly as sensors.py writes them.
// Deterministic: every value is a pure function of the seed, the sensor and
// the second (FR-14); no Math.random, no host clock (FR-13).
import { parseRecords } from './adapter';
import { REC_LEN, SENSORS } from './constants';
import { fileName, formatRecord, LoggerStore, Reading } from './store';
import type { Tap } from './tap';

const PARAMS = ['air_temperature', 'relative_humidity', 'pressure', 'apparent_wind_speed',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature'] as const;
type Param = (typeof PARAMS)[number];

/** Declared noise, as world.py declares it (σ per parameter), and its spikes. */
const NOISE: Record<Param, number> = {
  air_temperature: 0.08, relative_humidity: 0.8, pressure: 0.05, apparent_wind_speed: 0.25,
  apparent_wind_direction: 4.0, solar_irradiance: 8.0, water_temperature: 0.04,
};
const SPIKE_PROBABILITY = 2e-4;
const SPIKE_SCALE: [number, number] = [15, 40];
/** Amplitude of the slow drifts (illustrative weather), per parameter. */
const DRIFT: Record<Param, number> = {
  air_temperature: 0.7, relative_humidity: 4, pressure: 1.2, apparent_wind_speed: 0.8,
  apparent_wind_direction: 30, solar_irradiance: 0, water_temperature: 0.12,
};
const DRIFT_PERIODS_H = [[3, 7], [7, 13], [13, 31]];
/** Local solar time at the declared fictional longitude (config.ORIGIN_LON = -24.75°). */
const LON_HOURS = -24.75 / 15;
const CHUNK_S = 3600;
/** Readings averaged for the starting value: enough to quieten the noise, few enough to follow a trend. */
const BASE_RECORDS = 10;

/** A 32-bit integer hash (murmur3 finaliser) of a list of integers. */
function hash(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h ^= Math.imul((x | 0) ^ (Math.floor(x / 4294967296) | 0), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

function uniform(...xs: number[]): number {
  return (hash(...xs) + 0.5) / 4294967296;
}

function localHours(t: number): number {
  return ((((t / 3600 + LON_HOURS) % 24) + 24) % 24);
}

/** Diurnal cycle of each parameter (zero mean), illustrative. */
function diurnal(p: Param, t: number): number {
  const h = localHours(t);
  const c = (peak: number) => Math.cos((2 * Math.PI * (h - peak)) / 24);
  switch (p) {
    case 'air_temperature': return 2.2 * c(15);
    case 'relative_humidity': return -9 * c(15);
    case 'pressure': return 0.6 * Math.cos((4 * Math.PI * (h - 10)) / 24);
    case 'apparent_wind_speed': return 0.6 * c(14);
    case 'water_temperature': return 0.25 * c(17);
    default: return 0;
  }
}

function clearSky(t: number): number {
  const e = Math.cos((2 * Math.PI * (localHours(t) - 12)) / 24);
  return e > 0 ? 980 * e ** 1.3 : 0;
}

export class Platform {
  nextT: number;
  private readonly t0: number;
  private base: Record<string, Record<Param, number>> = {};
  private precip: Record<string, number> = {};
  private phase: number[][] = [];
  private period: number[][] = [];
  private lastFile: Record<string, string> = {};

  constructor(private readonly logger: LoggerStore, private readonly tap: Tap, private readonly seed: number, endT: number) {
    this.nextT = endT;
    this.t0 = endT;
    PARAMS.forEach((_, pi) => {
      this.phase.push(DRIFT_PERIODS_H.map((_r, k) => 2 * Math.PI * uniform(seed, 101, pi, k)));
      this.period.push(DRIFT_PERIODS_H.map(([lo, hi], k) => 3600 * (lo + (hi - lo) * uniform(seed, 202, pi, k))));
    });
    for (const s of SENSORS) this.readBase(s);
  }

  /** The last ten seconds of each sensor's history: where the continuation starts. */
  private readBase(sensor: string) {
    const prefix = fileName(sensor, 0).split('_')[0];
    const files = this.logger.listFiles().filter(([n]) => n.startsWith(prefix + '_'));
    const base = {} as Record<Param, number>;
    let precip = 0;
    if (files.length) {
      const [name, size] = files[files.length - 1];
      const end = size - (size % REC_LEN);
      const r = parseRecords(this.logger.read(name, Math.max(0, end - BASE_RECORDS * REC_LEN), end));
      for (const p of PARAMS) {
        const v = Array.from(r[p]).filter(Number.isFinite);
        if (p === 'apparent_wind_direction') {
          const sx = v.reduce((a, d) => a + Math.sin((d * Math.PI) / 180), 0);
          const cx = v.reduce((a, d) => a + Math.cos((d * Math.PI) / 180), 0);
          base[p] = v.length ? (((Math.atan2(sx, cx) * 180) / Math.PI) + 360) % 360 : 0;
        } else base[p] = v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0;
      }
      const codes = Array.from(r.precipitation_type).filter(Number.isFinite);
      precip = codes.length ? codes[codes.length - 1] : 0;
    } else {
      Object.assign(base, { air_temperature: 15, relative_humidity: 75, pressure: 1013, apparent_wind_speed: 3,
        apparent_wind_direction: 0, solar_irradiance: 0, water_temperature: 14 });
    }
    this.base[sensor] = base;
    this.precip[sensor] = precip;
  }

  private drift(pi: number, t: number): number {
    const amp = DRIFT[PARAMS[pi]];
    if (!amp) return 0;
    let s = 0;
    for (let k = 0; k < DRIFT_PERIODS_H.length; k++) s += Math.sin((2 * Math.PI * t) / this.period[pi][k] + this.phase[pi][k]) / (k + 1);
    return amp * s;
  }

  /** A smooth value (no noise): last history value plus what changed since the end of history. */
  private smooth(sensor: string, pi: number, t: number): number {
    const p = PARAMS[pi];
    const b = this.base[sensor][p];
    if (p === 'solar_irradiance') {
      const cloud = (t: number) => 0.8 + 0.15 * Math.sin((2 * Math.PI * t) / this.period[pi][1] + this.phase[pi][1]);
      const sky = clearSky(t) * cloud(t);
      const gap = b - clearSky(this.t0) * cloud(this.t0);
      return Math.max(0, sky + gap * Math.exp(-(t - this.t0) / 1800));
    }
    return b + this.drift(pi, t) - this.drift(pi, this.t0) + diurnal(p, t) - diurnal(p, this.t0);
  }

  private noise(si: number, pi: number, t: number): number {
    const sigma = NOISE[PARAMS[pi]];
    const u1 = uniform(this.seed, si, pi, t, 1);
    const u2 = uniform(this.seed, si, pi, t, 2);
    let x = sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    if (uniform(this.seed, si, pi, t, 3) < SPIKE_PROBABILITY) {
      const mag = SPIKE_SCALE[0] + (SPIKE_SCALE[1] - SPIKE_SCALE[0]) * uniform(this.seed, si, pi, t, 4);
      x += mag * sigma * (uniform(this.seed, si, pi, t, 5) < 0.5 ? -1 : 1);
    }
    return x;
  }

  reading(sensor: string, t: number): Reading {
    const si = SENSORS.indexOf(sensor as (typeof SENSORS)[number]);
    const v = {} as Record<Param, number>;
    PARAMS.forEach((p, pi) => (v[p] = this.smooth(sensor, pi, t) + this.noise(si, pi, t)));
    const rhSmooth = this.smooth(sensor, PARAMS.indexOf('relative_humidity'), t);
    // Precipitation: carried on from history for an hour, then drizzle only in near-saturated air.
    const precip = t - this.t0 < 3600 ? this.precip[sensor] : rhSmooth >= 97 ? 1 : 0;
    return {
      air_temperature: v.air_temperature,
      relative_humidity: Math.min(Math.max(v.relative_humidity, 0), 100),
      pressure: v.pressure,
      apparent_wind_speed: Math.max(v.apparent_wind_speed, 0),
      apparent_wind_direction: ((v.apparent_wind_direction % 360) + 360) % 360,
      solar_irradiance: Math.max(v.solar_irradiance, 0),
      water_temperature: v.water_temperature,
      precipitation_type: precip,
    };
  }

  /** Sample every whole second up to but not including tEnd (sensors.sample_until). */
  sampleUntil(tEnd: number): number {
    const end = Math.floor(tEnd);
    let total = 0;
    while (this.nextT < end) {
      const dayEnd = (Math.floor(this.nextT / 86400) + 1) * 86400; // one file per day
      const stop = Math.min(end, this.nextT + CHUNK_S, dayEnd);
      for (const s of SENSORS) this.write(s, this.nextT, stop);
      total += stop - this.nextT;
      this.nextT = stop;
    }
    return total;
  }

  private write(sensor: string, from: number, to: number) {
    const n = to - from;
    const data = new Uint8Array(n * REC_LEN);
    for (let i = 0; i < n; i++) formatRecord(data, i * REC_LEN, from + i, this.reading(sensor, from + i));
    const name = fileName(sensor, from);
    const prev = this.lastFile[sensor];
    if (prev && prev !== name) this.logger.close(prev);
    this.logger.append(name, data);
    this.lastFile[sensor] = name;
    if (this.tap.recording && this.tap.enabled) {
      const dec = new TextDecoder('ascii');
      for (let i = 0; i < n; i++) {
        this.tap.emit('platform', 'store', 'L', `${sensor} record to ${name}`, dec.decode(data.subarray(i * REC_LEN, (i + 1) * REC_LEN)));
      }
    } else this.tap.count('platform', 'store', 'L', n);
  }
}
