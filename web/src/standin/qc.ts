// QARTOD quality flags, computed on import (FR-32; qc.py): never by altering the files.
// The range and spike checks of Version 4.1, with CO₂ (250–5000 ppm, 60 ppm spike; D-144).
// Flags: 1 pass, 2 not evaluated (a variable wind direction), 3 suspect (spike), 4 fail (out
// of range), 9 missing.

export const QC_RANGE: Record<string, [number, number]> = {
  air_temperature: [-30, 50], relative_humidity: [0, 100], pressure: [900, 1100], apparent_wind_speed: [0, 60],
  apparent_wind_direction: [0, 360], solar_irradiance: [0, 1500], water_temperature: [-2, 35], co2: [250, 5000],
};
/** A reading further than this from the mean of its two neighbours is suspect (QARTOD spike test). */
export const QC_SPIKE: Record<string, number> = {
  air_temperature: 0.8, relative_humidity: 6.0, pressure: 0.5, apparent_wind_speed: 3.5, solar_irradiance: 150.0,
  water_temperature: 0.4, co2: 60.0,
};
const TOKENS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** QARTOD flags as Category tokens ("1", "3", …) for one column of readings (qc.flags). */
export function qcFlags(name: string, v: ArrayLike<number>, variable: ArrayLike<number> | null = null): string[] {
  const n = v.length;
  const flag = new Uint8Array(n).fill(1);
  const [lo, hi] = QC_RANGE[name];
  for (let i = 0; i < n; i++) if (v[i] < lo || v[i] > hi) flag[i] = 4;
  const sp = QC_SPIKE[name];
  if (sp !== undefined && n >= 3) {
    for (let i = 1; i < n - 1; i++) {
      if (flag[i] === 1 && Math.abs(v[i] - 0.5 * (v[i - 1] + v[i + 1])) > sp) flag[i] = 3;
    }
  }
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const vr = variable !== null && !!variable[i];
    out[i] = TOKENS[vr ? 2 : Number.isNaN(v[i]) ? 9 : flag[i]];
  }
  return out;
}
