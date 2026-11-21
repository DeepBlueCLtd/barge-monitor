// The display client's screen (§8): status strip, field chips, period presets
// and clustering, three graph components, the cluster view (mockup 1). It is
// the delivered system, drawn in a plain sans-serif (VS-03). Everything it
// knows about the server it learned at the handshake (C2).
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';
import { essentialLabel } from './handshake';
import { PERIODS, Property } from './plan';
import { ClientSession, clientSession } from './session';
import { ClusterBand, Empty, ErrorBars, HeatMap, LinePlot, ViewFrame } from './views/views';

const PERIOD_SUB: Record<string, string> = { PT5M: 'last 5 minutes', PT1H: 'last hour', PT6H: 'last 6 hours', P1D: 'last day', P7D: 'last week', P28D: 'last 4 weeks' };

export function DisplayClient() {
  const session = useStore(clientSession);
  return <Screen key={session.http.prefix} session={session} />;
}

function Screen({ session }: { session: ClientSession }) {
  const phase = useStore(session.phase);
  const config = useStore(session.config);
  const props = useStore(session.props);
  const sel = useStore(session.selection);
  const banner = useStore(session.banner);
  const stale = useStore(session.stale);
  useStore(session.version);
  useStore(session.run);
  const commandNote = useStore(session.commandNote);

  const missing = config?.problems ?? [];
  const status = phase === 'unreachable' ? 'server unreachable · data stale'
    : phase === 'waiting' ? 'server starting (503) · waiting'
      : phase === 'rejected' ? 'server rejected'
        : !config ? (phase === 'handshake' ? 'handshake…' : 'not started')
          : missing.length ? `degraded · ${missing.length} essential source${missing.length > 1 ? 's' : ''} unavailable`
            : config.claimed ? 'all essential sources present' : 'the server does not claim the declared profile';

  return (
    <div className={`dc${stale ? ' is-stale' : ''}`} data-testid="display-client">
      <div className="dc-status">
        <b>Barge weather · live</b>
        <span data-testid="dc-status">{status}</span>
      </div>
      {banner && <div className={`dc-banner${phase === 'unreachable' ? ' bad' : ''}`} role="alert" data-testid="dc-banner">{banner}</div>}
      {!config ? <NotConfigured phase={phase} /> : config.rejected ? (
        // FR-41, AT-08: a contradicted profile claim is an error; the server is not used.
        <div className="dc-rejected" role="alert" data-testid="dc-rejected"><b>This server cannot be used.</b> {config.rejected}</div>
      ) : (
        <>
          {missing.length > 0 && (
            // FR-45: one warning after the handshake listing every unavailable essential source and why.
            <div className="dc-warning" role="alert" data-testid="dc-degraded">
              <b>Degraded mode.</b> Unavailable essential sources: {missing.map((p) => `${essentialLabel(p.essential)} (${p.reason}: ${p.detail})`).join('; ')}.
            </div>
          )}
          <Controls session={session} props={props} />
          {commandNote && <div className="dc-banner bad">{commandNote}</div>}
          <Views session={session} props={props} sel={sel.props} />
        </>
      )}
    </div>
  );
}

function NotConfigured({ phase }: { phase: string }) {
  return (
    <div className="dc-waiting" data-testid="dc-waiting">
      <div className="dc-waiting-text">{phase === 'waiting-models' ? <ModelsCatchingUp />
        : phase === 'waiting-play' ? <>Waiting for the simulation clock. Press <b>▶ Play</b>: the display client starts with the rest of the system and makes its handshake.</>
        : phase === 'unreachable' ? <>The server does not answer. Retrying on the simulation clock.</>
          : <>Handshake: discovering what the server offers (landing page, conformance, profile, systems, datastreams, schemas)…</>}</div>
    </div>
  );
}

/** The models catch up on history before they publish; their progress, shown honestly. */
function ModelsCatchingUp() {
  const control = useStore(runtime.control);
  const workers = useStore(runtime.modelWorkers);
  const models = control?.models ?? [];
  return (
    <div>
      <p>Waiting for the core models to register their datastreams with the data server before the handshake.</p>
      <ul className="dc-models">
        {models.map((m) => <li key={m.id}><b>{m.label}</b>: {m.phase}{m.detail ? ` · ${m.detail}` : ''}</li>)}
        {!models.length && Object.entries(workers).map(([id, w]) => <li key={id}><b>{id}</b>: {w.phase}{w.detail ? ` · ${w.detail}` : ''}</li>)}
      </ul>
    </div>
  );
}

