// What the server can publish, and what it publishes now (FR-50..FR-52;
// fields.py). The catalogue lists every field the control panel can switch:
// the raw parameters (both sensors together), the model outputs the server
// knows, and three extra fields, off by default. A field is published only
// when it is on *and* all its inputs are published. The offering is frozen
// into the server at each start: a toggle is pending until then (FR-51).
import { DEF } from './constants';
import { sha1Hex } from './sha1';

export interface Field {
  name: string;
  label: string;
  swe_type: string;
  uom: string | null;
  kind: 'raw' | 'model';
  inputs: string[];
  default_on: boolean;
  essential: boolean;
  tokens: string[];
  description: string;
  extra: boolean;
  definition: string;
}

function field(name: string, label: string, swe_type: string, uom: string | null, o: Partial<Field> = {}): Field {
  return {
    name, label, swe_type, uom, kind: 'raw', inputs: [], default_on: true, essential: false, tokens: [],
    description: '', extra: false, ...o, definition: DEF + name,
  };
}

export const QARTOD_FLAGS = ['1', '2', '3', '4', '9'];

export const RAW: Field[] = [
  field('air_temperature', 'Air temperature', 'Quantity', 'Cel', { essential: true }),
  field('apparent_wind_speed', 'Wind speed', 'Quantity', 'm/s', { essential: true, description: 'Apparent wind speed, as felt aboard.' }),
  field('relative_humidity', 'Humidity', 'Quantity', '%'),
  field('pressure', 'Pressure', 'Quantity', 'hPa', { description: 'Barometric pressure at the sensor.' }),
  field('apparent_wind_direction', 'Wind direction', 'Quantity', 'deg', { description: 'Apparent wind direction, degrees relative to the bow.' }),
  field('solar_irradiance', 'Solar irradiance', 'Quantity', 'W/m2'),
  field('water_temperature', 'Water temp', 'Quantity', 'Cel'),
  field('precipitation_type', 'Precipitation', 'Category', null, {
    default_on: false, tokens: ['none', 'drizzle', 'rain', 'showers'], extra: true,
    description: 'Measured by both sensors; published only when switched on.',
  }),
];
export const QUANTITIES = RAW.filter((f) => f.swe_type === 'Quantity').map((f) => f.name);

export const MODEL_OUTPUTS: Field[] = [
  field('dew_point', 'Dew point', 'Quantity', 'Cel', { kind: 'model', inputs: ['air_temperature', 'relative_humidity'], essential: true,
    description: 'From bow air temperature and humidity (Model A).' }),
  field('bow_minus_stern', 'Bow − stern', 'Quantity', 'Cel', { kind: 'model', inputs: ['air_temperature'], essential: true,
    description: 'Bow minus stern air temperature (Model A). Unaligned: no lag correction is possible without speed.' }),
  field('pressure_tendency_3h', 'Pressure tendency', 'Quantity', 'hPa', { kind: 'model', inputs: ['pressure'], default_on: false, extra: true,
    description: 'Change in bow pressure over three hours (Model A).' }),
  field('readings_removed', 'Readings removed', 'Count', null, { kind: 'model', default_on: false, extra: true,
    description: 'Readings Data cleanse removed in the interval (Model A).' }),
];
export const CATALOGUE = new Map<string, Field>([...RAW, ...MODEL_OUTPUTS].map((f) => [f.name, f]));

export class Offering {
  on: Record<string, boolean>;
  constructor(on?: Record<string, boolean>) {
    this.on = on ?? Object.fromEntries([...CATALOGUE.values()].map((f) => [f.name, f.default_on]));
  }

  copy(): Offering {
    return new Offering({ ...this.on });
  }

  raw(): Field[] {
    return RAW.filter((f) => this.on[f.name]);
  }

  /** True for a field this offering publishes, and for any field the catalogue does not know. */
  published(name: string): boolean {
    const f = CATALOGUE.get(name);
    if (!f) return true;
    if (!this.on[name]) return false;
    return f.inputs.every((i) => this.published(i));
  }

  /** Whether a field of any datastream is served (QC flags follow their measurement). */
  keep(fieldName: string): boolean {
    return this.published(fieldName.endsWith('_qc') ? fieldName.slice(0, -3) : fieldName);
  }
}

const idCache = new Map<string, string>();

/** A datastream's identifier changes whenever its schema does (FR-51; fields.schema_id). */
export function schemaId(base: string, names: string[]): string {
  const key = names.join(',');
  let h = idCache.get(key);
  if (h === undefined) {
    h = sha1Hex(key).slice(0, 6);
    idCache.set(key, h);
  }
  return `${base}-${h}`;
}
