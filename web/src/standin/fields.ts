// What the server can publish, and what it publishes now (FR-50..FR-52;
// fields.py). The catalogue lists every field the control panel can switch:
// the raw quantities of the weather and CO₂ records and the derived values
// Summaries publishes. A field is published only when it is on *and* all its
// inputs are published. The offering is frozen into the server at each
// start: a toggle is pending until then (FR-51).
import { DEF } from './constants';

export interface Field {
  name: string;
  label: string;
  swe_type: string;
  uom: string | null;
  kind: 'raw' | 'model';
  inputs: string[];
  default_on: boolean;
  essential: boolean;
  description: string;
  extra: boolean;
  restricted: boolean;
  definition: string;
}

function field(name: string, label: string, swe_type: string, uom: string | null, o: Partial<Field> = {}): Field {
  return {
    name, label, swe_type, uom, kind: 'raw', inputs: [], default_on: true, essential: false,
    description: '', extra: false, restricted: false, ...o, definition: DEF + name,
  };
}

export const QARTOD_FLAGS = ['1', '2', '3', '4', '9'];

/** The weather record's quantities, in record order (docs/v4-interfaces.md §5, §6). */
export const WEATHER: Field[] = [
  field('air_temperature', 'Air temperature', 'Quantity', 'Cel', { essential: true }),
  field('apparent_wind_speed', 'Wind speed', 'Quantity', 'm/s', { essential: true, description: 'Apparent wind speed, as felt aboard.' }),
  field('relative_humidity', 'Humidity', 'Quantity', '%'),
  field('pressure', 'Pressure', 'Quantity', 'hPa', { description: 'Barometric pressure at the sensor.' }),
  field('apparent_wind_direction', 'Wind direction', 'Quantity', 'deg', { description: 'Apparent wind direction, degrees relative to the bow.' }),
  field('solar_irradiance', 'Solar irradiance', 'Quantity', 'W/m2'),
  field('water_temperature', 'Water temp', 'Quantity', 'Cel'),
];
export const CO2 = field('co2', 'CO₂', 'Quantity', '[ppm]', // UCUM's code for parts per million (D-195)
  { restricted: true, description: 'Carbon dioxide at the sensor package (FR-09a). Restricted.' });
export const RAW: Field[] = [...WEATHER, CO2];
export const QUANTITIES = WEATHER.map((f) => f.name);

export const MODEL_OUTPUTS: Field[] = [
  field('dew_point', 'Dew point', 'Quantity', 'Cel', { kind: 'model', inputs: ['air_temperature', 'relative_humidity'], essential: true,
    description: 'From bow air temperature and humidity (Summaries).' }),
  field('bow_minus_stern', 'Bow − stern', 'Quantity', 'Cel', { kind: 'model', inputs: ['air_temperature'], essential: true,
    description: 'Bow minus stern air temperature (Summaries).' }),
  field('pressure_tendency_3h', 'Pressure tendency', 'Quantity', 'hPa', { kind: 'model', inputs: ['pressure'], default_on: false, extra: true,
    description: 'Change in bow pressure over three hours (Summaries).' }),
];
export const CATALOGUE = new Map<string, Field>([...RAW, ...MODEL_OUTPUTS].map((f) => [f.name, f]));

/** QARTOD range test: [low, high] in the stored unit. */
export const QC_RANGE: Record<string, [number, number]> = {
  air_temperature: [-30, 50], relative_humidity: [0, 100], pressure: [900, 1100], apparent_wind_speed: [0, 60],
  apparent_wind_direction: [0, 360], solar_irradiance: [0, 1500], water_temperature: [-2, 35], co2: [250, 5000],
};
/** A reading further than this from the mean of its two neighbours is suspect (QARTOD spike test). */
export const QC_SPIKE: Record<string, number> = {
  air_temperature: 0.8, relative_humidity: 6.0, pressure: 0.5, apparent_wind_speed: 3.5, solar_irradiance: 150.0,
  water_temperature: 0.4, co2: 60,
};

/** QARTOD flags (1 pass, 2 not evaluated, 3 suspect, 4 fail, 9 missing), computed on import (FR-32). */
export function qcFlags(name: string, v: Float64Array, variable: Uint8Array | null = null): Float64Array {
  const n = v.length;
  const flag = new Float64Array(n).fill(1);
  const [lo, hi] = QC_RANGE[name] ?? [-Infinity, Infinity];
  for (let i = 0; i < n; i++) if (v[i] < lo || v[i] > hi) flag[i] = 4;
  const sp = QC_SPIKE[name];
  if (sp !== undefined && n >= 3) {
    for (let i = 1; i < n - 1; i++) {
      if (Math.abs(v[i] - 0.5 * (v[i - 1] + v[i + 1])) > sp && flag[i] === 1) flag[i] = 3;
    }
  }
  if (variable) for (let i = 0; i < n; i++) if (variable[i]) flag[i] = 2;
  for (let i = 0; i < n; i++) if (Number.isNaN(v[i]) && flag[i] !== 2) flag[i] = 9;
  return flag;
}

export class Offering {
  on: Record<string, boolean>;
  constructor(on?: Record<string, boolean>) {
    this.on = on ?? Object.fromEntries([...CATALOGUE.values()].map((f) => [f.name, f.default_on]));
  }

  copy(): Offering {
    return new Offering({ ...this.on });
  }

  /** True for a field this offering publishes, and for any field the catalogue does not know. */
  published(name: string): boolean {
    const f = CATALOGUE.get(name);
    if (!f) return true;
    if (!this.on[name]) return false;
    return f.inputs.every((i) => this.published(i));
  }

  /** Whether a field of any datastream is served: QC flags and summaries follow their measurement. */
  keep(fieldName: string): boolean {
    const base = fieldName.replace(/_(qc|min|max)$/, '');
    return this.published(base);
  }
}
