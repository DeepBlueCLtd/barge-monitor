// The display client (B-C14): handshake, profile check, self-configuration,
// panels. It knows the server only by its base URL and the declared
// profile. Restart client remounts this component: all of its state goes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { simClock } from '../shell/clock';
import { clientStatus } from '../shell/status';
import { useStore } from '../shell/store';
import { WorkspacePanel } from '../workspace/WorkspacePanel';
import { LiveData, Row } from './data';
import { Configuration, Field, handshake } from './handshake';
import { ClientHttp, InstanceChanged, NetworkFailure } from './http';
import { BandChart, GenericView, Heatmap, LineChart, Mark, PairChart } from './views/views';

type Phase = { kind: 'handshake'; note: string } | { kind: 'unreachable' } | { kind: 'rejected'; reason: string } | { kind: 'running' };
const VIEWS = [
  ['temperature', 'Air temperature'], ['wind', 'Apparent wind speed'], ['derived', 'Derived values'],
  ['changes', 'Change detector'], ['clusters', 'Clustering'], ['correlation', 'Correlation matrix'],
] as const;
type ViewId = (typeof VIEWS)[number][0];

export function DisplayClient({ onRestart }: { onRestart: () => void }) {
  const http = useMemo(() => new ClientHttp(), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'handshake', note: 'starting' });
  const [config, setConfig] = useState<Configuration | null>(null);
  const [live, setLive] = useState<LiveData | null>(null);
  const [popup, setPopup] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>({ temperature: true, wind: true, derived: true, changes: true, clusters: true, correlation: true });

  useEffect(() => {
    let alive = true;
    let data: LiveData | null = null;
    http.onInstanceChange = () => onRestart(); // FR-46: a new instance means start afresh
    const attempt = async () => {
      try {
        setPhase({ kind: 'handshake', note: 'discovering what the server offers' });
        const cfg = await handshake(http, (s) => alive && setPhase({ kind: 'handshake', note: `server in waiting mode: retrying after ${s} s` }));
        if (!alive) return;
        setConfig(cfg);
        if (cfg.rejected) {
          setPhase({ kind: 'rejected', reason: cfg.rejected });
          return;
        }
        data = new LiveData(http, cfg);
        await data.start();
        if (!alive) return data.stop();
        setLive(data);
        setPhase({ kind: 'running' });
        if (cfg.problems.length) setPopup(true);
      } catch (e) {
        if (!alive || e instanceof InstanceChanged) return;
        if (e instanceof NetworkFailure) {
          setPhase({ kind: 'unreachable' });
          // Retry on the simulation clock (FR-46a).
          const from = simClock.now();
          const h = setInterval(() => {
            if (simClock.now() - from >= 1) {
              clearInterval(h);
              if (alive) void attempt();
            }
          }, 100);
        } else setPhase({ kind: 'rejected', reason: String(e) });
      }
    };
    void attempt();
    return () => {
      alive = false;
      http.closed = true;
      data?.stop();
    };
  }, [http, onRestart]);

  const version = useStore(live?.version ?? NULL_STORE);
  const stale = useStore(live?.stale ?? NULL_BOOL);
  void version;

  // Report this client's state to the shell's status summary (VS-28).
  useEffect(() => {
    const missing = config ? new Set(config.problems.map((p) => p.essential.id)).size : 0;
    clientStatus.set({
      phase: phase.kind === 'running' ? (stale ? 'unreachable' : missing ? 'degraded' : 'running') : phase.kind,
      essentialsMissing: missing, optional: config?.generic.length ?? 0, instance: config?.instance ?? null,
    });
  }, [phase, config, stale]);

  if (phase.kind !== 'running' || !config || !live) {
    return (
      <>
        <section className="panel charts-panel" aria-label="Time-series charts">
          <ClientStatus phase={phase} />
        </section>
        <section className="panel analysis-panel" aria-label="Analysis views" />
        <section className="panel workspace-panel" aria-label="Python workspace"><WorkspacePanel /></section>
      </>
    );
  }

  const unavailable = new Map<string, string[]>();
  for (const p of config.problems) for (const v of p.essential.views) unavailable.set(v, [...(unavailable.get(v) ?? []), `${p.essential.label}: ${p.reason}`]);
  const b = (id: string) => config.bindings[id];
  const rows = (id?: string) => (id ? live.get(id) : []);
  const changesB = b('change-detector');
  const marks: Mark[] = shown.changes && changesB ? rows(changesB.ds.id).map((r) => ({ time: r.time, label: `${r.scale} ${r.strength}` })) : [];
  const runsDs = config.datastreams.find((d) => d.systemUid === 'urn:x-barge:process:analysis' && d.outputName === 'runs');
  const run: Row | undefined = runsDs ? rows(runsDs.id)[0] : undefined;
  const score = (k: string) => (run && typeof run[k] === 'number' ? run[k].toFixed(2) : '—');

  const toggle = (id: ViewId, label: string) => {
    const why = unavailable.get(id);
    return (
      <button key={id} className={shown[id] && !why ? 'on' : ''} disabled={!!why} title={why ? `Unavailable: ${why.join('; ')}` : `Show or hide ${label}`}
        onClick={() => setShown({ ...shown, [id]: !shown[id] })} data-testid={`view-${id}`}>
        {label}
      </button>
    );
  };
  const unavailableCard = (id: ViewId, label: string) => (
    <div className="unavailable" data-testid={`unavailable-${id}`}>{label} is unavailable: {unavailable.get(id)!.join('; ')}</div>
  );
  const view = (id: ViewId, label: string, body: () => JSX.Element | null) =>
    unavailable.has(id) ? unavailableCard(id, label) : shown[id] ? body() : null;

  const pair = (bowId: string, sternId: string, field: string, title: string, unit: string, testid: string) => {
    const bb = b(bowId), sb = b(sternId);
    return <PairChart title={title} unit={unit} bow={rows(bb?.ds.id)} stern={rows(sb?.ds.id)} field={field} marks={marks} testid={testid} />;
  };

  const corrB = b('correlation-matrix');
  const corrRow = corrB ? rows(corrB.ds.id)[0] : undefined;
  const clusterB = b('clustering');
  const groups = new Map<string, { title: string; items: { field: Field; dsId: string }[] }>();
  for (const g of config.generic) {
    const key = g.ds.id;
    if (!groups.has(key)) groups.set(key, { title: `${g.ds.systemLabel} · ${g.ds.name}`, items: [] });
    groups.get(key)!.items.push({ field: g.field, dsId: g.ds.id });
  }

  return (
    <>
      {popup && (
        <div className="modal" role="alertdialog" aria-label="Unavailable essential sources">
          <div className="modal-body">
            <h2>Running in degraded mode</h2>
            <p>The server does not offer every essential source in the declared profile. These views are unavailable:</p>
            <ul data-testid="degraded-list">{config.problems.map((p) => <li key={p.essential.id}><b>{p.essential.label}</b>: {p.reason} ({p.detail})</li>)}</ul>
            <button onClick={() => setPopup(false)}>Continue</button>
          </div>
        </div>
      )}
      <section className="panel charts-panel" aria-label="Time-series charts">
        <header className="panel-head">
          <h2>Time series <small data-testid="client-instance" title="The server instance this client handshook with">instance {config.instance}</small></h2>
          <span className="toggles">{VIEWS.filter(([id]) => id !== 'correlation').map(([id, l]) => toggle(id, l))}</span>
        </header>
        {stale && <div className="banner" role="status" data-testid="unreachable">Server unreachable: showing the last data received (stale). Retrying every simulated second.</div>}
        <div className={stale ? 'stale' : ''}>
          {view('temperature', 'Air temperature', () => pair('bow-air-temperature', 'stern-air-temperature', 'air_temperature', 'Air temperature, bow and stern', '°C', 'chart-temperature'))}
          {view('wind', 'Apparent wind speed', () => pair('bow-wind-speed', 'stern-wind-speed', 'apparent_wind_speed', 'Apparent wind speed, bow and stern', 'm/s', 'chart-wind'))}
          {view('derived', 'Derived values', () => <LineChart title="Dew point (bow)" unit="°C" rows={rows(b('derived-values')?.ds.id)} field="dew_point" marks={marks} testid="chart-derived" />)}
          {view('changes', 'Change detector', () => (
            <p className="score" data-testid="changes-score">Change detector: {changesB ? rows(changesB.ds.id).length : 0} changes in the run window (dashed lines). Score against the manifest: reach boundaries found {score('score_boundary_recall')}, precision {score('score_boundary_precision')}, fronts found {score('score_front_recall')}.</p>
          ))}
          {view('clusters', 'Clustering', () => (
            <>
              <BandChart title={`Regimes (clusters) · score against air masses ${score('score_ari_air_mass')} ARI, reach kinds ${score('score_ari_reach_kind')}`} rows={rows(clusterB?.ds.id)} field="regime" tokens={clusterB?.field.constraint?.values ?? []} testid="chart-clusters" />
            </>
          ))}
          <h3 className="other-head">Other sources <small>drawn by schema type alone</small></h3>
          <div className="generic" data-testid="generic-views">
            {[...groups.entries()].map(([key, g]) => (
              <div key={key} className="generic-group" data-testid={`generic-${key}`}>
                {g.items.map(({ field, dsId }) => <GenericView key={field.name} title={g.title} field={field} rows={rows(dsId)} />)}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="panel analysis-panel" aria-label="Analysis views">
        <header className="panel-head"><h2>Analysis</h2><span className="toggles">{toggle('correlation', 'Correlation matrix')}</span></header>
        {view('correlation', 'Correlation matrix', () =>
          corrRow ? <Heatmap names={String(corrRow.parameters).split(',')} matrix={corrRow.matrix}
            subtitle={`Window ${run ? `${run.window_start} to ${run.window_end}` : ''} · ${run?.records ?? '?'} records`} testid="chart-correlation" />
            : <p>No correlation yet.</p>)}
        {config.control && <Commands http={http} control={config.control} onDone={() => live.poll()} />}
      </section>
      <section className="panel workspace-panel" aria-label="Python workspace"><WorkspacePanel /></section>
    </>
  );
}

function ClientStatus({ phase }: { phase: Phase }) {
  if (phase.kind === 'rejected') return <div className="rejected" role="alert" data-testid="rejected"><h2>Server rejected</h2><p>{phase.reason}</p></div>;
  if (phase.kind === 'unreachable') return <div className="banner" role="status" data-testid="unreachable">Server unreachable. Retrying every simulated second.</div>;
  if (phase.kind === 'handshake') return <p className="handshake" data-testid="handshake">Handshake: {phase.note}…</p>;
  return null;
}

/** Analysis settings as commands (FR-60). The controls come from the control stream's schema alone. */
function Commands({ http, control, onDone }: { http: ClientHttp; control: NonNullable<Configuration['control']>; onDone: () => void }) {
  const fields = control.schema.fields;
  const [vals, setVals] = useState<Record<string, any>>({});
  const [status, setStatus] = useState<string>('');
  const busy = useRef(false);
  async function send() {
    if (busy.current) return;
    busy.current = true;
    setStatus('sending…');
    const params: Record<string, any> = {};
    for (const f of fields) {
      if (vals[f.name] === undefined || vals[f.name] === '') continue;
      params[f.name] = f.type === 'Boolean' ? !!vals[f.name] : Number(vals[f.name]);
    }
    try {
      const r = await http.request('POST', `controlstreams/${control.id}/commands`, undefined, { parameters: params });
      setStatus(r.status === 201 ? `Command ${r.body.id}: ${r.body.currentStatus}` : `Refused by the server (${r.status}): ${r.body.description}`);
      onDone();
    } catch (e) {
      setStatus(String(e));
    } finally {
      busy.current = false;
    }
  }
  return (
    <form className="commands" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h3>Analysis settings <small>sent as commands; bounds from the control stream's schema</small></h3>
      <div className="fields">
        {fields.map((f) => {
          const iv = f.constraint?.intervals?.[0];
          return (
            <label key={f.name} className={f.type === 'Boolean' ? 'check' : ''}>
              {f.type === 'Boolean' ? (
                <input type="checkbox" checked={!!vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.checked })} />
              ) : null}
              <span>{f.label ?? f.name}{f.uom?.code && f.uom.code !== '1' ? ` (${f.uom.code})` : ''}</span>
              {f.type !== 'Boolean' && (
                <input type="number" step={f.type === 'Count' ? 1 : 'any'} placeholder={iv ? `${iv[0]}–${iv[1]}` : ''} value={vals[f.name] ?? ''}
                  onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} aria-label={f.name} />
              )}
            </label>
          );
        })}
      </div>
      <button type="submit">Send command</button> <span data-testid="command-status" className="cmd-status">{status}</span>
    </form>
  );
}

import { Store } from '../shell/store';
const NULL_STORE = new Store(0);
const NULL_BOOL = new Store(false);
