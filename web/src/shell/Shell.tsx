// The demonstrator shell (B-C15): the frame around everything (Annex A §A.8).
// Top bar; the flowchart with a side column; the tour strip; the display
// client's three docked panels.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DisplayClient } from '../client/DisplayClient';
import { HOP_S, STARTUP_BUDGET_MS } from '../config';
import { simClock } from './clock';
import { ControlPanel } from './ControlPanel';
import { Flowchart } from './Flowchart';
import { bus } from './messages';
import { runtime } from './runtime';
import { Side } from './Side';
import { sketchEnabled } from './sketch';
import { clientStatus } from './status';
import { useStore } from './store';
import { TOUR, TourStrip } from './Tour';

function params() {
  const q = new URLSearchParams(location.search);
  const seed = q.get('seed');
  const days = q.get('pregen');
  return { seed: seed && /^\d+$/.test(seed) ? Number(seed) : null, pregen: days ? Number(days) : null };
}

const SPEED_LABELS: Record<number, string> = { 0.1: '⅒×', 0.25: '¼×', 0.5: '½×', 1: '1×', 2: '2×' };
const n = (k: string, c: Record<string, number>) => Object.entries(c).filter(([key]) => key.startsWith(k)).reduce((a, [, v]) => a + v, 0);

/** One live line per card, from the state the shell can see (A.4; the reference demonstrator). */
function useCardStatus(): Record<string, string> {
  const [, tick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => tick((t) => t + 1), 500);
    return () => clearInterval(h);
  }, []);
  const ctl = runtime.control.value;
  const clock = simClock.state.value;
  const c = bus.counts.value;
  const cl = clientStatus.value;
  const sim = runtime.backendKind.value === 'simulation';
  const ws = runtime.wsProgress.value;
  const server = runtime.server.value;
  const mb = ctl ? (ctl.store.bytes / 1e6).toFixed(0) : '0';
  const progress = ctl?.progress;
  return {
    clock: clock?.playing ? `playing · ${SPEED_LABELS[clock.rate] ?? clock.rate + '×'}` : 'paused',
    barge: 'position never recorded',
    sensors: `${(ctl?.store.records ?? 0).toLocaleString()} records`,
    world: `seed ${runtime.seed}`,
    logger: sim ? 'illustrative' : `${ctl?.store.files ?? 0} files · ${mb} MB`,
    adapter: server === 'waiting' && progress ? `indexing ${Math.round((100 * progress.indexed) / Math.max(1, progress.stored))}%` : `index ${(progress?.indexed ?? 0).toLocaleString()}`,
    server: server === 'down' ? 'down' : server === 'waiting' ? 'waiting · 503' : `ready · ${ctl?.instance ?? ''}`,
    analysis: `${n('server>analysis:', c)} calls`,
    fastapi: `${n('relay>fastapi:', c)} requests`,
    scilibs: `${n('analysis>scilibs:', c)} calls`,
    runtime: sim ? 'WebAssembly blocked' : 'Pyodide 0.29.5',
    relay: `${n('client>relay:', c) + n('workspace>relay:', c) + n('products>relay:', c)} requests`,
    client: cl.phase === 'running' ? `configured · ${cl.instance ?? ''}` : cl.phase === 'degraded' ? `degraded · ${cl.essentialsMissing} missing` : cl.phase,
    workspace: sim ? 'unavailable (no WebAssembly)' : ws?.stage === 'ready' ? 'ready' : 'loading',
    products: n('products>relay:', c) ? `${n('products>relay:', c)} requests` : 'none registered',
    shell: 'outside the system',
  };
}

