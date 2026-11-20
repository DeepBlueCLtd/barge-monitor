// What every stand-in model is written against: the data server's internal
// interface (FR-35; backend/models/csmodel.py). A model has `setup` (register
// its process system, datastreams and control stream: FR-28), `step`
// (process newly arrived data) and `onCommand` (take its settings as
// commands: FR-27). The Runner calls them on the simulation clock (FR-13).
// Models see only what the server serves, never the manifest (FR-37).
import { SOSA } from '../constants';
import type { CallResult, ModelHost } from '../modelhost';
import type { Cols } from '../registry';
import { Component, M } from '../swe';
import type { Tap } from '../tap';

export const QUANTITIES = ['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature'];
export const UNITS: Record<string, string> = {
  air_temperature: 'Cel', apparent_wind_speed: 'm/s', relative_humidity: '%', pressure: 'hPa',
  apparent_wind_direction: 'deg', solar_irradiance: 'W/m2', water_temperature: 'Cel',
};
export const LABELS: Record<string, string> = {
  air_temperature: 'Air temperature', apparent_wind_speed: 'Wind speed', relative_humidity: 'Humidity', pressure: 'Pressure',
  apparent_wind_direction: 'Wind direction', solar_irradiance: 'Solar irradiance', water_temperature: 'Water temp',
};
export const PRECIP = ['none', 'drizzle', 'rain', 'showers'];

/** The seven quantities, with the definitions of the raw parameters they come from (FR-29). */
export function measurementFields(): Component[] {
  return QUANTITIES.map((p) => M.quantity(p, LABELS[p], UNITS[p]));
}

/** The data server is waiting or down: try again on the next step. */
export class Unavailable extends Error {}
/** The data server refused the call. */
export class Refused extends Error {}
/** A model cannot run on what it has (Python's ValueError in the models). */
export class NoRun extends Error {}

export interface Command {
  id: string;
  issueTime: string;
  parameters: Record<string, unknown>;
}

/** Calls to the data server's internal interface (docs/v4-interfaces.md §7), in-process. */
export class ModelApi {
  quiet = false;

  constructor(readonly model: string, private readonly host: ModelHost, private readonly rt: { now(): number; tap: Tap }) {}

  call<T>(op: string, args: Record<string, unknown>): T {
    const r: CallResult = this.host.call(this.model, op, args, this.quiet);
    if (r.ok) return r.result as T;
    if (r.status === 'waiting' || r.status === 'down') throw new Unavailable(r.error);
    throw new Refused(r.error);
  }

  now(): number {
    return this.rt.now();
  }

  /** Capture a call into, or a result out of, the scientific libraries (models ↔ scilibs). */
  tap(dst: 'scilibs' | 'models', summary: string, content?: unknown): void {
    const [src, to] = dst === 'scilibs' ? (['models', 'scilibs'] as const) : (['scilibs', 'models'] as const);
    this.rt.tap.emit(src, to, 'I', `${this.model}: ${summary}`, content, { model: this.model, quiet: this.quiet });
  }

  createSystem(body: Record<string, unknown>): string {
    return this.call('create_system', { body });
  }
  createDatastream(systemId: string, body: Record<string, unknown>): string {
    return this.call('create_datastream', { system_id: systemId, body });
  }
  createControlstream(systemId: string, body: Record<string, unknown>): string {
    return this.call('create_controlstream', { system_id: systemId, body });
  }
  find(systemUid: string, outputName: string, since: number | null = null): string | null {
    return this.call('find', { system_uid: systemUid, output_name: outputName, since });
  }
  read(key: string, t0: number, t1: number, fields: string[] | null = null): Cols {
    return this.call('read', { key, t0, t1, fields });
  }
  publish(key: string, cols: Record<string, unknown>, replace = false): number {
    return this.call('publish', { key, cols, replace });
  }
  commands(key: string): Command[] {
    return this.call('commands', { key });
  }
  commandStatus(cmdId: string, status: string, message = ''): string {
    return this.call('command_status', { cmd_id: cmdId, status, message });
  }
  score(kind: string, payload: Record<string, unknown>): Record<string, number | null> {
    return this.call('score', { kind, payload });
  }
}

/** Subclass this. `interval` is in simulated seconds. */
export abstract class Model {
  abstract readonly id: string;
  abstract readonly label: string;
  description = '';
  interval = 60;
  /** How much history one step takes while catching up. The stand-in takes big steps: startup is fast. */
  catchUpChunk = 86400;
  startFrom: 'history' | 'now' = 'history';
  system = '';
  controlKey: string | null = null;

