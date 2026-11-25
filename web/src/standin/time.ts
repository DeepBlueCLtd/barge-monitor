// Time as ISO 8601 text. Version 4.6 has no simulation epoch: replay time is
// absolute UTC, as written in the CSV files (docs/v4-interfaces.md §4), so a
// time here is Unix seconds. No host clock is read here except by realNow().
import { rint } from './py';

/** Whole seconds, UTC, with Z. */
export function iso(t: number): string {
  const s = rint(t);
  // A day of records shares its date: the calendar is asked once a day, the clock time is arithmetic.
  const day = Math.floor(s / 86400);
  let date = DATE_OF_DAY.get(day);
  if (date === undefined) DATE_OF_DAY.set(day, (date = new Date(day * 86400000).toISOString().slice(0, 11)));
  const r = s - day * 86400;
  return date + TWO[Math.floor(r / 3600)] + ':' + TWO[Math.floor(r / 60) % 60] + ':' + TWO[r % 60] + 'Z';
}

const TWO = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const DATE_OF_DAY = new Map<number, string>(); // day number -> "YYYY-MM-DDT"
const DAY_OF_DATE = new Map<string, number>(); // "YYYY-MM-DD" -> Unix seconds at its midnight
const dg = (text: string, i: number) => text.charCodeAt(i) - 48;

const RE = /^([+-]?\d{4,6})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?)?)?)?(?:([+-])(\d{2}):?(\d{2})?)?$/;

/** ISO 8601 to Unix seconds. Throws on anything it cannot read. */
export function parseIso(text: string): number {
  // The form this server writes, "YYYY-MM-DDTHH:MM:SSZ", is read without the general parser once its date is known.
  if (text.length === 20 && text.charCodeAt(19) === 90 && text.charCodeAt(10) === 84) {
    const base = DAY_OF_DATE.get(text.slice(0, 10));
    const h = dg(text, 11) * 10 + dg(text, 12);
    const m = dg(text, 14) * 10 + dg(text, 15);
    const sec = dg(text, 17) * 10 + dg(text, 18);
    if (base !== undefined && h >= 0 && h < 24 && m >= 0 && m < 60 && sec >= 0 && sec < 60
      && text.charCodeAt(13) === 58 && text.charCodeAt(16) === 58) return base + h * 3600 + m * 60 + sec;
    const v = parseIsoGeneral(text);
    if (h < 24 && m < 60 && sec < 60) DAY_OF_DATE.set(text.slice(0, 10), v - (h * 3600 + m * 60 + sec));
    return v;
  }
  return parseIsoGeneral(text);
}

function parseIsoGeneral(text: string): number {
  let s = text.trim();
  if (s.endsWith('Z')) s = s.slice(0, -1);
  const m = RE.exec(s);
  if (!m) throw new Error(`cannot read the time "${text}"`);
  const [, y, mo, d, h, mi, se, frac, sign, oh, om] = m;
  const month = mo ? Number(mo) : 1;
  const day = d ? Number(d) : 1;
  const hour = h ? Number(h) : 0;
  const minute = mi ? Number(mi) : 0;
  const sec = se ? Number(se) : 0;
  if (month < 1 || month > 12) throw new Error(`month out of range in "${text}"`);
  const dim = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  if (day < 1 || day > dim) throw new Error(`day out of range in "${text}"`);
  if (hour > 23 || minute > 59 || sec > 59) throw new Error(`time of day out of range in "${text}"`);
  const date = new Date(0);
  date.setUTCFullYear(Number(y), month - 1, day);
  date.setUTCHours(hour, minute, sec, 0);
  let ms = date.getTime() + (frac ? Math.floor(Number(('0.' + frac).slice(0, 5)) * 1000 + 1e-9) : 0);
  if (sign) ms -= (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om ?? 0)) * 60000;
  return ms / 1000;
}

/** The host's real time, in seconds (docs/v4-interfaces.md §3: a captured message's `t`). */
export function realNow(): number {
  return Date.now() / 1000;
}

/** Wait this many real seconds. */
export function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, s * 1000)));
}
