// Live data: poll the EDR server at 1 Hz for records newer than the last one
// held (FR-35), for both sensors, and keep a window of them for the display.
import { useEffect, useRef, useState } from 'react';
import { api, Coverage, positions, times } from './api';
import { POLL_MS } from './config';

export const PARAMS = [
  'air_temperature',
  'relative_humidity',
  'pressure',
  'apparent_wind_speed',
  'apparent_wind_direction',
  'solar_irradiance',
  'water_temperature',
] as const;

export interface Buffer {
  t: number[];
  lon: number[];
  lat: number[];
  pq: number[];
  v: Record<string, (number | null)[]>;
  qc: Record<string, number[]>;
}

const empty = (): Buffer => ({ t: [], lon: [], lat: [], pq: [], v: {}, qc: {} });

function append(buf: Buffer, cov: Coverage, keepFrom: number): Buffer {
  const t = times(cov);
  const pos = positions(cov);
  const out: Buffer = {
    t: buf.t.concat(t),
    lon: buf.lon.concat(pos.map((p) => p[0])),
    lat: buf.lat.concat(pos.map((p) => p[1])),
    pq: buf.pq.concat((cov.ranges.position_qc?.values ?? []) as number[]),
    v: {},
    qc: {},
  };
  for (const p of PARAMS) {
    out.v[p] = (buf.v[p] ?? []).concat((cov.ranges[p]?.values ?? []) as (number | null)[]);
    out.qc[p] = (buf.qc[p] ?? []).concat((cov.ranges[`${p}_qc`]?.values ?? []) as number[]);
  }
  let i = 0;
  while (i < out.t.length && out.t[i] < keepFrom) i++;
  if (i > 0) {
    out.t = out.t.slice(i);
    out.lon = out.lon.slice(i);
    out.lat = out.lat.slice(i);
    out.pq = out.pq.slice(i);
    for (const p of PARAMS) {
      out.v[p] = out.v[p].slice(i);
      out.qc[p] = out.qc[p].slice(i);
    }
  }
  return out;
}

export function iso(unix: number): string {
  return new Date(Math.round(unix) * 1000).toISOString().replace('.000Z', 'Z');
}

export function useLive(ready: boolean, route: string | null, windowHours: number, nowUnix: number | null) {
  const [data, setData] = useState<{ bow: Buffer; stern: Buffer }>({ bow: empty(), stern: empty() });
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const ref = useRef(data);
  ref.current = data;
  const win = useRef(windowHours);

  useEffect(() => {
    if (win.current !== windowHours) {
      win.current = windowHours;
      setData({ bow: empty(), stern: empty() });
      ref.current = { bow: empty(), stern: empty() };
    }
  }, [windowHours]);

  useEffect(() => {
    if (!ready || !route || nowUnix == null) return;
    let alive = true;
    const tick = async () => {
      if (busy.current || !alive) return;
      busy.current = true;
      try {
        const cur = ref.current;
        const next = { ...cur };
        for (const s of ['bow', 'stern'] as const) {
          const buf = cur[s];
          const last = buf.t.length ? buf.t[buf.t.length - 1] : null;
          const from = last != null ? last + 1 : (nowUnixRef.current ?? 0) - win.current * 3600;
          const cov = await api.get<Coverage>(`collections/${s}/trajectory`, { coords: route, datetime: `${iso(from)}/..` });
          const latest = Math.max(last ?? 0, ...times(cov).slice(-1));
          next[s] = append(buf, cov, latest - win.current * 3600);
        }
        if (alive) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        busy.current = false;
      }
    };
    const nowUnixRef = { current: nowUnix };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
    // nowUnix is only needed for the first request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, route, windowHours, nowUnix == null]);

  return { ...data, error };
}