  systemBody(): Record<string, unknown> {
    return {
      uniqueId: `urn:x-barge:process:${this.id}`, label: this.label, description: this.description,
      systemType: SOSA + 'System', assetType: 'Process',
    };
  }

  setup(api: ModelApi): void {
    this.system = api.createSystem(this.systemBody());
  }

  /** Process data in (t0, t1]; return the time processed up to. */
  step(_api: ModelApi, _t0: number, t1: number): number {
    return t1;
  }

  onCommand(_api: ModelApi, _cmd: Command): string {
    return 'no settings to apply';
  }

  /** For a model that starts from now: a first run once its inputs exist. True when done. */
  initial(_api: ModelApi): boolean {
    return true;
  }
}

/** Steps a model on the simulation clock (csmodel.Runner). */
export class Runner {
  ready = false;
  last: number | null = null;
  phase = 'starting';
  detail = '';
  errors = 0;
  inbox: Command[] = [];
  initialDone = false;

  constructor(readonly model: Model, readonly api: ModelApi) {}

  notify(message: Record<string, any>): void {
    if (message.type === 'command') this.inbox.push(message.command as Command);
  }

  get caughtUp(): boolean {
    return this.last !== null && this.api.now() - this.last < Math.max(2 * this.model.interval, 120);
  }

  tick(playing: boolean): void {
    const { api, model: m } = this;
    const now = api.now();
    try {
      if (!this.ready) {
        api.quiet = true;
        m.setup(api);
        this.ready = true;
        this.last = m.startFrom === 'history' ? 0 : now;
        this.phase = 'catching up';
      }
      if (m.startFrom === 'now' && !this.initialDone) {
        api.quiet = true;
        this.initialDone = m.initial(api);
        this.detail = this.initialDone ? '' : 'waiting for its inputs';
        this.phase = this.initialDone ? 'live' : 'catching up';
        return;
      }
      if (!this.caughtUp) {
        api.quiet = true;
        const last = this.last!;
        const upto = Math.min(now, last + m.catchUpChunk);
        const done = m.step(api, last, upto);
        this.last = Math.max(last, done);
        this.detail = `${Math.min(100, Math.round((100 * this.last) / Math.max(now, 1)))}% of history`;
        if (this.caughtUp) {
          this.phase = 'live';
          this.detail = '';
        }
        return;
      }
      api.quiet = false;
      this.phase = 'live';
      this.detail = '';
      while (this.inbox.length) {
        const cmd = this.inbox.shift()!;
        api.commandStatus(cmd.id, 'ACCEPTED');
        try {
          const msg = m.onCommand(api, cmd);
          api.commandStatus(cmd.id, 'COMPLETED', msg || '');
        } catch (e) {
          if (e instanceof Unavailable || e instanceof Refused) throw e;
          api.commandStatus(cmd.id, 'FAILED', `${errorName(e)}: ${(e as Error)?.message ?? e}`);
        }
      }
      if (playing && now - this.last! >= m.interval) this.last = Math.max(this.last!, m.step(api, this.last!, now));
    } catch (e) {
      if (e instanceof Unavailable) this.detail = `waiting: ${e.message}`;
      else if (e instanceof Refused) {
        this.errors += 1;
        this.detail = `refused: ${e.message}`;
      } else throw e;
    } finally {
      api.quiet = false;
    }
  }
}

function errorName(e: unknown): string {
  if (e instanceof NoRun) return 'ValueError';
  return (e as Error)?.name ?? 'Error';
}

// --- small numerical helpers (the stand-in's "scientific libraries") ----------------------

/** Round each value to nd decimals, half to even (numpy.round). */
export function roundArr(v: Float64Array, nd: number): Float64Array {
  const s = 10 ** nd;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) {
      out[i] = x;
      continue;
    }
    const y = x * s;
    const f = Math.floor(y);
    const d = y - f;
    out[i] = (d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1) / s;
  }
  return out;
}

/** numpy.interp with left/right NaN. */
export function interp(x: Float64Array, xp: Float64Array, fp: Float64Array): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const n = xp.length;
  if (!n) return out;
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v < xp[0] || v > xp[n - 1]) continue;
    while (j < n - 2 && xp[j + 1] < v) j++;
    while (j > 0 && xp[j] > v) j--;
    if (v === xp[j]) out[i] = fp[j];
    else if (j + 1 < n) {
      const w = (v - xp[j]) / (xp[j + 1] - xp[j]);
      out[i] = fp[j] + w * (fp[j + 1] - fp[j]);
    } else out[i] = fp[j];
  }
  return out;
}

/** A small deterministic generator (mulberry32) for a model's own named stream (FR-14). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
