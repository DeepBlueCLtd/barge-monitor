// The data server: a stand-in for a stock OpenSensorHub (FR-06c, FR-38a,
// docs/v4-interfaces.md §9). One Server is one running instance: it is made at
// each server start, freezes the field offering (FR-51), and ends every push
// subscription when it stops. The store outlives it (§9.1: identifiers and
// resources persist across restarts), until Reset instance.
//
// It applies no permission per system: behind the access gateway (§9.5), as
// OpenSensorHub would be. This module holds the server's own configuration (the platform, sensors, CO₂ analysers, Models and the
// workspaces), resource creation, and command delivery to subscribers (§9.2).
// api.ts turns HTTP into calls here.
import profileJson from '../../../contracts/profile.json';
import { Account, Accounts, isService } from './accounts';
import { COMMAND_HOLD_S, SENSORS, SOSA, UID } from './constants';
import { Offering } from './fields';
import { CommandRec, ControlstreamRec, DatastreamRec, Series, Store, SystemRec } from './store';
import { PushStream } from './stream';
import { DataRecord, M } from './swe';
import type { ComponentId, Tap } from './tap';
import { iso, realNow, sleep } from './time';

export interface Profile {
  id: string;
  essentials: { id: string; system: string; datastream: string; field: string; type: string; uom?: string; scope?: string }[];
  [k: string]: unknown;
}
export const PROFILE = profileJson as unknown as Profile;

/** What the server needs of the runtime around it. */
export interface ServerHost {
  tap: Tap;
  accounts: Accounts;
  /** Resolves at once, or when Freeze is released (§4): pushes are held while frozen. */
  thawed(): Promise<void>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Which component an account is, for capture (docs/v4-interfaces.md §2). */
export function componentOf(user: string): { id: ComponentId; model?: string } {
  if (user === 'svc-importer') return { id: 'importer' };
  if (user === 'svc-replay') return { id: 'replay' };
  if (isService(user)) return { id: 'models', model: user.slice(4) };
  return { id: 'client' };
}

interface Subscription {
  stream: PushStream;
  account: Account;
  /** Who is at the other end of the HTTP connection: the gateway, or a module inside the server. */
  via: ComponentId;
}

export interface SystemBody {
  uid: string;
  label: string;
  description: string;
  featureType: string;
  assetType: string;
  smlType: string;
  characteristics?: unknown;
}

export class Server {
  readonly offering: Offering;
  readonly profile = PROFILE;
  stopped = false;
  private subs = new Map<string, Set<Subscription>>(); // control stream id -> subscriptions

  constructor(readonly host: ServerHost, readonly store: Store, offering: Offering, readonly lieAboutProfile: boolean) {
    this.offering = offering.copy();
    this.configure();
  }

  get tap(): Tap {
    return this.host.tap;
  }

  // --- the server's configuration: systems that exist before anyone logs in -------------------
  private configure(): void {
    const sys = (b: Omit<SystemBody, 'description'> & { description?: string }, parent: string | null, extra: Partial<SystemRec> = {}) =>
      this.createSystem(null, { description: '', ...b }, parent, extra).id;
    const barge = sys({ uid: UID.barge, label: 'Collection platform', featureType: SOSA + 'Platform', assetType: 'Platform', smlType: 'PhysicalSystem',
      description: 'The uncrewed electric cargo barge that made the recordings. It records no position.' }, null);
    for (const s of SENSORS) {
      const cap = s === 'bow' ? 'Bow' : 'Stern';
      const sid = sys({ uid: UID.sensor(s), label: `${cap} sensor`, featureType: SOSA + 'Sensor', assetType: 'Equipment', smlType: 'PhysicalSystem',
        description: 'Seven weather parameters at 1 Hz.' }, barge);
      sys({ uid: UID.co2(s), label: `${cap} CO₂ analyser`, featureType: SOSA + 'Sensor', assetType: 'Equipment', smlType: 'PhysicalSystem',
        description: 'CO₂ in ppm at 1 Hz. Restricted.' }, sid);
    }
    sys({ uid: UID.models, label: 'Models', featureType: SOSA + 'System', assetType: 'Process', smlType: 'AggregateProcess',
      description: 'A home for models that turn sensor data into insight. Each model is a process system of its own, created by the model itself.' }, null);
    for (const a of this.host.accounts.users()) {
      const w = sys({ uid: UID.workspace(a.user), label: `Workspace of ${a.user}`, featureType: SOSA + 'System', assetType: 'Other', smlType: 'PhysicalSystem',
        description: `Data of interest kept by ${a.user} (FR-95).` }, null);
      this.createDatastream(null, w, {
        name: 'Data of interest', outputName: 'data-of-interest', schema: M.record('Data of interest', [
          M.time('time', 'Saved'), M.text('doi_id', 'Data of interest'), M.category('action', 'Action', ['save', 'remove']),
          M.text('record', 'The record (JSON)')]),
      });
    }
  }