export function Shell() {
  const { seed, pregen } = useMemo(params, []);
  const progress = useStore(runtime.progress);
  const clock = useStore(simClock.state);
  const control = useStore(runtime.control);
  const [clientKey, setClientKey] = useState(1);
  const [tour, setTour] = useState<number | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = progress.stage === 'ready';
  const status = useCardStatus();

  useEffect(() => {
    document.documentElement.classList.toggle('sketch-off', !sketchEnabled);
    runtime.start(seed, pregen).catch((e) => setFailure(String(e)));
  }, [seed, pregen]);
  useEffect(() => {
    if (progress.stage === 'error') setFailure(progress.detail);
  }, [progress]);
  useEffect(() => {
    if (control?.capture_counts) bus.setCounts(control.capture_counts);
  }, [control?.capture_counts]);

  const restartClient = useCallback(() => {
    bus.add([{ t: simClock.now(), src: 'shell', dst: 'client', letter: 'I', summary: 'restart client', content: 'discard all client state; handshake again', chain: null, hop: 0 }]);
    setClientKey((k) => k + 1);
  }, []);

  if (!ready) {
    return (
      <div className="startup" role="status">
        <h1>Canal barge weather demonstrator</h1>
        <p className="fiction">A fictional canal, fictional places and synthetic weather. A system and architecture demonstrator, not a weather or navigation product.</p>
        {failure ? <p className="error">Could not start: {failure}</p> : (
          <>
            <progress max={100} value={progress.pct} />
            <p data-testid="progress">{progress.detail}</p>
            <p className="hint">Everything runs in this tab. The logger store first receives its history (four weeks when published), made by the same sensors-to-logger path at build time and shipped in the logger's own format (budget {STARTUP_BUDGET_MS / 1000} s). Messages are only counted during this phase; the flowchart opens when it ends.</p>
          </>
        )}
      </div>
    );
  }

  const playing = clock?.playing ?? false;
  const simulated = runtime.backendKind.value === 'simulation';
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>Canal barge weather demonstrator</h1>
          <p>Architecture view · every message is real, captured at a component boundary · fictional canal, synthetic weather</p>
        </div>
        <div className="controls" aria-label="Controls">
          <button className={`play ${playing ? '' : 'inviting'}`} onClick={() => runtime.send(playing ? 'pause' : 'play')} data-testid="play">{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <button onClick={() => (simClock.step += HOP_S)} disabled={playing} title="Advance the flowchart one hop while paused">Step</button>
          <div className="segmented" role="group" aria-label="Speed" data-testid="speed">
            {clock?.rates.map((r) => (
              <button key={r} aria-pressed={r === clock.rate} className={r === clock.rate ? 'on' : ''} onClick={() => runtime.send('rate', r)}>{SPEED_LABELS[r] ?? `${r}×`}</button>
            ))}
          </div>
          <button onClick={restartClient} data-testid="restart-client">Restart client</button>
          <button onClick={() => runtime.send('restart-server')} data-testid="restart-server" className={control?.pending ? 'attention' : ''}>Restart server</button>
          <button onClick={() => setDrawer(!drawer)} aria-expanded={drawer} data-testid="control-panel-toggle">Control panel</button>
        </div>
      </header>
      <p className={`backend ${simulated ? 'simulated' : ''}`} data-testid="backend" role="status">
        {simulated ? (
          <><b>Backend: illustrative JS simulation.</b> WebAssembly is blocked in this browser, so the Python backend (Pyodide) cannot run.
            A simplified simulation answers the same Connected Systems interface instead: its readings and analysis are illustrative and unscored,
            and the Python workspace is unavailable. To see the real system, allow WebAssembly for this site (in Microsoft Edge: Settings → Privacy,
            search and services → Security → "Enhance your security on the web": add an exception or choose Balanced) and reload.</>
        ) : (
          <><b>Backend: Python (Pyodide)</b>: the real Connected Systems server, store and analysis, running in this tab.</>
        )}
      </p>
      {drawer && <ControlPanel />}
      <div className="main">
        <section className="flow-panel" aria-label="Architecture">
          <Flowchart highlight={tour == null ? '' : TOUR[tour].nodes.join(',')} simulated={simulated} status={status} />
        </section>
        <Side />
      </div>
      <TourStrip step={tour} setStep={setTour} />
      <div className="dock">
        <DisplayClient key={clientKey} onRestart={restartClient} />
      </div>
      <footer className="hint">Started in {((runtime.readyMs ?? 0) / 1000).toFixed(1)} s · seed {runtime.seed} · backend {simulated ? 'JS simulation' : 'Python'} · history {runtime.historySource} · <a href="../">requirements</a> · <a href="../annex-a.html">visual style</a> · {bus.total.toLocaleString()} messages drawn</footer>
    </div>
  );
}
