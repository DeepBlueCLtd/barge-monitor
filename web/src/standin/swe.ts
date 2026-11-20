// SWE Common Data Model 3.0, JSON encoding: the record schemas the server
// serves (FR-25; swe.py), and the helpers models use to declare theirs
// (csmodel.py). Key order follows the Python reference so the JSON reads the same.
import { DEF } from './constants';
import { Field, QARTOD_FLAGS } from './fields';

export const SAMPLING_TIME = 'http://www.opengis.net/def/property/OGC/0/SamplingTime';
export const UTC = 'http://www.opengis.net/def/trs/BIPM/0/UTC';
export const ISO8601 = 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian';
export const QARTOD = 'https://ioos.github.io/qartod/';
export const SWE_JSON = 'application/swe+json';
export const JSON_TYPE = 'application/json';
export const OBS_FORMATS = [SWE_JSON, JSON_TYPE];

/** A SWE Common component, as JSON. */
export type Component = Record<string, any> & { type: string; name: string };
export interface DataRecord {
  type: 'DataRecord';
  name?: string;
  label: string;
  fields: Component[];
}

export function timeField(name = 'time', label = 'Sampling time'): Component {
  return { type: 'Time', name, label, definition: SAMPLING_TIME, referenceFrame: UTC, uom: { href: ISO8601 } };
}

export function component(f: Field, quality = false): Component {
  const c: Component = { type: f.swe_type, name: f.name, label: f.label, definition: f.definition };
  if (f.description) c.description = f.description;
  if (f.swe_type === 'Quantity') {
    c.uom = { code: f.uom };
    if (quality) c.quality = [{ href: `#${f.name}_qc` }];
  } else if (f.swe_type === 'Category') {
    c.codeSpace = DEF + f.name;
    c.constraint = { type: 'AllowedTokens', values: [...f.tokens] };
  } else if (f.swe_type === 'Count' && f.uom) {
    c.uom = { code: f.uom };
  }
  return c;
}

export function qcField(f: Field): Component {
  return {
    type: 'Category', name: `${f.name}_qc`, id: `${f.name}_qc`, label: `QC flag: ${f.label}`, definition: QARTOD + 'flag',
    codeSpace: QARTOD, constraint: { type: 'AllowedTokens', values: [...QARTOD_FLAGS] },
    description: 'QARTOD: 1 pass, 2 not evaluated, 3 suspect, 4 fail, 9 missing',
  };
}

export function record(fields: Component[], label: string, name = 'record'): DataRecord {
  return { type: 'DataRecord', name, label, fields };
}

/** The body of GET /datastreams/{id}/schema?obsFormat=… */
export function schemaResponse(rec: DataRecord, obsFormat: string): Record<string, unknown> {
  if (obsFormat === SWE_JSON) return { obsFormat: SWE_JSON, recordSchema: rec, encoding: { type: 'JSONEncoding' } };
  return { obsFormat: JSON_TYPE, resultSchema: { ...rec, fields: rec.fields.filter((f) => f.type !== 'Time' || f.name !== 'time') } };
}

// --- helpers for model schemas (csmodel.py) --------------------------------------------------

export const M = {
  time(name = 'time', label = 'Time'): Component {
    return { type: 'Time', name, label, definition: SAMPLING_TIME, uom: { href: ISO8601 } };
  },
  quantity(name: string, label: string, uom: string, lo?: number, hi?: number): Component {
    const q: Component = { type: 'Quantity', name, label, definition: DEF + name, uom: { code: uom } };
    if (lo !== undefined) q.constraint = { type: 'AllowedValues', intervals: [[lo, hi]] };
    return q;
  },
  count(name: string, label: string, lo?: number, hi?: number): Component {
    const c: Component = { type: 'Count', name, label, definition: DEF + name };
    if (lo !== undefined) c.constraint = { type: 'AllowedValues', intervals: [[lo, hi]] };
    return c;
  },
  category(name: string, label: string, tokens: string[]): Component {
    return { type: 'Category', name, label, definition: DEF + name, codeSpace: DEF + name, constraint: { type: 'AllowedTokens', values: [...tokens] } };
  },
  text(name: string, label: string, tokens?: string[]): Component {
    const t: Component = { type: 'Text', name, label, definition: DEF + name };
    if (tokens) t.constraint = { type: 'AllowedTokens', values: [...tokens] };
    return t;
  },
  boolean(name: string, label: string): Component {
    return { type: 'Boolean', name, label, definition: DEF + name };
  },
  record(label: string, fields: Component[]): DataRecord {
    return { type: 'DataRecord', label, fields };
  },
};