  // --- reading (no permission per system: that is the gateway's, §9.5) -----------------------------
  system(id: string): SystemRec {
    const s = this.store.systems.get(id);
    if (!s) throw new HttpError(404, `no system ${id}`);
    return s;
  }

  datastream(id: string): DatastreamRec {
    const d = this.store.datastreams.get(this.baseId(id));
    if (!d || this.viewId(d) !== id) throw new HttpError(404, `no datastream ${id}`);
    return d;
  }

  /** The datastream behind a served id, whatever offering it was served under (for the gateway). */
  datastreamAny(id: string): DatastreamRec | undefined {
    return this.store.datastreams.get(this.baseId(id));
  }

  controlstream(id: string): ControlstreamRec {
    const c = this.store.controlstreams.get(id);
    if (!c) throw new HttpError(404, `no control stream ${id}`);
    return c;
  }

  command(id: string): CommandRec {
    const c = this.store.commands.get(id);
    if (!c) throw new HttpError(404, `no command ${id}`);
    return c;
  }

  // --- the field offering (FR-50..FR-52): a datastream's served schema and id ----------------------
  /** The schema as this instance serves it: fields switched off are left out. */
  visible(d: DatastreamRec): DataRecord {
    const fields = d.schema.fields.filter((f) => f.name === 'time' || this.offering.keep(f.name));
    return fields.length === d.schema.fields.length ? d.schema : { ...d.schema, fields };
  }

  /** The id a datastream is served under: a schema with fields hidden is a different datastream (FR-51). */
  viewId(d: DatastreamRec): string {
    const v = this.visible(d);
    if (v === d.schema) return d.id;
    const key = `${d.id}|${v.fields.map((f) => f.name).join(',')}`;
    let id = this.store.views.get(key);
    if (!id) this.store.views.set(key, (id = this.store.newId()));
    return id;
  }

  private baseId(id: string): string {
    if (this.store.datastreams.has(id)) return id;
    for (const [k, v] of this.store.views) if (v === id) return k.slice(0, k.indexOf('|'));
    return id;
  }

  /** Datastreams served: one with every field switched off has nothing to publish (FR-52). */
  servedDatastreams(): DatastreamRec[] {
    return [...this.store.datastreams.values()].filter((d) => this.visible(d).fields.length > 1);
  }

  // --- creating resources (§9.1: 201 with the existing Location) ---------------------------------
  /** A new system, or the existing one with that unique id. `a` null: the server's own configuration. */
  createSystem(a: Account | null, b: SystemBody, parentId: string | null, extra: Partial<SystemRec> = {}): { id: string; existed: boolean } {
    const old = this.store.systemByUid(b.uid);
    if (old) return { id: old.id, existed: true };
    const id = this.store.newId();
    this.store.systems.set(id, {
      id, uid: b.uid, label: b.label, description: b.description, featureType: b.featureType, assetType: b.assetType,
      smlType: b.smlType, parent: parentId, owner: a ? a.user : 'server', characteristics: b.characteristics, extra: {}, ...extra,
    });
    return { id, existed: false };
  }

  /** A datastream; the same output name with the same fields is the existing one (FR-28, FR-51). */
  createDatastream(_a: Account | null, systemId: string, body: { name?: string; outputName: string; description?: string; schema: DataRecord }): { id: string; existed: boolean } {
    const sig = body.schema.fields.map((f) => `${f.name}:${f.type}`).join(',');
    const old = this.store.datastream(systemId, body.outputName);
    if (old && old.sig === sig) return { id: old.id, existed: true };
    const id = this.store.newId();
    this.store.datastreams.set(id, {
      id, system: systemId, outputName: body.outputName, name: body.name ?? body.outputName, description: body.description ?? '',
      schema: body.schema, series: new Series(body.schema.fields), sig,
    });
    return { id, existed: false };
  }

  createControlstream(_a: Account | null, systemId: string, body: { name?: string; inputName: string; description?: string; schema: DataRecord }): { id: string; existed: boolean } {
    const old = this.store.controlstream(systemId, body.inputName);
    if (old) return { id: old.id, existed: true };
    const id = this.store.newId();
    this.store.controlstreams.set(id, {
      id, system: systemId, inputName: body.inputName, name: body.name ?? body.inputName, description: body.description ?? '', schema: body.schema,
    });
    return { id, existed: false };
  }

