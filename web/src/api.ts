// The display's HTTP client. Relative URLs only; the Service Worker answers.
import { API_BASE, WORKSPACE_BASE } from './config';
import type { components } from './generated/api';

export type Coverage = components['schemas']['Coverage'];
export type Collection = components['schemas']['Collection'];
export type ClockState = components['schemas']['ClockState'];
export type Canal = components['schemas']['Canal'];
export type ApiError = components['schemas']['Exception'];

export class HttpError extends Error {
  constructor(public status: number, public body: ApiError) {
    super(body?.description ?? `HTTP ${status}`);
  }
}

async function request<T>(base: string, path: string, params?: Record<string, string | undefined>, init?: RequestInit): Promise<T> {
  const q = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && q.set(k, v));
  const qs = q.toString();
  const r = await fetch(base + path + (qs ? `?${qs}` : ''), init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, body);
  return body as T;
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | undefined>) => request<T>(API_BASE, path, params),
  put: <T>(path: string, body: unknown) =>
    request<T>(API_BASE, path, undefined, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  ws: <T>(path: string) => request<T>(WORKSPACE_BASE, path),
};

export function routeWkt(canal: Canal): string {
  const { lon, lat } = canal.centreline;
  return `LINESTRING(${lon.map((x, i) => `${x} ${lat[i]}`).join(',')})`;
}

/** Times of a trajectory coverage as unix seconds. */
export function times(cov: Coverage): number[] {
  return (cov.domain.axes.composite.values as [string, number, number][]).map((v) => Date.parse(v[0]) / 1000);
}

export function positions(cov: Coverage): [number, number][] {
  return (cov.domain.axes.composite.values as [string, number, number][]).map((v) => [v[1], v[2]]);
}

export function label(cov: Coverage, name: string): string {
  const p = cov.parameters[name];
  const l = p?.observedProperty?.label ?? {};
  return (l as Record<string, string>).en ?? name;
}

export function unit(cov: Coverage, name: string): string {
  return cov.parameters[name]?.unit?.symbol ?? '';
}

export function isCategorical(cov: Coverage, name: string): boolean {
  return !!cov.parameters[name]?.categoryEncoding;
}

export function categories(cov: Coverage, name: string): string[] {
  const enc = cov.parameters[name]?.categoryEncoding ?? {};
  const out: string[] = [];
  Object.entries(enc).forEach(([k, v]) => (out[v as number] = k.replace(/^barge:/, '')));
  return out;
}
