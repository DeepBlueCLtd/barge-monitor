// Routed flows (FR-65, VS-13): one polyline per direction from the layout
// file, and positions along them for travelling messages.
import layout from './layout.json';

export type Pt = [number, number];
export type Rect = [number, number, number, number];

export interface Lane {
  id: string;
  points: Pt[];
  length: number;
  cum: number[];
  label?: string;
  labelAt?: Pt;
}

function lane(id: string, points: Pt[], label?: string, labelAt?: Pt): Lane {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { id, points, length: cum[cum.length - 1], cum, label, labelAt };
}

const lanes = new Map<string, Lane>();
for (const a of layout.arrows) {
  const id = `${a.src}>${a.dst}`;
  lanes.set(id, lane(id, a.path as Pt[], (a as { label?: string }).label, (a as { labelAt?: Pt }).labelAt));
}

export const LAYOUT_SIZE = layout.size as [number, number];
export const cardRect = (id: string): Rect => (layout.cards as unknown as Record<string, Rect>)[id];

export function laneFor(src: string, dst: string): Lane | undefined {
  return lanes.get(`${src}>${dst}`);
}

export function allLanes(): Lane[] {
  return [...lanes.values()];
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

/** A filled arrowhead at the end of a polyline (VS-13). */
export function arrowhead(points: Pt[], size = 10): string {
  const [ax, ay] = points[points.length - 2], [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const l: Pt = [bx - ux * size - uy * size * 0.5, by - uy * size + ux * size * 0.5];
  const r: Pt = [bx - ux * size + uy * size * 0.5, by - uy * size - ux * size * 0.5];
  return `M${bx},${by}L${l[0]},${l[1]}L${r[0]},${r[1]}Z`;
}
