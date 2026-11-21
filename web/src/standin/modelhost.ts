// The data server's internal interface for models (FR-28, FR-35; modelhost.py).
// Models reach the data server directly, not through FastAPI (SRD §3.1): in
// the stand-in they call these operations in-process, as the Python models do
// under CPython. Every call and its answer is captured as an I message between
// `models` and `server`. While the server is waiting or down, calls are
// refused with that status and the model tries again on its next step (FR-33).
import { Cols, CommandRec, Registry, Series } from './registry';
import type { Server } from './server';
import { SOSA } from './constants';
import type { DataRecord } from './swe';
import type { Tap } from './tap';
import { iso } from './time';

const SWE_TYPES = new Set(['Quantity', 'Count', 'Category', 'Boolean', 'Text', 'Time', 'Matrix', 'DataArray']);

export class ModelError extends Error {}

export type CallResult = { ok: true; result: unknown } | { ok: false; status: 'down' | 'waiting' | 'refused'; error: string };

export interface HostRuntime {
  server: Server | null;
  registry: Registry;
  tap: Tap;
  now(): number;
}

function isCols(v: unknown): v is Cols {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 't' in (v as object)
    && (ArrayBuffer.isView((v as Cols).t) || Array.isArray((v as Cols).t));
}

/** What a captured message shows of a call's arguments: never whole columns (`_brief`). */
function brief(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (k === 'cols' && isCols(v)) out.cols = { fields: Object.keys(v).filter((c) => c !== 't'), rows: v.t.length };
    else if ((k === 't0' || k === 't1') && typeof v === 'number' && Number.isFinite(v)) out[k] = iso(v);
    else out[k] = v;
  }
  return out;
}

export interface PhaseInfo {
  label: string;
  phase?: string;
  detail?: string;
}

export class ModelHost {
  readonly phase = new Map<string, PhaseInfo>();
  readonly listeners = new Map<string, (message: Record<string, any>) => void>();
  private calls = 0;

  constructor(private readonly rt: HostRuntime) {}

  /** The data server passes something to a model (server → models): a command. */
  notify(model: string | undefined, message: Record<string, any>): void {
    this.rt.tap.emit('server', 'models', 'I', `${model}: ${message.type} ${message.command?.id ?? ''}`, message, { model });
    const fn = model ? this.listeners.get(model) : undefined;
    if (fn) fn(message);
  }

