// Summaries, stand-in (FR-29, FR-34): from Data cleanse's output only (AT-15),
// per dataset and per replay run, it publishes the minimum, mean and maximum of
// each quantity over each minute and each hour (`<f>_min`, `<f>`, `<f>_max`),
// and derived values: dew point, bow minus stern air temperature and the
// pressure tendency. CO₂ summaries go under its restricted subsystem (FR-112).
// A minute is published once Data cleanse has published it for the same run.
import { SENSORS } from '../constants';
import { M } from '../swe';
import { Api, Cols, Command, DatasetCtx, LABELS, Model, Rejected, round, runField, UNITS } from './csmodel';
import { WEATHER_FIELDS } from './dataCleanse';

const DC = 'urn:x-barge:process:data-cleanse';
const DC_R = 'urn:x-barge:process:data-cleanse:restricted';

export function dewPoint(T: number, RH: number): number {
  const a = 17.62;
  const b = 243.12;
  const rh = Math.min(Math.max(RH, 1), 100);
  const g = Math.log(rh / 100) + (a * T) / (b + T);
  return (b * g) / (a - g);
}

/** Min, mean and max of the values of one run, NaN when there are none. */
function stats(v: Float64Array, keep: (i: number) => boolean): [number, number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  let s = 0;
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    if (!keep(i) || !Number.isFinite(v[i])) continue;
    lo = Math.min(lo, v[i]);
    hi = Math.max(hi, v[i]);
    s += v[i];
    n++;
  }
  return n ? [round(lo, 3), round(s / n, 3), round(hi, 3)] : [NaN, NaN, NaN];
}

function statFields(names: string[]) {
  return names.flatMap((f) => [M.quantity(`${f}_min`, `${LABELS[f]}, minimum`, UNITS[f]), M.quantity(f, `${LABELS[f]}, mean`, UNITS[f]),
    M.quantity(`${f}_max`, `${LABELS[f]}, maximum`, UNITS[f])]);
}

export class Summaries extends Model {
  readonly id = 'summaries';
  readonly label = 'Summaries';
  description = 'Core model: 1-minute and hourly minimum, mean and maximum, and derived values.';
  readonly maxRate = 100;
  window = 60;
  settings = { tendency_hours: 3.0 };
  private fields = new Map<string, string[]>(); // `${ds}|${sensor}` -> quantities in Data cleanse's output

  async setup(api: Api): Promise<void> {
    await super.setup(api);
    this.controlKey = await api.createControlstream(this.uid, {
      name: 'Summaries settings', inputName: 'settings',
      schema: M.record('Summaries settings', [M.quantity('tendency_hours', 'Pressure tendency span', 'h', 1, 6)]),
    });
  }

  async prepare(api: Api, ds: DatasetCtx): Promise<boolean> {
    for (const s of SENSORS) {
      const key = await api.find(DC, `cleaned-${s}__${ds.id}`);
      if (!key) return false; // Data cleanse has not created it yet
      const types = await api.fieldTypes(key);
      this.fields.set(`${ds.id}|${s}`, WEATHER_FIELDS.filter((f) => types.has(f)));
    }
    for (const [res, label] of [['1min', '1-minute'], ['1h', 'hourly']]) {
      for (const s of SENSORS) {
        const cap = s === 'bow' ? 'Bow' : 'Stern';
        const names = this.fields.get(`${ds.id}|${s}`)!;
        await api.createDatastream(this.uid, {
          name: `${cap} ${label} summary, ${ds.id}`, outputName: `summary-${res}-${s}__${ds.id}`,
          schema: M.record(`${cap} ${label} summary`, [M.time('time', 'Start of the interval'), ...statFields(names), runField()]),
        });
        await api.createDatastream(this.restrictedUid, {
          name: `${cap} ${label} CO₂ summary, ${ds.id}`, outputName: `summary-${res}-co2-${s}__${ds.id}`,
          schema: M.record(`${cap} ${label} CO₂ summary`, [M.time('time', 'Start of the interval'), ...statFields(['co2']), runField()]),
        });
      }
      await api.createDatastream(this.uid, {
        name: `Derived values, ${label}, ${ds.id}`, outputName: `derived-${res}__${ds.id}`,
        schema: M.record(`Derived values, ${label}`, [M.time('time', 'Start of the interval'), M.quantity('dew_point', 'Dew point', 'Cel'),
          M.quantity('bow_minus_stern', 'Bow − stern', 'Cel'), M.quantity('pressure_tendency_3h', 'Pressure tendency', 'hPa'), runField()]),
      });
    }
    return true;
  }

