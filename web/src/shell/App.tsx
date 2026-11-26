// The demonstrator shell (§9.1): top bar with title, subtitle and controls;
// the stacked flowchart on the left with status and key below it; the detail
// panel on the right. The shell frames the system and is not a component.
import { useEffect, useState } from 'react';
import { restartClient } from '../client/session';
import { STARTUP_BUDGET_MS } from '../config';
import { DetailPanel } from '../detail/DetailPanel';
import { simClock } from './clock';
import { ControlPanel } from './ControlPanel';
import { DemoBanner, DemoMenu } from './Demos';
import { Flowchart } from './Flowchart';
import { runtime } from './runtime';
import { selectComponent, unrevealAll } from './selection';
import { sketchEnabled } from './sketch';
import { SPEED_LABELS } from './StatusBox';
import { useStore } from './store';

const TITLE = 'Canal barge weather demonstrator';
/** FR-06h: the notice under the title in stand-in mode, word for word. */
export const STANDIN_NOTICE = 'Running the JavaScript stand-in: the architecture, interface and messages are the real design; the models’ results are illustrative.';

export function App() {
  const progress = useStore(runtime.progress);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('sketch-off', !sketchEnabled);
    runtime.start().catch((e) => setFailure(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    if (progress.stage === 'error') setFailure(progress.detail);
  }, [progress]);

  // FR-15: the flowchart becomes available when the back end has loaded the history.
  if (progress.stage !== 'ready') return <Loading pct={progress.pct} detail={progress.detail} failure={failure} />;
  return <Shell />;
}

function Loading({ pct, detail, failure }: { pct: number; detail: string; failure: string | null }) {
  return (
    <main className="startup" role="status" aria-live="polite">
      <h1>{TITLE}</h1>
      <p className="fiction">A fictional canal, fictional places and synthetic weather: a system and architecture demonstrator, not a weather or navigation product.</p>
      {runtime.kind === 'standin' && <p className="standin-notice">{STANDIN_NOTICE}</p>}
      {failure ? <p className="error">Could not start: {failure}</p> : (
        <>
          <progress max={100} value={pct} aria-label="Loading" />
          <p data-testid="progress">{detail}</p>
          <p className="hint">Everything runs in this tab. The {runtime.kind === 'python' ? 'Python back end (Pyodide)' : 'JavaScript stand-in'} is
            loading the logger store's pre-calculated history, in the store's own format. The flowchart opens when it has finished
            (budget {STARTUP_BUDGET_MS / 1000} s).</p>
        </>
      )}
    </main>
  );
}

function Shell() {
  const clock = useStore(simClock.state);
  const control = useStore(runtime.control);
  const [drawer, setDrawer] = useState(false);
  const playing = clock?.playing ?? false;
  const rate = clock?.rate ?? 0.5;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>{TITLE}</h1>
          <p className="subtitle">Architecture view · click a component or a message to see it on the right</p>
          {runtime.kind === 'standin' && <p className="standin-notice" data-testid="standin-notice">{STANDIN_NOTICE}</p>}
        </div>
        <nav className="controls" aria-label="Controls">
          {/* FR-77: one play/pause button starts and stops the simulation clock. */}
          <button className={`btn play${playing ? '' : ' primary'}`} onClick={() => runtime.send(playing ? 'pause' : 'play')} data-testid="play">
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <div className="segmented" role="group" aria-label="Speed" data-testid="speed">
            {simClock.rates.map((r) => (
              <button key={r} className={`btn${r === rate ? ' on' : ''}`} aria-pressed={r === rate} onClick={() => runtime.send('rate', r)}>{SPEED_LABELS[r] ?? `${r}×`}</button>
            ))}
          </div>
          {/* FR-46, FR-75: discard all client state, handshake again, un-reveal. */}
          <button className="btn" data-testid="restart-client" onClick={() => {
            restartClient();
            unrevealAll();
            selectComponent(null);
          }}>Restart client</button>
          <button className={`btn${control?.pending ? ' attention' : ''}`} data-testid="restart-server" onClick={() => runtime.send('restart-server')}
            title={control?.pending ? 'Field changes are pending until the next server start' : undefined}>Restart server</button>
          <DemoMenu />
          <button className="btn" onClick={() => setDrawer(!drawer)} aria-expanded={drawer} data-testid="control-panel-toggle">Control panel</button>
          <button className="btn" onClick={() => selectComponent(null)} data-testid="overview-button" title="What is adopted, what is written, what is not here">Overview</button>
        </nav>
        <DemoBanner />
      </header>
      {drawer && <ControlPanel onClose={() => setDrawer(false)} />}
      <div className="main">
        <section className="left" aria-label="Architecture">
          <Flowchart />
        </section>
        <DetailPanel />
      </div>
    </div>
  );
}
