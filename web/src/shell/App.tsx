// The demonstrator shell (§9.1): top bar with title, subtitle and controls;
// the stacked flowchart on the left with status and key below it; the detail
// panel on the right. The shell frames the system and is not a component.
// With `?hand-made` it opens on the adoption opening (SRD §9.8): only the title
// in the top bar, and nothing started until the viewer adopts (FR-122, FR-125).
import { useEffect, useState } from 'react';
import { clientSession } from '../client/session';
import { RATES, STARTUP_BUDGET_MS } from '../config';
import { DetailPanel } from '../detail/DetailPanel';
import { drawClock } from './drawclock';
import { ControlPanel } from './ControlPanel';
import { DemoBanner, DemoMenu } from './Demos';
import { Flowchart } from './Flowchart';
import { opening } from './opening';
import { runtime } from './runtime';
import { selectComponent, unrevealAll } from './selection';
import { sketchEnabled } from './sketch';
import { useStore } from './store';

const TITLE = 'Canal barge weather demonstrator';
/** FR-06h: the notice under the title in stand-in mode, word for word. */
export const STANDIN_NOTICE = 'Running the JavaScript stand-in: the architecture, interface and messages are the real design; the models’ results are illustrative.';

export function App() {
  const progress = useStore(runtime.progress);
  const phase = useStore(opening.phase);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('sketch-off', !sketchEnabled);
    const start = () => {
      runtime.start().catch((e) => setFailure(String(e?.message ?? e)));
    };
    // FR-122: in the adoption opening the back end does not start (no worker, no relay)
    // until hand-over (FR-125); without the flag it starts at once, as before.
    if (opening.phase.value === 'off') start();
    else opening.onHandOver(start);
  }, []);
  useEffect(() => {
    if (progress.stage === 'error') setFailure(progress.detail);
  }, [progress]);

  // FR-15: the flowchart becomes available when the back end has loaded. In the opening the
  // flowchart is shown at once, and after hand-over the loading progress shows in the top bar.
  if (phase === 'off' && progress.stage !== 'ready') return <Loading pct={progress.pct} detail={progress.detail} failure={failure} />;
  return <Shell failure={failure} />;
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
            starting the data server and importing Mission A from the data folder, silently, as it does at every load. The flowchart opens
            when it has finished (budget {STARTUP_BUDGET_MS / 1000} s).</p>
        </>
      )}
    </main>
  );
}

function Shell({ failure }: { failure: string | null }) {
  const phase = useStore(opening.phase);
  // FR-122: before hand-over the top bar renders only the title: no controls and no banner.
  const running = phase === 'off' || phase === 'adopted';
  return (
    <div className="shell" data-opening={phase}>
      <header className="topbar">
        <div className="brand">
          <h1>{TITLE}</h1>
          {running ? <p className="subtitle">Architecture view · click a component or a message to see it on the right · <span data-testid="godseye-note">a god's-eye view: every message in this synthetic system is drawn, whoever is logged in; the display client shows only what its user may see</span></p>
            : <p className="subtitle placeholder" aria-hidden="true">&nbsp;</p>}
          {running && runtime.kind === 'standin' && <p className="standin-notice" data-testid="standin-notice">{STANDIN_NOTICE}</p>}
          {/* Before hand-over the lines below the title are empty, not absent: the top bar keeps its height,
              so the flowchart does not move or rescale when the controls and banner appear (FR-125). */}
          {!running && runtime.kind === 'standin' && <p className="standin-notice placeholder" aria-hidden="true">&nbsp;</p>}
        </div>
        {running && <TopControls />}
        {running && <HandOverProgress failure={failure} />}
      </header>
      <div className="main">
        <section className="left" aria-label="Architecture">
          <Flowchart />
        </section>
        <DetailPanel />
      </div>
    </div>
  );
}

/** FR-125, NFR-10: after the opening's hand-over the back end loads with the usual progress, shown in the top bar. */
function HandOverProgress({ failure }: { failure: string | null }) {
  const progress = useStore(runtime.progress);
  if (opening.phase.value !== 'adopted' || (progress.stage === 'ready' && !failure)) return null;
  return (
    <div className="handover-progress" role="status" aria-live="polite" data-testid="handover-progress">
      {failure ? <p className="error">Could not start: {failure}</p> : (
        <>
          <progress max={100} value={progress.pct} aria-label="Loading" />
          <p data-testid="progress">{progress.detail}</p>
        </>
      )}
    </div>
  );
}

function TopControls() {
  const replay = useStore(clientSession.replay);
  const phase = useStore(clientSession.phase);
  const control = useStore(runtime.control);
  const frozen = useStore(drawClock.frozen);
  const [drawer, setDrawer] = useState(false);
  const playing = replay?.playing ?? false;
  const rate = replay?.rate ?? null;
  // §9.1: a mirror of the display client's replay bar, acting through the display client (C4).
  const ready = phase === 'ready' && !!replay?.dataset;
  return (
    <>
        <nav className="controls" aria-label="Controls">
          <button className={`btn play${playing ? '' : ' primary'}`} disabled={!ready} onClick={() => (playing ? clientSession.pause() : clientSession.play())} data-testid="play"
            title={ready ? 'Sent by the display client, as a command to the replay controller' : 'Log in to the display client first'}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <div className="segmented" role="group" aria-label="Replay rate" data-testid="speed">
            {RATES.map((r) => (
              <button key={r} className={`btn${r === rate ? ' on' : ''}`} aria-pressed={r === rate} disabled={!ready} onClick={() => clientSession.setRate(r)} data-testid={`speed-${r}`}>{r}×</button>
            ))}
          </div>
          {/* FR-92: Freeze holds the whole demonstrator still for inspection. */}
          <button className={`btn${frozen ? ' attention' : ''}`} aria-pressed={frozen} onClick={() => void runtime.freeze(!frozen)} data-testid="freeze">{frozen ? 'Unfreeze' : 'Freeze'}</button>
          {/* FR-46, FR-75: discard all client state, credentials included; un-reveal. */}
          <button className="btn" data-testid="restart-client" onClick={() => {
            clientSession.restart();
            unrevealAll();
            selectComponent(null);
          }}>Restart client</button>
          <button className={`btn${control?.pending ? ' attention' : ''}`} data-testid="restart-server" onClick={() => void runtime.control('restart-server')}
            title={control?.pending ? 'Field changes are pending until the next server start' : undefined}>Restart server</button>
          <DemoMenu />
          <button className="btn" onClick={() => setDrawer(!drawer)} aria-expanded={drawer} data-testid="control-panel-toggle">Control panel</button>
          <button className="btn" onClick={() => {
            opening.dismissPanel();
            selectComponent(null);
          }} data-testid="overview-button" title="What is adopted, what is written, what is not here">Overview</button>
        </nav>
        <DemoBanner />
        {drawer && <ControlPanel onClose={() => setDrawer(false)} />}
    </>
  );
}
