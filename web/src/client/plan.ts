// The period (FR-54): a number and a unit, ending at the replay time, or the whole dataset. The resolution read
// follows the window's length: readings up to an hour, 1-minute summaries up to a day, hourly summaries beyond, and
// for the whole dataset unless a narrower range is picked on its twin-handle timeline.
import { RES_SECONDS, Resolution } from './fields';

export type PeriodUnit = 's' | 'min' | 'h' | 'd' | 'all';

/** `n` is kept while the unit is the whole dataset, so choosing a unit again gives the number back. */
export interface Period {
  n: number;
  unit: PeriodUnit;
}

export const UNITS: { id: PeriodUnit; label: string; seconds: number | null }[] = [
  { id: 's', label: 'seconds', seconds: 1 },
  { id: 'min', label: 'minutes', seconds: 60 },
  { id: 'h', label: 'hours', seconds: 3600 },
  { id: 'd', label: 'days', seconds: 86400 },
  { id: 'all', label: 'Whole dataset', seconds: null },
];

export const DEFAULT_PERIOD: Period = { n: 1, unit: 'h' };

/** The period's length in seconds; null for the whole dataset. */
export function periodSeconds(p: Period): number | null {
  const u = UNITS.find((x) => x.id === p.unit)?.seconds;
  return u == null ? null : Math.max(1, Math.round(p.n)) * u;
}

/** The resolution a window of this many seconds reads; null (the whole dataset) reads hourly summaries. */
export function resFor(seconds: number | null): Resolution {
  if (seconds === null) return 'PT1H';
  return seconds <= 3600 ? 'PT1S' : seconds <= 86400 ? 'PT1M' : 'PT1H';
}

export const periodLabel = (p: Period) => {
  const s = periodSeconds(p);
  if (s === null) return 'Whole dataset';
  return `${Math.round(p.n)} ${p.unit}`;
};

/** The window a period covers, in Unix seconds: [from, to], never before the dataset's start. */
export function windowOf(p: Period, replayTime: number, start: number): [number, number] {
  const s = periodSeconds(p);
  return [s === null ? start : Math.max(start, replayTime - s), replayTime];
}

/**
 * The period that gives a saved window back (FR-106): its length, in the largest unit that divides it; the whole
 * dataset when the window covers all of it. A window clipped at the dataset's start is given back by its length too.
 */
export function periodFor(from: number, to: number, datasetStart: number, datasetEnd: number): Period {
  if (from <= datasetStart && to >= datasetEnd) return { n: 1, unit: 'all' };
  const span = Math.max(1, Math.round(to - from));
  const u = [...UNITS].reverse().find((x) => x.seconds !== null && span % x.seconds === 0)!;
  return { n: span / u.seconds!, unit: u.id };
}

/**
 * The latest phenomenon time a datastream at a resolution may be read up to (FR-63b): a reading at the replay time,
 * a summary only once its interval has ended, so nothing after the replay time is shown.
 */
export function readableUntil(replayTime: number, res: Resolution): number {
  const s = RES_SECONDS[res] ?? 1;
  return Math.floor(replayTime) - (s === 1 ? 0 : s);
}

export const iso = (t: number) => new Date(Math.round(t) * 1000).toISOString().replace('.000Z', 'Z');
export const parseIso = (s: string) => Date.parse(s) / 1000;

/** The resolution the error-bar view reads: summaries, never readings (FR-29, FR-58). */
export const statsRes = (res: Resolution): Resolution => (res === 'PT1H' ? 'PT1H' : 'PT1M');
