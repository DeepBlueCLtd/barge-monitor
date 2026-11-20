// The demonstrator shell (B-C15): the frame around everything. The
// flowchart is the main view; the display client's panels dock around it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DisplayClient } from '../client/DisplayClient';
import { HOP_S, STARTUP_BUDGET_MS } from '../config';
import { simClock } from './clock';
import { ControlPanel } from './ControlPanel';
import { Flowchart } from './Flowchart';
import { Key } from './Key';
import { bus } from './messages';
import { runtime } from './runtime';
import { useStore } from './store';
import { Tour, TOUR } from './Tour';

function params() {
  const q = new URLSearchParams(location.search);
  const seed = q.get('seed');
  const days = q.get('pregen');
  return { seed: seed && /^\d+$/.test(seed) ? Number(seed) : null, pregen: days ? Number(days) : null };
}

export function Shell() {
  const { seed, pregen } = useMemo(params, []);
  const progress = useStore(runtime.progress);
  const clock = useStore(simClock.state);
  const control = useStore(runtime.control);
  const [clientKey, setClientKey] = useState(1);
  const [tour, setTour] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = progress.stage === 'ready';

  useEffect(() => {
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
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><h1>Canal barge weather demonstrator</h1><span className="fiction-inline">Fictional canal and places, synthetic weather</span></div>
        <div className="time" aria-label="Simulation clock">
          <button className="play" onClick={() => runtime.send(playing ? 'pause' : 'play')} data-testid="play">{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <button onClick={() => (simClock.step += HOP_S)} disabled={playing} title="Advance the flowchart one hop while paused">Step</button>
          <label>Speed{' '}
            <select value={clock?.rate} onChange={(e) => runtime.send('rate', Number(e.target.value))} data-testid="speed">
              {clock?.rates.map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
          </label>
          <span className="now" data-testid="sim-now">{simClock.iso().replace('T', ' ').replace('Z', ' UTC')}</span>
          <Tour step={tour} setStep={setTour} />
        </div>
      </header>
      <ControlPanel onRestartClient={restartClient} />
      <div className="dock">
        <section className="panel flow-panel" aria-label="Architecture">
          <Flowchart highlight={tour == null ? '' : TOUR[tour].nodes.join(',')} />
          <Key />
        </section>
        <DisplayClient key={clientKey} onRestart={restartClient} />
      </div>
      <footer className="hint">Started in {((runtime.readyMs ?? 0) / 1000).toFixed(1)} s · seed {runtime.seed} · history {runtime.historySource} · <a href="../">requirements</a> · {bus.total.toLocaleString()} messages drawn</footer>
    </div>
  );
}
