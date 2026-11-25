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
  /** Raised by a role change (FR-116, §13.5); see Accounts.authenticate. */
  epoch: number;
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

/** Seconds without a request from an account whose role changed before its next request counts as a new login. */
export const RELOGIN_GAP_S = 3;

export class Accounts {
  readonly byUser = new Map<string, Account>();
  /** Accounts logged out by a role change: user -> real time of their last refused request (null: none refused yet). */
  private loggedOut = new Map<string, number | null>();

  constructor() {
    for (const [user, password, role] of DEMO_ACCOUNTS) this.byUser.set(user, { user, password, role, epoch: 0 });
  }

  /** The human users (each has a workspace, FR-95). */
  users(): Account[] {
    return [...this.byUser.values()].filter((a) => !isService(a.user));
  }

  role(user: string): Role | null {
    return this.byUser.get(user)?.role ?? null;
  }

  /**
   * The account a request's Authorization header names, or null (401). A role change
   * (setRole) logs the account out (FR-116, interim D-128): its next request answers
   * 401, and so does every request after it until the account has sent nothing for
   * RELOGIN_GAP_S. A display client drops its credentials on a 401, so the next
   * request after that gap is a new login.
   */
  authenticate(header: string | undefined, now: number): Account | null {
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
    const out = this.loggedOut.get(a.user);
    if (out !== undefined) {
      if (out === null || now - out < RELOGIN_GAP_S) {
        this.loggedOut.set(a.user, now);
        return null;
      }
      this.loggedOut.delete(a.user);
    }
    return a;
  }

  /** The admin stub (§13.5): change a role, raising the account's epoch. */
  setRole(user: string, role: string): Account {
    const a = this.byUser.get(user);
    if (!a) throw new Error(`no account ${user}`);
    const r = ROLE_ALIASES[role];
    if (!r) throw new Error(`no role ${role}; roles are ${ROLES.join(', ')}`);
    if (isService(user) !== r.startsWith('service')) throw new Error(`${user} cannot take the role ${r}`);
    a.role = r;
    a.epoch += 1;
    this.loggedOut.set(user, null);
    return a;
  }

  list(): { user: string; role: Role; epoch: number }[] {
    return [...this.byUser.values()].map((a) => ({ user: a.user, role: a.role, epoch: a.epoch }));
  }
}
