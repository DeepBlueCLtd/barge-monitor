// Is a unit code UCUM? (D-195; the twin of backend/barge/ucum.py.) OpenSensorHub checks every
// `uom.code` in a datastream's or control stream's schema against UCUM, strictly, and refuses the
// resource otherwise (400 "Invalid UCUM code 'ppm'"). The stand-ins refuse the same codes, so that a
// client's slip shows in the browser too. UCUM's grammar (products, quotients, exponents, factors,
// parentheses, annotations) over the atoms a weather or process model plausibly uses; an atom outside
// that table is refused, as an unknown atom is by OpenSensorHub.

const PREFIXES = ['da', 'Ki', 'Mi', 'Gi', 'Ti', 'Y', 'Z', 'E', 'P', 'T', 'G', 'M', 'k', 'h', 'd', 'c', 'm', 'u', 'n', 'p',
  'f', 'a', 'z', 'y'];
/** Atoms that take a metric prefix. */
const METRIC = new Set([
  'm', 's', 'g', 'rad', 'K', 'cd', 'C', 'mol', 'sr', 'Hz', 'N', 'Pa', 'J', 'W', 'A', 'V', 'F', 'Ohm', 'S', 'Wb',
  'Cel', 'T', 'H', 'lm', 'lx', 'Bq', 'Gy', 'Sv', 'l', 'L', 'ar', 't', 'bar', 'u', 'eV', 'pc', 'gf', 'Ky', 'Gal',
  'dyn', 'erg', 'P', 'St', 'Mx', 'G', 'Oe', 'Gb', 'sb', 'Lmb', 'ph', 'Ci', 'R', 'RAD', 'REM', 'cal', 'bit', 'By',
  'Bd', 'mho', 'osm', 'eq', 'B', 'Np', 'm[Hg]', 'm[H2O]', 'B[SPL]', 'B[V]', 'B[mV]', 'B[uV]', 'B[W]', 'B[kW]',
  '[iU]', '[IU]', 'Ao', 'b', 'mo_s',
]);
/** Atoms that do not. */
const PLAIN = new Set([
  '10*', '10^', '[pi]', '%', '[ppth]', '[ppm]', '[ppb]', '[pptr]', 'min', 'h', 'd', 'a', 'wk', 'mo', 'a_t', 'a_j',
  'a_g', 'mo_j', 'mo_g', 'deg', 'gon', "'", "''", '[degF]', '[degR]', '[degRe]', 'atm', '[psi]', '[in_i]',
  '[ft_i]', '[yd_i]', '[mi_i]', '[nmi_i]', '[kn_i]', '[lb_av]', '[oz_av]', '[gal_us]', '[gal_br]', '[mi_us]',
  '[ft_us]', "[in_i'Hg]", "[in_i'H2O]", '[Btu]', '[HP]', '[pH]', '[S]', "[hp'_X]", '[beaufort]', 'Np', 'B',
  "[knk'U]", '[acr_us]', '[sft_i]', '[sin_i]', '[cft_i]', '[cin_i]', '[cyd_i]', '[mil_i]', '[ly]', '[c]', '[h]',
  '[k]', '[e]', '[G]', '[g]', '[m_e]', '[m_p]', '[eps_0]', '[mu_0]', 'AU', 'tex', '[den]', '[car_m]', '[car_Au]',
]);

function simple(s: string): boolean {
  if (PLAIN.has(s) || METRIC.has(s)) return true;
  return PREFIXES.some((p) => s.startsWith(p) && METRIC.has(s.slice(p.length)));
}

function component(s: string): boolean {
  if (s.endsWith('}')) s = s.replace(/\{[^{}]*\}$/, '');
  if (s === '') return true; // an annotation alone
  if (/^\d+$/.test(s)) return true; // a factor
  if (simple(s)) return true;
  const m = /^(.*?)([+-]?\d+)$/.exec(s);
  return !!m && !!m[1] && simple(m[1]);
}

function term(s: string): boolean {
  if (s.startsWith('/')) s = s.slice(1);
  const parts: string[] = [];
  let depth = 0;
  let brace = false;
  let cur = '';
  for (const ch of s) {
    if (brace) {
      brace = ch !== '}';
      cur += ch;
      continue;
    }
    if (ch === '{') brace = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
    if (depth === 0 && (ch === '.' || ch === '/')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (depth || brace) return false;
  parts.push(cur);
  return parts.every((p) => (p.startsWith('(') && p.endsWith(')') ? term(p.slice(1, -1))
    : !!p && !p.includes('(') && !p.includes(')') && component(p)));
}

export function isUcum(code: unknown): boolean {
  return typeof code === 'string' && code !== '' && !/\s/.test(code) && term(code);
}

/** Every `uom.code` in a schema (any depth) that is not UCUM. */
export function badCodes(x: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const u = (v as any).uom;
      if (u && typeof u === 'object' && 'code' in u && !isUcum(u.code)) out.push(String(u.code));
      Object.values(v).forEach(walk);
    }
  };
  walk(x);
  return out;
}
