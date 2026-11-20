// Simulated time as ISO 8601 text, exactly as server.py writes and reads it
// (`iso`, `iso_many`, `parse_iso`). Simulated seconds since the simulation
// epoch; no host clock is read here (FR-13).
import { SIM_EPOCH_UNIX } from './constants';
import { rint } from './py';

/** server.iso: whole seconds, UTC, with Z. */
export function iso(t: number): string {
  const s = rint(SIM_EPOCH_UNIX + t);
  return new Date(s * 1000).toISOString().slice(0, 19) + 'Z';
}

const RE = /^([+-]?\d{4,6})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?)?)?)?(?:([+-])(\d{2}):?(\d{2})?)?$/;

/** server.parse_iso: UTC only; a parse failure throws with numpy's wording. */
export function parseIso(text: string): number {
  let s = text.trim();
  if (s.endsWith('Z')) s = s.slice(0, -1);
  if (s.slice(10).includes('+')) throw new Error('only UTC (Z) times are supported');
  const m = RE.exec(s);
  if (!m) throw new Error(`Error parsing datetime string "${s}" at position 0`);
  const [, y, mo, d, h, mi, se, frac, sign, oh, om] = m;
  const month = mo ? Number(mo) : 1;
  const day = d ? Number(d) : 1;
  const hour = h ? Number(h) : 0;
  const minute = mi ? Number(mi) : 0;
  const sec = se ? Number(se) : 0;
  if (month < 1 || month > 12) throw new Error(`Month out of range in datetime string "${s}"`);
  const dim = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  if (day < 1 || day > dim) throw new Error(`Day out of range in datetime string "${s}"`);
  if (hour > 23) throw new Error(`Hours out of range in datetime string "${s}"`);
  if (minute > 59) throw new Error(`Minutes out of range in datetime string "${s}"`);
  if (sec > 59) throw new Error(`Seconds out of range in datetime string "${s}"`);
  const date = new Date(0);
  date.setUTCFullYear(Number(y), month - 1, day);
  date.setUTCHours(hour, minute, sec, 0);
  let ms = date.getTime() + (frac ? Math.floor(Number(('0.' + frac).slice(0, 5)) * 1000 + 1e-9) : 0);
  if (sign) ms -= (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om ?? 0)) * 60000;
  return ms / 1000 - SIM_EPOCH_UNIX;
}
