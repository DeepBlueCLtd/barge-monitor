// Period presets (FR-54), each ending at the replay time, and the resolution each
// reads: readings up to an hour, 1-minute summaries for 6 hours and a day, hourly
// summaries for the whole dataset.
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
export const statsRes = (id: PeriodId): Resolution => (periodOf(id).res === 'PT1H' ? 'PT1H' : 'PT1M');