  // --- commands (§9.1, §9.2) ----------------------------------------------------------------------
  /** Open a push subscription to a control stream. It ends when this instance stops. */
  subscribe(a: Account, cs: ControlstreamRec, via: ComponentId): PushStream {
    const stream = new PushStream();
    if (this.stopped) {
      stream.end();
      return stream;
    }
    const sub = { stream, account: a, via };
    let set = this.subs.get(cs.id);
    if (!set) this.subs.set(cs.id, (set = new Set()));
    set.add(sub);
    stream.onCancel = () => set!.delete(sub);
    return stream;
  }

  subscribers(csId: string): number {
    return this.subs.get(csId)?.size ?? 0;
  }

  /**
   * Send a command (§9.1). With no subscriber it is dropped: 202 after the hold. With one,
   * it is pushed at once and kept; the answer is 200, PENDING, after the hold. The sender
   * never waits for this answer (AT-39).
   */
  async sendCommand(a: Account, cs: ControlstreamRec, parameters: Record<string, unknown>): Promise<{ status: number; cmd: CommandRec | null }> {
    const subs = [...(this.subs.get(cs.id) ?? [])];
    if (!subs.length) {
      await sleep(COMMAND_HOLD_S);
      return { status: 202, cmd: null };
    }
    const id = this.store.newId();
    const cmd: CommandRec = { id, cs: cs.id, issueTime: iso(realNow()), parameters, sender: a.user, status: [] };
    this.store.commands.set(id, cmd);
    // D-127: `sender` is the user name, until S-AUTH says what OpenSensorHub provides.
    const line = JSON.stringify({ id, parameters, issueTime: cmd.issueTime, sender: a.user }) + '\n';
    const sys = this.store.systems.get(cs.system);
    for (const s of subs) {
      void this.host.thawed().then(() => {
        if (s.stream.ended) return;
        const to = s.via === 'gateway' ? { id: 'gateway' as const, model: componentOf(s.account.user).model } : componentOf(s.account.user);
        this.tap.emit('server', to.id, 'K', `push ${cs.inputName} to ${sys?.label ?? cs.system}: ${summarise(parameters)}`, line.trim(),
          { push: true, model: to.model, quiet: false });
        s.stream.write(line);
      });
    }
    await sleep(COMMAND_HOLD_S);
    return { status: 200, cmd };
  }

  /** A receiver reports a command's status at /controlstreams/{id}/status. */
  reportStatus(cs: ControlstreamRec, body: Record<string, unknown>): CommandRec {
    const cmdId = String(body['command@id'] ?? '');
    const cmd = this.store.commands.get(cmdId);
    if (!cmd || cmd.cs !== cs.id) throw new HttpError(400, `no command ${cmdId} on this control stream`);
    const code = String(body.statusCode ?? '');
    if (!['ACCEPTED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED'].includes(code)) {
      throw new HttpError(400, `statusCode must be ACCEPTED, EXECUTING, COMPLETED, FAILED or REJECTED`);
    }
    cmd.status.push({
      id: this.store.newId(), 'command@id': cmdId, statusCode: code, reportTime: iso(realNow()),
      ...(body.message !== undefined && body.message !== '' ? { message: String(body.message) } : {}),
    });
    return cmd;
  }

  /** Stop: every subscription ends (§9.2), so receivers resubscribe once the server answers again. */
  stop(): void {
    this.stopped = true;
    for (const set of this.subs.values()) for (const s of set) s.stream.end();
    this.subs.clear();
  }

  // --- the profile (FR-40, FR-41) -------------------------------------------------------------------
  /** Fixed essentials missing from the server: what conformance's profile claim rests on. */
  missingFixedEssentials(): string[] {
    const out: string[] = [];
    for (const e of this.profile.essentials) {
      if (e.scope === 'dataset') continue;
      const sys = this.store.systemByUid(e.system);
      const ds = sys && this.store.datastream(sys.id, e.datastream);
      const cs = sys && this.store.controlstream(sys.id, e.datastream);
      const fld = ds ? this.visible(ds).fields.find((f) => f.name === e.field) : cs?.schema.fields.find((f) => f.name === e.field);
      if (!fld) out.push(e.id);
    }
    return out;
  }

  claimsProfile(): boolean {
    return this.lieAboutProfile || !this.missingFixedEssentials().length;
  }
}

function summarise(p: Record<string, unknown>): string {
  const s = Object.entries(p).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 37) + '…' : JSON.stringify(v)}`).join(', ');
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}
