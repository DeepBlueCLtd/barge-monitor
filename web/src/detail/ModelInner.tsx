// Inside a model (Models panel): an illustrative picture of the work each core
// model does — a mini flowchart with tokens moving through its stages, and one
// of a scrolling bit stream (Data cleanse), a changing heat map (Model A) or
// points gathering into clusters (Model B). It is decoration for the frame,
// labelled illustrative: the real traffic is the message tokens above it
// (FR-66). It moves only while the simulation plays (FR-77) and is deterministic
// (no Math.random), drawn from a step counter.
import { useEffect, useState } from 'react';

const STAGES: Record<string, string[]> = {
  'data-cleanse': ['raw', 'flag', 'smooth', 'clean'],
  'model-a': ['1 s', '1 min', '1 h'],
  'model-b': ['fields', 'cluster', 'score'],
};

/** A counter that steps every `ms` while playing, and stands still while paused. */
function useSteps(ms: number, playing: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, playing]);
  return n;
}

/** Deterministic pseudo-noise in [0, 1) from two integers. */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 10000) / 10000;
}

export function ModelInner({ model, playing }: { model: string; playing: boolean }) {
  const stages = STAGES[model];
  if (!stages) return null;
  return (
    <div className="model-inner" aria-hidden="true" data-testid={`inner-${model}`}>
      <MiniFlow stages={stages} playing={playing} id={model} />
      {model === 'data-cleanse' && <BitStream playing={playing} />}
      {model === 'model-a' && <HeatMini playing={playing} />}
      {model === 'model-b' && <ClusterMini playing={playing} />}
      <span className="model-inner-note">inside the model · illustrative</span>
    </div>
  );
}

/** Stage boxes joined by a line; tokens travel through them while playing (SVG SMIL). */
function MiniFlow({ stages, playing, id }: { stages: string[]; playing: boolean; id: string }) {
  const W = 190, H = 26, bw = 38;
  const gap = (W - bw * stages.length) / (stages.length - 1);
  const x = (i: number) => i * (bw + gap);
  const path = `M${bw / 2} ${H / 2} H${x(stages.length - 1) + bw / 2}`;
  return (
    <svg className="mini-flow" width="100%" viewBox={`0 0 ${W} ${H}`}>
      <path d={path} stroke="#a16207" strokeWidth={1.4} fill="none" />
      {/* Tokens pass behind the stage boxes, so they show on the links and the labels stay readable. */}
      {playing && [0, 1, 2].map((k) => (
        <circle key={`${id}-${k}`} r={3.2} fill="#1d4ed8" stroke="#fff" strokeWidth={1}>
          <animateMotion path={path} dur="1.8s" begin={`${k * 0.6}s`} repeatCount="indefinite" />
        </circle>
      ))}
      {stages.map((s, i) => (
        <g key={s} transform={`translate(${x(i)} 3)`}>
          <rect width={bw} height={H - 6} rx={4} fill="#fff8e0" stroke="#a16207" strokeWidth={1.2} />
          <text x={bw / 2} y={14} textAnchor="middle" fontSize={9} fill="#6f4500" fontFamily="var(--sans)">{s}</text>
        </g>
      ))}
    </svg>
  );
}

/** A binary stream scrolling past: the raw records being read and rewritten. */
function BitStream({ playing }: { playing: boolean }) {
  const n = useSteps(120, playing);
  const LEN = 34;
  let bits = '';
  for (let i = 0; i < LEN; i++) bits += hash(n + i, 7) < 0.5 ? '0' : '1';
  return <div className="bit-stream">{bits}</div>;
}

/** A small heat map whose newest column arrives on the right and drifts left: averages being made. */
function HeatMini({ playing }: { playing: boolean }) {
  const n = useSteps(450, playing);
  const COLS = 16, ROWS = 4;
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const col = n + c;
      const v = 0.5 + 0.35 * Math.sin(col / 3 + r) + 0.15 * (hash(col, r) - 0.5);
      const hot = Math.max(0, Math.min(1, v));
      cells.push(<rect key={`${r}-${c}`} x={c * 12} y={r * 8} width={11} height={7}
        fill={`hsl(${Math.round(220 - 200 * hot)} 70% ${Math.round(72 - 22 * hot)}%)`} />);
    }
  }
  return <svg className="heat-mini" width="100%" viewBox={`0 0 ${COLS * 12} ${ROWS * 8}`}>{cells}</svg>;
}

/** Points drifting toward their cluster's centre; the centres move from time to time. */
function ClusterMini({ playing }: { playing: boolean }) {
  const n = useSteps(300, playing);
  const K = 3, P = 21, W = 190, H = 36;
  const epoch = Math.floor(n / 14);
  const phase = (n % 14) / 13; // 0 scattered → 1 gathered
  const colours = ['#1d4ed8', '#d97706', '#0f766e'];
  const centre = (k: number) => ({ x: 30 + 55 * k + 20 * hash(epoch, k), y: 11 + 14 * hash(epoch, k + 9) });
  const dots = [];
  for (let i = 0; i < P; i++) {
    const k = i % K;
    const c = centre(k);
    const sx = 6 + (W - 12) * hash(epoch * 31 + i, 3), sy = 4 + (H - 8) * hash(epoch * 31 + i, 5);
    const e = phase * phase * (3 - 2 * phase);
    const jx = 22 * (hash(i, 11) - 0.5), jy = 12 * (hash(i, 13) - 0.5);
    dots.push(<circle key={i} cx={sx + (c.x + jx - sx) * e} cy={sy + (c.y + jy - sy) * e} r={2.4} fill={colours[k]} />);
  }
  return <svg className="cluster-mini" width="100%" viewBox={`0 0 ${W} ${H}`}>{dots}</svg>;
}
