// The canal map (FR-32): reaches, locks, bridges and the tunnel; the track so
// far coloured by a parameter or by cluster; the boat and its heading; a
// marker that follows the charts' shared cursor; detected changes.
import { useMemo } from 'react';
import type { Canal } from '../api';
import type { Buffer } from '../live';

export const KIND_COLOURS: Record<string, string> = {
  open: '#7aa974',
  cutting: '#b08b57',
  tunnel: '#4b4b55',
  woodland: '#2f7d4a',
  aqueduct: '#4f8fc0',
  town: '#c0605a',
};

export const CATEGORY_COLOURS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#9c755f'];

export function ramp(x: number): string {
  // A perceptually ordered ramp from blue to yellow.
  const stops = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ];
  const v = Math.min(1, Math.max(0, x)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(v));
  const f = v - i;
  const c = stops[i].map((a, k) => Math.round(a + f * (stops[i + 1][k] - a)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

interface Props {
  canal: Canal;
  bow: Buffer;
  stern: Buffer;
  colourBy: string;
  cursorT: number | null;
  clusters?: { t: number[]; c: number[] } | null;
  changes?: { t: number; lon: number; lat: number; cause: string }[];
}

export function CanalMap({ canal, bow, stern, colourBy, cursorT, clusters, changes }: Props) {
  const W = 520;
  const H = 520;
  const proj = useMemo(() => {
    const { lon, lat } = canal.centreline;
    const k = Math.cos((canal.origin?.lat ?? 0) * (Math.PI / 180));
    const xs = lon.map((x) => x * k);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...lat), maxY = Math.max(...lat);
    const s = Math.min((W - 60) / (maxX - minX), (H - 60) / (maxY - minY));
    const ox = (W - s * (maxX - minX)) / 2, oy = (H - s * (maxY - minY)) / 2;
    return (lo: number, la: number): [number, number] => [ox + (lo * k - minX) * s, H - (oy + (la - minY) * s)];
  }, [canal]);

  const at = (ch: number): [number, number] => {
    const c = canal.centreline;
    let i = 0;
    while (i < c.chainage.length - 2 && c.chainage[i + 1] < ch) i++;
    const f = (ch - c.chainage[i]) / (c.chainage[i + 1] - c.chainage[i]);
    return proj(c.lon[i] + f * (c.lon[i + 1] - c.lon[i]), c.lat[i] + f * (c.lat[i + 1] - c.lat[i]));
  };

  const reachPaths = canal.reaches.map((r) => {
    const pts: [number, number][] = [at(r.start)];
    canal.centreline.chainage.forEach((ch) => ch > r.start && ch < r.end && pts.push(at(ch)));
    pts.push(at(r.end));
    return { r, d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') };
  });

  const track = useMemo(() => {
    const n = bow.t.length;
    if (!n) return [];
    const step = Math.max(1, Math.floor(n / 1500));
    const vals = (bow.v[colourBy] ?? []) as (number | null)[];
    let lo = Infinity, hi = -Infinity;
    if (colourBy !== 'cluster') vals.forEach((v) => v != null && (lo = Math.min(lo, v), hi = Math.max(hi, v)));
    const out: { x: number; y: number; c: string }[] = [];
    let ci = 0;
    for (let i = 0; i < n; i += step) {
      const [x, y] = proj(bow.lon[i], bow.lat[i]);
      let c = '#888';
      if (colourBy === 'cluster') {
        if (clusters && clusters.t.length) {
          while (ci < clusters.t.length - 1 && clusters.t[ci + 1] <= bow.t[i]) ci++;
          if (Math.abs(clusters.t[ci] - bow.t[i]) < 120) c = CATEGORY_COLOURS[clusters.c[ci] % CATEGORY_COLOURS.length];
          else continue;
        } else continue;
      } else if (vals[i] != null && hi > lo) {
        c = ramp(((vals[i] as number) - lo) / (hi - lo));
      }
      out.push({ x, y, c });
    }
    return out;
  }, [bow, colourBy, clusters, proj]);

  const n = bow.t.length;
  const boat = n && stern.t.length ? { b: proj(bow.lon[n - 1], bow.lat[n - 1]), s: proj(stern.lon[stern.t.length - 1], stern.lat[stern.t.length - 1]) } : null;
  let cursor: [number, number] | null = null;
  if (cursorT != null && n) {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (bow.t[m] < cursorT) lo = m + 1;
      else hi = m;
    }
    cursor = proj(bow.lon[lo], bow.lat[lo]);
  }

  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the fictional canal">
      {reachPaths.map(({ r, d }) => (
        <g key={r.id}>
          <path d={d} stroke={KIND_COLOURS[r.kind] ?? '#999'} strokeWidth={r.kind === 'tunnel' ? 9 : 7} fill="none"
                strokeDasharray={r.kind === 'tunnel' ? '6 3' : undefined} strokeLinecap="round" opacity={0.55}>
            <title>{`${r.name} (${r.kind}), ${r.start}–${r.end} m`}</title>
          </path>
        </g>
      ))}
      {track.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={2} fill={p.c} />)}
      {canal.locks.map((l) => {
        const [x, y] = at(l.chainage);
        return <rect key={l.id} x={x - 4} y={y - 4} width={8} height={8} fill="var(--fg)"><title>{l.id}</title></rect>;
      })}
      {(canal.bridges ?? []).map((b) => {
        const [x, y] = at(b);
        return <circle key={b} cx={x} cy={y} r={3} fill="none" stroke="var(--fg)"><title>bridge</title></circle>;
      })}
      {(canal.wharves ?? []).map((w) => {
        const [x, y] = at(w.chainage ?? 0);
        const left = x > W * 0.7;
        return <text key={w.id} x={left ? x - 10 : x + 10} y={y + 4} textAnchor={left ? 'end' : 'start'} className="map-label">{w.name}</text>;
      })}
      {canal.reaches.filter((r) => r.kind !== 'open').map((r) => {
        const [x, y] = at((r.start + r.end) / 2);
        return <text key={r.id} x={x + 9} y={y - 6} className="map-label small">{r.name}</text>;
      })}
      {(changes ?? []).map((c, i) => {
        const [x, y] = proj(c.lon, c.lat);
        return <path key={i} d={`M${x},${y - 7}L${x + 5},${y + 3}L${x - 5},${y + 3}Z`} fill={c.cause === 'place' ? '#e15759' : '#4e79a7'} opacity={0.8}><title>{c.cause} change</title></path>;
      })}
      {boat && (
        <g>
          <path
            d="M0,-11 L7,8 L0,4 L-7,8 Z"
            transform={`translate(${boat.b[0]},${boat.b[1]}) rotate(${(Math.atan2(boat.b[0] - boat.s[0], -(boat.b[1] - boat.s[1])) * 180) / Math.PI})`}
            fill="var(--accent)" stroke="var(--bg)" strokeWidth={1.5}
          ><title>the barge: position and heading</title></path>
        </g>
      )}
      {cursor && <circle cx={cursor[0]} cy={cursor[1]} r={8} fill="none" stroke="var(--fg)" strokeWidth={2} />}
    </svg>
  );
}
