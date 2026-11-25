// Accounts and roles: the server's configuration (docs/v4-interfaces.md §9.3,
// FR-93, FR-114; identical to backend/barge/accounts.py). These are LABELLED
// DEMO CREDENTIALS (FR-102, PR-07): a developed system never ships passwords.
//
// Roles:
//   owner             Owner: reads everything, CO₂ included; manages accounts
//   viewer-emissions  Viewer with emissions: reads everything, CO₂ included
//   viewer            Viewer (weather only): restricted systems are absent
//   service-co2       a core service account: its own systems, reads everything
//   service           a new model's service account: its own systems, no CO₂ (FR-113)

export type Role = 'owner' | 'viewer-emissions' | 'viewer' | 'service-co2' | 'service';
export const ROLES: Role[] = ['owner', 'viewer-emissions', 'viewer', 'service-co2', 'service'];

export interface Account {
  user: string;
  password: string;
  role: Role;
}

export const DEMO_ACCOUNTS: [string, string, Role][] = [
  ['owner', 'demo-owner', 'owner'],
  ['friend', 'demo-friend', 'viewer'],
  ['analyst', 'demo-analyst', 'viewer-emissions'],
  ['svc-importer', 'svc-demo', 'service-co2'],
  ['svc-replay', 'svc-demo', 'service-co2'],
  ['svc-data-cleanse', 'svc-demo', 'service-co2'],
  ['svc-summaries', 'svc-demo', 'service-co2'],
  ['svc-analysis', 'svc-demo', 'service-co2'],
  ['svc-new-model-1', 'svc-demo', 'service'],
  ['svc-new-model-2', 'svc-demo', 'service'],
];

/** The service account a model, the importer or the replay controller authenticates as. */
export function serviceAccount(component: string): string {
  return `svc-${component}`;
}

export function basic(user: string, password: string): string {
  const raw = `${user}:${password}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

/** A role that reads restricted (CO₂) systems. */
export function readsEmissions(role: Role): boolean {
  return role === 'owner' || role === 'viewer-emissions' || role === 'service-co2';
}

export function isService(user: string): boolean {
  return user.startsWith('svc-');
}

/** Role names the admin stub accepts, with the labels the SRD uses. */
const ROLE_ALIASES: Record<string, Role> = {
  owner: 'owner', Owner: 'owner',
  viewer: 'viewer', 'weather-only': 'viewer', 'Viewer (weather only)': 'viewer', 'Viewer': 'viewer',
  'viewer-emissions': 'viewer-emissions', 'Viewer with emissions': 'viewer-emissions', emissions: 'viewer-emissions',
  service: 'service', 'service-co2': 'service-co2',
};

export class Accounts {
  readonly byUser = new Map<string, Account>();

  constructor() {
    for (const [user, password, role] of DEMO_ACCOUNTS) this.byUser.set(user, { user, password, role });
  }

  /** The human users (each has a workspace, FR-95). */
  users(): Account[] {
    return [...this.byUser.values()].filter((a) => !isService(a.user));
  }

  role(user: string): Role | null {
    return this.byUser.get(user)?.role ?? null;
  }

  /**
   * The account a request's Authorization header names, or null (401). The role is read
   * from the account on every request, so a role change takes effect at once (D-151).
   */
  authenticate(header: string | undefined): Account | null {
    if (!header) return null;
    const m = /^\s*Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if (!m) return null;
    let text: string;
    try {
      const bin = atob(m[1]);
      text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
    const i = text.indexOf(':');
    if (i < 0) return null;
    const a = this.byUser.get(text.slice(0, i));
    if (!a || a.password !== text.slice(i + 1)) return null;
    return a;
  }

  /** The admin stub (§13.5): change a role. It applies to the next request (D-151). */
  setRole(user: string, role: string): Account {
    const a = this.byUser.get(user);
    if (!a) throw new Error(`no account ${user}`);
    const r = ROLE_ALIASES[role];
    if (!r) throw new Error(`no role ${role}; roles are ${ROLES.join(', ')}`);
    if (isService(user) !== r.startsWith('service')) throw new Error(`${user} cannot take the role ${r}`);
    a.role = r;
    return a;
  }

  list(): { user: string; role: Role }[] {
    return [...this.byUser.values()].map((a) => ({ user: a.user, role: a.role }));
  }
}
