// Accounts and roles: the data server's configuration (docs/v4-interfaces.md §9.3; FR-93, FR-102,
// FR-113, FR-114). Identical to backend/barge/accounts.py.
//
// DEMO CREDENTIALS (PR-07). These accounts and passwords exist only in the demonstrator. They are
// labelled as such wherever they appear, and a developed system never ships or pre-populates
// credentials (FR-102). Roles are read on every request: a change takes effect on the next one
// (FR-116, D-151).

export type Role = 'owner' | 'viewer-emissions' | 'viewer' | 'service' | 'service-no-co2';
export const ROLES: Record<Role, string> = {
  owner: 'Owner',
  'viewer-emissions': 'Viewer with emissions',
  viewer: 'Viewer (weather only)',
  service: 'Service (reads CO₂)',
  'service-no-co2': 'Service (no CO₂)',
};
const ROLE_ALIASES: Record<string, Role> = {
  ...Object.fromEntries(Object.keys(ROLES).map((k) => [k, k as Role])),
  ...Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [v.toLowerCase(), k as Role])),
  emissions: 'viewer-emissions', weather: 'viewer', 'weather-only': 'viewer', 'viewer-weather': 'viewer',
};
const CO2_ROLES = new Set<Role>(['owner', 'viewer-emissions', 'service']);
export const SERVICE_PASSWORD = 'svc-demo';

export interface Account {
  user: string;
  password: string;
  role: Role;
  kind: 'user' | 'service';
  component: 'client' | 'importer' | 'models';
}

function demoAccounts(): Map<string, Account> {
  const a: Account[] = [
    { user: 'owner', password: 'demo-owner', role: 'owner', kind: 'user', component: 'client' },
    { user: 'friend', password: 'demo-friend', role: 'viewer', kind: 'user', component: 'client' },
    { user: 'analyst', password: 'demo-analyst', role: 'viewer-emissions', kind: 'user', component: 'client' },
    { user: 'svc-importer', password: SERVICE_PASSWORD, role: 'service', kind: 'service', component: 'importer' },
    { user: 'svc-data-cleanse', password: SERVICE_PASSWORD, role: 'service', kind: 'service', component: 'models' },
    { user: 'svc-summaries', password: SERVICE_PASSWORD, role: 'service', kind: 'service', component: 'models' },
    { user: 'svc-analysis', password: SERVICE_PASSWORD, role: 'service', kind: 'service', component: 'models' },
    { user: 'svc-new-model-1', password: SERVICE_PASSWORD, role: 'service-no-co2', kind: 'service', component: 'models' },
    { user: 'svc-new-model-2', password: SERVICE_PASSWORD, role: 'service-no-co2', kind: 'service', component: 'models' },
  ];
  return new Map(a.map((x) => [x.user, x]));
}

export const USERS = ['owner', 'friend', 'analyst'];
export const MODEL_SERVICES = ['svc-data-cleanse', 'svc-summaries', 'svc-analysis', 'svc-new-model-1', 'svc-new-model-2'];
export const DEMO_PASSWORDS = [...new Set([...demoAccounts().values()].map((a) => a.password))].sort();

export function mayReadCo2(role: Role | null | undefined): boolean {
  return !!role && CO2_ROLES.has(role);
}

/** The Authorization header value for an account. */
export function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

export function passwordOf(user: string): string {
  return demoAccounts().get(user)!.password;
}

/** (user, password) from an `Authorization: Basic` header, or null. */
export function parseBasic(header: string | null | undefined): [string, string] | null {
  if (!header || header.slice(0, 6).toLowerCase() !== 'basic ') return null;
  let text: string;
  try {
    const bin = atob(header.slice(6).trim());
    text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = text.indexOf(':');
  return i < 0 ? null : [text.slice(0, i), text.slice(i + 1)];
}

/** The delivered user-to-role assignment, as a receiving model looks a `sender` up (FR-112a, D-152). */
export function roleOf(user: string): Role | null {
  return demoAccounts().get(user)?.role ?? null;
}

/** The server's account table and user-to-role assignment. Kept across restarts. */
export class Accounts {
  readonly byUser = demoAccounts();

  authenticate(header: string | null | undefined): Account | null {
    const up = parseBasic(header);
    if (!up) return null;
    const a = this.byUser.get(up[0]);
    return a && a.password === up[1] ? a : null;
  }

  setRole(user: string, role: string): Account {
    const a = this.byUser.get(user);
    if (!a) throw new Error(`unknown account '${user}'`);
    const r = ROLE_ALIASES[String(role).trim().toLowerCase()] ?? ROLE_ALIASES[String(role).trim()];
    if (!r) throw new Error(`unknown role '${role}'; roles are ${Object.keys(ROLES).join(', ')}`);
    if ((a.kind === 'user') === (r === 'service' || r === 'service-no-co2')) throw new Error(`${user} is a ${a.kind} account; role ${r} is not for it`);
    a.role = r; // read on every request: it takes effect on the next one (FR-116, D-151)
    return a;
  }

  state() {
    return [...this.byUser.values()].map((a) => ({ user: a.user, role: a.role, kind: a.kind, label: ROLES[a.role] }));
  }
}
