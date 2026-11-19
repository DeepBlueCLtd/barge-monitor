// One uPlot chart. Charts sharing a `syncKey` share their cursor; zoom is
// shared by the parent through `xRange`.
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface Series {
  label: string;
  values: (number | null)[];
  color: string;
  points?: boolean; // draw as points (for directions and categories), never as a line
}

export interface Mark {
  t: number;
  color: string;
}

interface Props {
  title: string;
  unit?: string;
  t: number[];
  series: Series[];
  height?: number;
  syncKey?: string;
  xRange?: [number, number] | null;
  onZoom?: (r: [number, number] | null) => void;
  onCursor?: (t: number | null) => void;
  marks?: Mark[];
  yRange?: [number, number];
}

const utc = (ts: number) => uPlot.tzDate(new Date(ts * 1000), 'Etc/UTC');

export function TimeChart({ title, unit, t, series, height = 120, syncKey, xRange, onZoom, onCursor, marks, yRange }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const marksRef = useRef<Mark[]>(marks ?? []);
  const cb = useRef({ onZoom, onCursor });
  cb.current = { onZoom, onCursor };
  marksRef.current = marks ?? [];
  const shape = series.map((s) => `${s.label}${s.points ? 'p' : 'l'}`).join('|');

  useEffect(() => {
    if (!el.current) return;
    const width = el.current.clientWidth || 600;
    // Canvas cannot resolve CSS variables: read the theme's colours here.
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue('--muted').trim() || '#666';
    const grid = css.getPropertyValue('--grid').trim() || '#ddd';
    const hhmm = (_u: uPlot, splits: number[]) =>
      splits.map((v) => {
        const iso = new Date(v * 1000).toISOString();
        return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : iso.slice(11, 16);
      });
    const opts: uPlot.Options = {
      width,
      height,
      tzDate: utc,
      legend: { live: true },
      cursor: {
        sync: syncKey ? { key: syncKey, setSeries: false } : undefined,
        drag: { x: true, y: false, setScale: false },
      },
      scales: { x: { time: true }, y: yRange ? { range: yRange } : {} },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, values: hhmm, size: 28 },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, size: 56, label: unit, labelSize: 14 },
      ],
      series: [
        { label: 'time (UTC)' },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 1.25,
          spanGaps: false,
          paths: s.points ? () => null : undefined,
          points: s.points ? { show: true, size: 3, fill: s.color, stroke: s.color } : { show: false },
        })),
      ],
      hooks: {
        setSelect: [
          (u) => {
            if (u.select.width < 5) return;
            const a = u.posToVal(u.select.left, 'x');
            const b = u.posToVal(u.select.left + u.select.width, 'x');
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            cb.current.onZoom?.([a, b]);
          },
        ],
        setCursor: [
          (u) => {
            const i = u.cursor.idx;
            cb.current.onCursor?.(i == null ? null : (u.data[0][i] as number));
          },
        ],
        draw: [
          (u) => {
            const ctx = u.ctx;
            ctx.save();
            for (const m of marksRef.current) {
              const x = u.valToPos(m.t, 'x', true);
              if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
              ctx.strokeStyle = m.color;
              ctx.lineWidth = 1.5 * devicePixelRatio;
              ctx.setLineDash([4, 3]);
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, [t, ...series.map((s) => s.values)] as uPlot.AlignedData, el.current);
    u.root.addEventListener('dblclick', () => cb.current.onZoom?.(null));
    plot.current = u;
    const ro = new ResizeObserver(() => {
      if (el.current) u.setSize({ width: el.current.clientWidth, height });
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // Rebuild only when the shape of the chart changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, height, syncKey, unit]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    u.setData([t, ...series.map((s) => s.values)] as uPlot.AlignedData, !xRange);
    if (xRange) u.setScale('x', { min: xRange[0], max: xRange[1] });
  }, [t, series, xRange]);

  useEffect(() => {
    plot.current?.redraw(false, false);
  }, [marks]);

  return (
    <div className="chart">
      <div className="chart-title">{title}</div>
      <div ref={el} />
    </div>
  );
}
