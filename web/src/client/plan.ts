// Period presets (FR-54), each ending at the replay time, and the resolution each reads: readings up to an hour,
// 1-minute summaries for 6 hours and a day, hourly summaries for the whole dataset (or, for a range picked on its
// twin-handle timeline, by the range's length). A favourite's period is set more finely: a number and a unit.
import { RES_SECONDS, Resolution } from './fields';

export type PeriodId = '1m' | '1h' | '6h' | '1d' | 'all';

export interface Period {
  id: PeriodId;
  label: string;
  /** Seconds before the replay time; null for the whole dataset. */
  seconds: number | null;
  res: Resolution;
}

export const PERIODS: Period[] = [
  { id: '1m', label: '1 min', seconds: 60, res: 'PT1S' },
  { id: '1h', label: '1 h', seconds: 3600, res: 'PT1S' },
  { id: '6h', label: '6 h', seconds: 6 * 3600, res: 'PT1M' },
  { id: '1d', label: 'A day', seconds: 86400, res: 'PT1M' },
  { id: 'all', label: 'Whole dataset', seconds: null, res: 'PT1H' },
];

export const periodOf = (id: PeriodId): Period => PERIODS.find((p) => p.id === id) ?? PERIODS[1];

/** The window a period covers, in Unix seconds: [from, to], never before the dataset's start. */
export function windowOf(id: PeriodId, replayTime: number, start: number): [number, number] {
  const p = periodOf(id);
  return [p.seconds === null ? start : Math.max(start, replayTime - p.seconds), replayTime];
}

/** The resolution a range of this many seconds reads, as the presets do. */
export const resFor = (seconds: number): Resolution => (seconds <= 3600 ? 'PT1S' : seconds <= 86400 ? 'PT1M' : 'PT1H');

/**
 * What gives a saved window back (FR-106): the preset of its length, or, for a window clipped at the dataset's start,
 * the shortest that covers it; otherwise the whole dataset, narrowed to the window on its twin-handle timeline.
 */
export function periodFor(from: number, to: number, datasetStart: number, datasetEnd: number): { period: PeriodId; range: [number, number] | null } {
  const span = to - from;
  const exact = PERIODS.find((p) => p.seconds === span);
  if (exact) return { period: exact.id, range: null };
  if (from <= datasetStart) {
    if (to >= datasetEnd) return { period: 'all', range: null };
    const cover = PERIODS.find((p) => p.seconds !== null && p.seconds >= span);
    if (cover) return { period: cover.id, range: null };
  }
  return { period: 'all', range: [Math.max(from, datasetStart), Math.min(to, datasetEnd)] };
}

// --- a favourite's period: a number and a unit (FR-104) --------------------------------------------------------
export type SpanUnit = 's' | 'min' | 'h' | 'd' | 'all';

export interface Span {
  n: number;
  unit: SpanUnit;
}

export const UNITS: { id: SpanUnit; label: string; seconds: number | null }[] = [
  { id: 's', label: 'seconds', seconds: 1 },
  { id: 'min', label: 'minutes', seconds: 60 },
  { id: 'h', label: 'hours', seconds: 3600 },
  { id: 'd', label: 'days', seconds: 86400 },
  { id: 'all', label: 'Whole dataset', seconds: null },
];

/** A span's length in seconds; null for the whole dataset. */
export function spanSeconds(p: Span): number | null {
  const u = UNITS.find((x) => x.id === p.unit)?.seconds;
  return u == null ? null : Math.max(1, Math.round(p.n)) * u;
}

/**
 * A length as a span, in the largest unit that divides it to within a second (a range's end is inclusive, so 11:59:59
 * reads as 12 hours); null gives the whole dataset.
 */
export function spanOf(seconds: number | null): Span {
  if (seconds === null) return { n: 1, unit: 'all' };
  const len = Math.max(1, Math.round(seconds));
  const near = (u: number) => Math.round(len / u) >= 1 && Math.abs(len - Math.round(len / u) * u) <= 1;
  const u = [...UNITS].reverse().find((x) => x.seconds !== null && near(x.seconds))!;
  return { n: Math.round(len / u.seconds!), unit: u.id };
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
