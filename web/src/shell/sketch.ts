// Seeded sketch rendering (VS-18..VS-21). Every shape is seeded from a stable
// identifier, so it draws identically on every render, every pause and every
// client restart. Without the sketch renderer, shapes fall back to plain CSS
// outlines with uneven corner radii; the demonstrator never waits on the effect.
import rough from 'roughjs';
import type { Pt } from './geometry';

export const sketchEnabled = (() => {
  try {
    return new URLSearchParams(location.search).get('sketch') !== 'off';
  } catch {
    return true;
  }
})();

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 + 1;
}

const gen = (() => {
  try {
    return rough.generator();
  } catch {
    return null;
  }
})();

export interface SketchPath { d: string; stroke: string; strokeWidth: number }

const BASE = { roughness: 0.75, bowing: 0.6, disableMultiStroke: true, preserveVertices: true };

function paths(drawable: any): SketchPath[] {
  return gen!.toPaths(drawable).map((p: any) => ({ d: p.d, stroke: p.stroke, strokeWidth: p.strokeWidth }));
}

/** Outline of a rectangle, or null when the sketch renderer is off or unavailable. */
export function sketchRect(id: string, w: number, h: number, stroke: string, width = 1.6, dashed = false): SketchPath[] | null {
  if (!sketchEnabled || !gen) return null;
  try {
    return paths(gen.rectangle(1.5, 1.5, w - 3, h - 3, { ...BASE, seed: seedOf(id), stroke, strokeWidth: width, ...(dashed ? { strokeLineDash: [8, 6] } : {}) }));
  } catch {
    return null;
  }
}

export function sketchLine(id: string, points: Pt[], stroke: string, width = 1.6): SketchPath[] | null {
  if (!sketchEnabled || !gen) return null;
  try {
    return paths(gen.linearPath(points, { ...BASE, roughness: 0.5, seed: seedOf(id), stroke, strokeWidth: width }));
  } catch {
    return null;
  }
}