function Controls({ session, props }: { session: ClientSession; props: Property[] }) {
  const sel = useStore(session.selection);
  const config = session.config.value;
  const algos = algorithms(config?.clustering?.fields);
  const clustersOff = session.unavailableViews().get('clusters');
  return (
    <>
      <div className="dc-row">
        <span className="dc-label">Fields</span>
        <div className="chips" role="group" aria-label="Fields">
          {props.map((p) => {
            const on = sel.props.includes(p.key);
            return (
              <button key={p.key} className={`chip${on ? ' on' : ''}${p.essential ? '' : ' optional'}`} aria-pressed={on} data-testid="chip"
                disabled={!!p.unavailable} title={p.unavailable ? `Unavailable: ${p.unavailable}` : `${p.label}${p.uom ? ` (${p.uom})` : ''} · ${p.type}`}
                onClick={() => session.toggleProp(p.key)}>
                {p.label}{p.essential ? '' : ' · optional'}
              </button>
            );
          })}
        </div>
      </div>
      <div className="dc-row">
        <span className="dc-label">Period</span>
        <div className="presets" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.id} className={`preset${sel.period === p.id ? ' on' : ''}`} aria-pressed={sel.period === p.id} onClick={() => session.select({ period: p.id })}>{p.label}</button>
          ))}
        </div>
        <span className="spacer" />
        <label className="dc-label" htmlFor="dc-algo">Clustering</label>
        <select id="dc-algo" value={sel.algorithm} disabled={!!clustersOff} title={clustersOff ? `Unavailable: ${clustersOff.join(', ')}` : undefined}
          onChange={(e) => session.select({ algorithm: e.target.value })} data-testid="algorithm">
          {algos.map((a) => <option key={a} value={a}>Algorithm {a}</option>)}
        </select>
      </div>
    </>
  );
}

/** The algorithms offered, from the control stream's schema (its allowed values), else A, B, C. */
function algorithms(fields: { name: string; constraint?: unknown }[] | undefined): string[] {
  const f = fields?.find((x) => x.name === 'algorithm');
  const c = f?.constraint as { values?: string[]; tokens?: string[] } | undefined;
  return c?.values ?? c?.tokens ?? ['A', 'B', 'C'];
}

function Views({ session, props, sel }: { session: ClientSession; props: Property[]; sel: string[] }) {
  const chosen = sel.map((k) => props.find((p) => p.key === k)).filter((p): p is Property => !!p && !p.unavailable);
  const off = session.unavailableViews();
  const graphsOff = off.get('graphs');
  const changesOff = off.get('changes');
  const clustersOff = off.get('clusters');
  const period = PERIOD_SUB[session.selection.value.period];
  const first = chosen.find((p) => p.kind !== 'band');
  const noField = <Empty>No field selected. Choose one or more fields above to plot them.</Empty>;
  const unavailable = (why: string[]) => <Empty>Unavailable: this view depends on {why.join(', ')}.</Empty>;
  const loading = chosen.length > 0 && !session.plan.length;
  const labelOf = (name: string) => props.find((p) => p.name === name)?.label ?? name;
  return (
    <>
      <div className="dc-graphs">
        <ViewFrame title="Line plot" sub={`normalised · ${period}`} testid="view-line">
          {graphsOff ? unavailable(graphsOff) : !chosen.length ? noField : loading ? <Empty>Reading…</Empty> : (
            <>
              <LinePlot session={session} props={chosen} changesNote={changesOff ? changesOff.join(', ') : null} />
              {changesOff && <p className="dc-note">Change marks unavailable: {changesOff.join(', ')}.</p>}
            </>
          )}
        </ViewFrame>
        <ViewFrame title="Line plot with error bars" sub={first ? `${first.label.toLowerCase()} · mean ± 1σ` : 'mean ± 1σ'} testid="view-errorbars">
          {graphsOff ? unavailable(graphsOff) : !chosen.length ? noField : !first ? <Empty>Error bars need a numeric field; the selected fields are categories.</Empty>
            : loading ? <Empty>Reading…</Empty> : <ErrorBars session={session} p={first} />}
        </ViewFrame>
        <ViewFrame title="Heat map" sub={`fields × time · ${session.plan.some((r) => r.raw) ? 'raw records' : 'summaries'}`} testid="view-heatmap">
          {graphsOff ? unavailable(graphsOff) : !chosen.length ? noField : loading ? <Empty>Reading…</Empty> : <HeatMap session={session} props={chosen} />}
        </ViewFrame>
      </div>
      <ViewFrame title="Clusters" sub="cluster assignments along time" testid="view-clusters" className="dc-clusters">
        {clustersOff ? unavailable(clustersOff) : !chosen.length ? noField : <ClusterBand session={session} labelOf={labelOf} />}
      </ViewFrame>
    </>
  );
}