  async validate(_api: Api, cmd: Command): Promise<void> {
    const v = cmd.parameters.tendency_hours;
    if (typeof v !== 'number' || !(v >= 1 && v <= 6)) throw new Rejected(`tendency_hours ${JSON.stringify(v)} is outside its bounds, 1 to 6`);
  }

  async apply(_api: Api, cmd: Command): Promise<string> {
    this.settings.tendency_hours = Number(cmd.parameters.tendency_hours);
    return `tendency over ${this.settings.tendency_hours} h`;
  }

  async process(api: Api, ds: DatasetCtx, t0: number, t1: number, run: string): Promise<boolean> {
    const minute = await this.interval(api, ds, t0, t1, run, '1min');
    if (!minute) return false;
    if ((t1 - ds.start) % 3600 === 0 || t1 === ds.end) {
      const h0 = Math.max(ds.start, t1 - (((t1 - ds.start) % 3600) || 3600));
      await this.interval(api, ds, h0, t1, run, '1h');
    }
    return true;
  }

  /** One interval (t0, t1] at one resolution. False when Data cleanse has not reached t1 for this run. */
  private async interval(api: Api, ds: DatasetCtx, t0: number, t1: number, run: string, res: string): Promise<boolean> {
    const from = t0 === ds.start ? t0 : t0 + 1;
    const data: Record<string, Cols> = {};
    for (const s of SENSORS) {
      const c = await api.read(`${DC}|cleaned-${s}__${ds.id}`, from, t1);
      const runs = c.run as unknown[];
      let reached = false;
      for (let i = 0; i < c.t.length; i++) if (runs[i] === run && c.t[i] >= t1) reached = true;
      if (!reached) return false;
      data[s] = c;
    }
    api.sci('call', `${res === '1min' ? 'minute' : 'hourly'} statistics, ${ds.id}`, { calls: ['min', 'mean', 'max', 'dew point'], from: t0, to: t1 });
    const means: Record<string, Record<string, number>> = { bow: {}, stern: {} };
    for (const s of SENSORS) {
      const c = data[s];
      const runs = c.run as unknown[];
      const keep = (i: number) => runs[i] === run;
      const row: Record<string, unknown> = { time: t0, run };
      for (const f of this.fields.get(`${ds.id}|${s}`) ?? []) {
        const [lo, mean, hi] = stats(c[f] as Float64Array, keep);
        Object.assign(row, { [`${f}_min`]: lo, [f]: mean, [`${f}_max`]: hi });
        means[s][f] = mean;
      }
      await api.publish(`${this.uid}|summary-${res}-${s}__${ds.id}`, row);
      // CO₂ summaries, restricted (FR-112)
      const co2 = await api.read(`${DC_R}|cleaned-co2-${s}__${ds.id}`, from, t1).catch(() => null);
      if (co2 && co2.t.length) {
        const cr = co2.run as unknown[];
        const [lo, mean, hi] = stats(co2.co2 as Float64Array, (i) => cr[i] === run);
        await api.publish(`${this.restrictedUid}|summary-${res}-co2-${s}__${ds.id}`, { time: t0, run, co2_min: lo, co2: mean, co2_max: hi });
      }
    }
    const T = means.bow.air_temperature;
    const RH = means.bow.relative_humidity;
    const span = Math.round(this.settings.tendency_hours * 3600);
    let tendency = NaN;
    if (Number.isFinite(means.bow.pressure) && t0 - span >= ds.start) {
      const past = await api.read(`${DC}|cleaned-bow__${ds.id}`, t0 - span + 1, t0 - span + (t1 - t0), ['pressure']);
      const [, pm] = stats(past.pressure as Float64Array, () => true);
      tendency = round(means.bow.pressure - pm, 3);
    }
    api.sci('result', `derived values at ${res}`, { dew_point: round(dewPoint(T, RH), 3) });
    await api.publish(`${this.uid}|derived-${res}__${ds.id}`, {
      time: t0, run, dew_point: Number.isFinite(T) && Number.isFinite(RH) ? round(dewPoint(T, RH), 3) : NaN,
      bow_minus_stern: round(T - means.stern.air_temperature, 3), pressure_tendency_3h: tendency,
    });
    return true;
  }
}
