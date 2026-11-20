// Routed flows (VS-13): polylines of horizontal and vertical segments from the
// layout file, a lane per direction, and positions along them for messages.
import layout from './layout.json';

export type Pt = [number, number];
export const LANE_OFFSET = 7;

function offset(path: Pt[], d: number): Pt[] {
  const segs = path.slice(1).map((p, i) => {
    const [ax, ay] = path[i];
    const len = Math.hypot(p[0] - ax, p[1] - ay) || 1;
    const nx = -(p[1] - ay) / len, ny = (p[0] - ax) / len; // the right-hand side in screen coordinates
    return { a: [ax + nx * d, ay + ny * d] as Pt, b: [p[0] + nx * d, p[1] + ny * d] as Pt };
  });
  const out: Pt[] = [segs[0].a];
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i], t = segs[i + 1];
    // Orthogonal neighbours meet where the shifted vertical and horizontal lines cross.
    const vert = Math.abs(s.a[0] - s.b[0]) < 1e-6;
    out.push(vert ? [s.a[0], t.a[1]] : [t.a[0], s.a[1]]);
  }
  out.push(segs[segs.length - 1].b);
  return out;
}

export interface Lane { points: Pt[]; length: number; cum: number[] }

function lane(points: Pt[]): Lane {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, length: cum[cum.length - 1], cum };
}

const lanes = new Map<string, Lane>();
for (const f of layout.flows) {
  const p = f.path as Pt[];
  if (f.twoWay) {
    lanes.set(`${f.a}>${f.b}`, lane(offset(p, LANE_OFFSET)));
    lanes.set(`${f.b}>${f.a}`, lane(offset([...p].reverse(), LANE_OFFSET)));
  } else {
    lanes.set(`${f.a}>${f.b}`, lane(p));
    lanes.set(`${f.b}>${f.a}`, lane([...p].reverse()));
  }
}

export function laneFor(src: string, dst: string): Lane | undefined {
  return lanes.get(`${src}>${dst}`);
}

/** All drawn arrows: one per direction of a two-way flow, one otherwise. */
export function arrows(): { id: string; points: Pt[]; label?: string; labelAt?: Pt }[] {
  const out: { id: string; points: Pt[]; label?: string; labelAt?: Pt }[] = [];
  for (const f of layout.flows) {
    out.push({ id: `${f.a}>${f.b}`, points: lanes.get(`${f.a}>${f.b}`)!.points, label: f.label, labelAt: f.labelAt as Pt | undefined });
    if (f.twoWay) out.push({ id: `${f.b}>${f.a}`, points: lanes.get(`${f.b}>${f.a}`)!.points });
  }
  return out;
}

export function pointAt(l: Lane, f: number): Pt {
  const s = Math.max(0, Math.min(1, f)) * l.length;
  let i = 1;
  while (i < l.cum.length - 1 && l.cum[i] < s) i++;
  const seg = l.cum[i] - l.cum[i - 1] || 1;
  const g = (s - l.cum[i - 1]) / seg;
  const a = l.points[i - 1], b = l.points[i];
  return [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g];
}

/** A filled arrowhead at the end of a polyline. */
export function arrowhead(points: Pt[], size = 9): string {
  const [ax, ay] = points[points.length - 2], [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const l: Pt = [bx - ux * size - uy * size * 0.5, by - uy * size + ux * size * 0.5];
  const r: Pt = [bx - ux * size + uy * size * 0.5, by - uy * size - ux * size * 0.5];
  return `M${bx},${by}L${l[0]},${l[1]}L${r[0]},${r[1]}Z`;
}