  call(model: string, op: string, args: Record<string, any>, quiet = false): CallResult {
    const tap = this.rt.tap;
    const prev = tap.beginChain(`m${++this.calls}`, 0);
    try {
      const srv = this.rt.server;
      const failed = srv === null || !srv.ready;
      tap.emit('models', 'server', 'I', `${model}: ${op}`, { op, ...brief(args) }, { failed: srv === null, model, quiet });
      if (failed) {
        const status = srv === null ? 'down' : 'waiting';
        if (srv !== null) {
          tap.emit('server', 'models', 'I', `${model}: ${op} refused, server waiting`,
            { status: 503, detail: 'waiting mode: rebuilding the index' }, { model, quiet });
        }
        return { ok: false, status, error: `the data server is ${status}` };
      }
      let result: unknown;
      try {
        const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)['op_' + op];
        if (typeof fn !== 'function') throw new ModelError(`unknown operation ${op}`);
        result = fn.call(this, srv, model, args, quiet);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        tap.emit('server', 'models', 'I', `${model}: ${op} refused`, { error: msg }, { model, quiet });
        return { ok: false, status: 'refused', error: msg };
      }
      tap.emit('server', 'models', 'I', `${model}: ${op} done`,
        isCols(result) ? { cols: { fields: Object.keys(result).filter((c) => c !== 't'), rows: result.t.length } } : brief({ result }),
        { model, quiet });
      return { ok: true, result };
    } finally {
      tap.endChain(prev);
    }
  }

  setPhase(model: string, phase: string, detail = '', label?: string): void {
    const cur = this.phase.get(model) ?? { label: label ?? model };
    cur.phase = phase;
    cur.detail = detail;
    if (label) cur.label = label;
    this.phase.set(model, cur);
  }

  // --- creating resources (FR-28) ------------------------------------------------------------
  op_create_system(srv: Server, model: string, a: { body: Record<string, any> }): string {
    const body = a.body ?? {};
    const uid = body.uniqueId;
    if (typeof uid !== 'string' || !uid || typeof body.label !== 'string') throw new ModelError('a system needs a uniqueId and a label');
    for (const [sid, s] of srv.allSystems()) if (s.uniqueId === uid) return sid; // a restarted model finds its system again
    const reg = srv.registry;
    const sid = reg.systemIdFor(uid);
    reg.systems.set(sid, {
      type: 'SimpleProcess', id: sid, uniqueId: uid, label: body.label, description: body.description ?? '',
      definition: SOSA + 'System', systemType: SOSA + 'System', assetType: 'Process', parent: 'models', createdBy: model,
    });
    this.setPhase(model, 'registered', '', body.label);
    return sid;
  }

  private ownSystem(srv: Server, model: string, systemId: string) {
    const s = srv.registry.systems.get(systemId);
    if (!s) throw new ModelError(`system ${systemId} does not exist`);
    if (s.createdBy !== model) throw new ModelError(`system ${systemId} belongs to ${s.createdBy}, not ${model}`);
    return s;
  }

  private static checkRecord(rec: DataRecord | undefined) {
    if (!rec || typeof rec !== 'object' || rec.type !== 'DataRecord' || !rec.fields?.length) {
      throw new ModelError('schema must be a SWE Common DataRecord with fields');
    }
    if (rec.fields[0].type !== 'Time' || rec.fields[0].name !== 'time') throw new ModelError('the first field must be a Time named time');
    for (const f of rec.fields) {
      if (!SWE_TYPES.has(f.type) || typeof f.name !== 'string') {
        throw new ModelError(`field ${f.name}: SWE Common type ${f.type} is not supported`);
      }
    }
  }

  op_create_datastream(srv: Server, model: string, a: { system_id: string; body: Record<string, any> }): string {
    this.ownSystem(srv, model, a.system_id);
    const rec = a.body?.schema as DataRecord | undefined;
    ModelHost.checkRecord(rec);
    const out = a.body.outputName;
    if (typeof out !== 'string' || !out) throw new ModelError('a datastream needs an outputName');
    const key = `${a.system_id}:${out}`;
    const reg = srv.registry;
    const old = reg.datastreams.get(key);
    const names = rec!.fields.map((f) => f.name);
    if (old && old.schema.fields.map((f) => f.name).join('\u0000') === names.join('\u0000')) return key;
    reg.datastreams.set(key, {
      key, system: a.system_id, outputName: out, name: a.body.name ?? out, schema: rec!,
      series: new Series(rec!.fields, a.body.retention ?? null),
    });
    return key;
  }

  op_create_controlstream(srv: Server, model: string, a: { system_id: string; body: Record<string, any> }): string {
    this.ownSystem(srv, model, a.system_id);
    const rec = a.body?.schema;
    if (!rec || typeof rec !== 'object' || rec.type !== 'DataRecord') throw new ModelError("a control stream's schema must be a SWE Common DataRecord");
    const name = a.body.inputName || 'settings';
    const key = `${a.system_id}:${name}`;
    srv.registry.controlstreams.set(key, { key, system: a.system_id, inputName: name, name: a.body.name ?? name, schema: rec });
    return key;
  }

  op_find(srv: Server, model: string, a: { system_uid: string; output_name: string; since?: number | null }): string | null {
    const sysm = [...srv.allSystems().values()].find((s) => s.uniqueId === a.system_uid);
    if (!sysm) return null;
    if ((sysm.id === 'bow' || sysm.id === 'stern') && a.output_name === 'weather') return `${sysm.id}:weather`;
    const key = `${sysm.id}:${a.output_name}`;
    const d = srv.registry.datastreams.get(key);
    if (!d) return null;
    // retention keeps what it has not read
    if (!d.series.readers.has(model)) d.series.readers.set(model, a.since === undefined || a.since === null ? -Infinity : a.since);
    return key;
  }

  // --- reading and publishing observations ---------------------------------------------
  op_read(srv: Server, model: string, a: { key: string; t0: number; t1: number; fields?: string[] | null }, quiet = false): Cols {
    const [sensor, out] = a.key.split(':');
    if (out === 'weather' && (sensor === 'bow' || sensor === 'stern')) {
      const names = (a.fields ?? srv.sensorSchema[sensor].fields.map((f) => f.name))
        .filter((n) => n !== 'time' && !n.endsWith('_qc') && srv.offering.keep(n));
      return srv.sensorRecords(sensor, a.t0, a.t1, null, 0, names, `${model} read`, quiet);
    }
    const d = srv.registry.datastreams.get(a.key);
    if (!d) throw new ModelError(`datastream ${a.key} does not exist`);
    const s = d.series;
    const [i0, i1] = s.range(a.t0, a.t1);
    const names = (a.fields ?? s.colNames()).filter((n) => srv.offering.keep(n));
    const cols = s.slice(i0, i1, names);
    if (cols.t.length) s.readers.set(model, cols.t[cols.t.length - 1]);
    return cols;
  }

  op_publish(srv: Server, model: string, a: { key: string; cols: Cols; replace?: boolean }): number {
    const d = srv.registry.datastreams.get(a.key);
    if (!d) throw new ModelError(`datastream ${a.key} does not exist`);
    const owner = srv.registry.systems.get(d.system);
    if (!owner || owner.createdBy !== model) throw new ModelError(`${model} cannot publish to ${a.key}`);
    const s = d.series;
    if (a.replace) s.clear();
    const n = s.append(a.cols);
    s.prune(this.rt.now());
    return n;
  }

  // --- commands (FR-27) ----------------------------------------------------------------------
  op_commands(srv: Server, _model: string, a: { key: string }): CommandRec[] {
    return [...srv.registry.commands.values()].filter((c) => c.cs_key === a.key && c.status[c.status.length - 1].statusCode === 'PENDING');
  }

  op_command_status(srv: Server, _model: string, a: { cmd_id: string; status: string; message?: string }): string {
    const c = srv.registry.commands.get(a.cmd_id);
    if (!c) throw new ModelError(`command ${a.cmd_id} does not exist`);
    if (!['ACCEPTED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED'].includes(a.status)) throw new ModelError(`unknown status ${a.status}`);
    c.status.push({ statusCode: a.status, reportTime: iso(this.rt.now()), ...(a.message ? { message: a.message } : {}) });
    return a.status;
  }

  // --- the referee (FR-37) ----------------------------------------------------------------------
  /**
   * The stand-in has no referee: the manifest (the ground truth) is written by
   * the Python world generator and is not part of the pre-calculated history,
   * so nothing is scored and every score is null, labelled "stand-in" (FR-06e).
   */
  op_score(_srv: Server, _model: string, a: { kind: string }): Record<string, unknown> {
    if (a.kind === 'changes') {
      return { boundary_recall: null, boundary_precision: null, front_recall: null, scored_by: 'stand-in: not scored' };
    }
    if (a.kind === 'clusters') return { ari_air_mass: null, ari_reach_kind: null, scored_by: 'stand-in: not scored' };
    throw new ModelError(`unknown score kind ${a.kind}`);
  }
}
