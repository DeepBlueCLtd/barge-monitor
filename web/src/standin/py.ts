// Small helpers that reproduce what the Python reference does with numbers,
// text and URLs, so the stand-in's answers and captured messages match it
// (FR-06c, PR-06). Nothing here knows about the demonstrator.

/** numpy.rint / Python round(): round half to even. */
export function rint(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** numpy.round(x, nd): scale, round half to even, unscale. */
export function npRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const s = 10 ** nd;
  return rint(x * s) / s;
}

/** numpy.searchsorted over the first n entries of a sorted array. */
export function searchsorted(a: ArrayLike<number>, v: number, side: 'left' | 'right', n = a.length, lo0 = 0): number {
  let lo = lo0;
  let hi = n;
  if (side === 'left') {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid] < v) lo = mid + 1;
      else hi = mid;
    }
  } else {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
  }
  return lo;
}

/** Python slice bounds [a:b] over a sequence of length n (negative indices count from the end). */
export function pySlice(n: number, a: number | null, b: number | null): [number, number] {
  const norm = (i: number | null, dflt: number) => {
    if (i === null) return dflt;
    if (i < 0) return Math.max(0, n + i);
    return Math.min(n, i);
  };
  const s = norm(a, 0);
  const e = norm(b, n);
  return [s, Math.max(s, e)];
}

/** A float as Python's repr shows it (1.0, not 1). */
export function pyFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const s = String(x);
  return s.includes('e') ? s.replace(/e([+-])(\d)$/, 'e$10$2') : s;
}

/** A Python float object: serialised with a decimal point, as json.dumps would. */
export class PyFloat {
  constructor(readonly v: number) {}
}

function pyStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c > 0x7e) {
      // ensure_ascii: everything outside printable ASCII as \uXXXX (surrogate pairs above the BMP)
      const units = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
      out += units.map((u) => '\\u' + u.toString(16).padStart(4, '0')).join('');
    } else out += ch;
  }
  return out + '"';
}

/**
 * Python's json.dumps(value, default=str) with its default separators and
 * ensure_ascii: the text of a captured message (tap.py `_clip`).
 */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof PyFloat) return pyFloat(v.v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : pyFloat(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return pyStr(v);
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return pyJson(Array.from(v as unknown as ArrayLike<number>));
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (typeof v === 'object') {
    return '{' + Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${pyStr(k)}: ${pyJson(x)}`).join(', ') + '}';
  }
  return pyStr(String(v));
}

/**
 * Compact JSON as the Python back end writes its bodies: Starlette's
 * JSONResponse (ensureAscii false) or json.dumps with separators (",", ":")
 * (ensureAscii true). A PyFloat is written as Python writes a float (11.0).
 */
export function dumps(v: unknown, ensureAscii = false): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof PyFloat) {
    if (!Number.isFinite(v.v)) return 'null';
    return pyFloat(v.v);
  }
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? String(v) : 'null';
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return ensureAscii ? pyStr(v) : JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => dumps(x, ensureAscii)).join(',') + ']';
      if (ArrayBuffer.isView(v)) return dumps(Array.from(v as unknown as ArrayLike<number>), ensureAscii);
      const parts: string[] = [];
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x !== undefined) parts.push((ensureAscii ? pyStr(k) : JSON.stringify(k)) + ':' + dumps(x, ensureAscii));
      }
      return '{' + parts.join(',') + '}';
    }
    default: return JSON.stringify(String(v));
  }
}

/** Python repr() of a string or a list of strings, as refusal messages show them. */
export function pyRepr(v: unknown): string {
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q) + q;
  }
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v === null || v === undefined) return 'None';
  return String(v);
}

/** A number as Python's str() shows an int or a float that came from JSON. */
export function pyNum(v: number, isFloat: boolean): string {
  return isFloat ? pyFloat(v) : String(v);
}

const SAFE = /[A-Za-z0-9_.\-~]/;

/** urllib.parse.quote_plus. */
export function quotePlus(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(b);
    if (b < 128 && SAFE.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** urllib.parse.urlencode over ordered pairs. */
export function urlencode(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
}

function unquotePlus(s: string): string {
  const t = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(t);
  } catch {
    // Python's unquote(errors='replace') keeps what it cannot decode
    return t.replace(/%([0-9A-Fa-f]{2})/g, (m, h) => {
      const c = parseInt(h, 16);
      return c < 128 ? String.fromCharCode(c) : '�';
    });
  }
}

/** urllib.parse.parse_qsl(query, keep_blank_values=True), as Starlette parses a query string. */
export function parseQs(query: string): [string, string][] {
  const out: [string, string][] = [];
  for (const piece of query.split('&')) {
    if (!piece) continue;
    const i = piece.indexOf('=');
    const k = i < 0 ? piece : piece.slice(0, i);
    const v = i < 0 ? '' : piece.slice(i + 1);
    if (!k && !v) continue;
    out.push([unquotePlus(k), unquotePlus(v)]);
  }
  return out;
}

/** dict(query_params): first position of each key, last value. */
export function qsDict(pairs: [string, string][]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of pairs) m.set(k, v);
  return m;
}
