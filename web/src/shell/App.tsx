// The demonstrator shell (§9.1): top bar with title, subtitle and controls;
// the stacked flowchart on the left with status and key below it; the detail
// panel on the right. The shell frames the system and is not a component.
import { useEffect, useState } from 'react';
import { clientSession } from '../client/session';
import { RATES, STARTUP_BUDGET_MS } from '../config';
import { DetailPanel } from '../detail/DetailPanel';
import { ControlPanel } from './ControlPanel';
import { DemoBanner, DemoMenu } from './Demos';
import { Flowchart } from './Flowchart';
import { runtime } from './runtime';
import { selectComponent, unrevealAll } from './selection';
import { sketchEnabled } from './sketch';
import type { StepState } from './startup';
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
  // Until then the top bar is shown with its controls disabled, each saying why (FR-125a).
  const ready = progress.stage === 'ready';
  return (
    <div className="shell">
      <TopBar ready={ready} />
      {ready ? <Main /> : <Loading pct={progress.pct} detail={progress.detail} failure={failure} />}
    </div>
  );
}

const STEP_MARK: Record<StepState, string> = { pending: '○', active: '…', done: '✓', failed: '✗' };

function Loading({ pct, detail, failure }: { pct: number; detail: string; failure: string | null }) {
  const steps = useStore(runtime.startup.steps);
  const stall = useStore(runtime.startup.stall);
  return (
    <main className="startup" role="status" aria-live="polite">
      <p className="fiction">A fictional canal, fictional places and synthetic weather: a system and architecture demonstrator, not a weather or navigation product.</p>
      {/* NFR-10a: the loading progress names each step in turn. */}
      <ol className="steps" data-testid="startup-steps" aria-label="Startup steps">
        {steps.map((s) => (
          <li key={s.id} className={`step ${s.state}`} data-testid={`step-${s.id.replace(' ', '-')}`} data-state={s.state}
            aria-current={s.state === 'active' ? 'step' : undefined}>
            <span className="mark" aria-hidden="true">{STEP_MARK[s.state]}</span>
            <b>{s.id}</b>: {s.what}
          </li>
        ))}
      </ol>
      {stall && (
        <div className="stall" role="alert" data-testid="stall" data-step={stall.step}>
          <p><b>{stall.message}</b></p>
          <p>What you can do:</p>
          <ul>{stall.advice.map((a) => <li key={a}>{a}</li>)}</ul>
          <button className="btn" onClick={() => location.reload()} data-testid="stall-reload">Reload</button>
        </div>
      )}
      {failure && !stall?.failed ? <p className="error">Could not start: {failure}</p> : !failure && (
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

/**
 * Why a top-bar control cannot act yet (FR-125a, docs/v4-interfaces.md §13.7): in its
 * `title`, and to assistive technology through `aria-describedby`. Null when it can act.
 */
function useReason(ready: boolean): string | null {
  const steps = useStore(runtime.startup.steps);
  const stall = useStore(runtime.startup.stall);
  void steps;
  void stall;
  return ready ? null : runtime.startup.reason() ?? 'Starting';
}

/** Why the replay mirror cannot act (§13.7): before login, and with no dataset open. */
function useReplayReason(startup: string | null): string | null {
  const phase = useStore(clientSession.phase);
  const replay = useStore(clientSession.clock.state);
  if (startup) return startup;
  if (phase === 'login' || phase === 'locked') return 'Log in to the display client first';
  if (!replay) return 'Open a dataset first';
  return null;
}

const REASON_ID = 'control-reason';

/** Props that disable a control and say why, or nothing when it can act. */
function disabledBy(reason: string | null) {
  return reason ? { disabled: true, title: reason, 'aria-describedby': REASON_ID } : {};
}

function TopBar({ ready }: { ready: boolean }) {
  const replay = useStore(clientSession.clock.state);
  const control = useStore(runtime.control);
  const [drawer, setDrawer] = useState(false);
  const reason = useReason(ready);
  const off = disabledBy(reason);
  const replayReason = useReplayReason(reason);
  const replayOff = replayReason === reason ? off : { disabled: true, title: replayReason!, 'aria-describedby': 'replay-reason' };
  const playing = replay?.playing ?? false;
  const rate = replay?.rate ?? null;
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <h1>{TITLE}</h1>
          <p className="subtitle">Architecture view · click a component or a message to see it on the right</p>
          {runtime.kind === 'standin' && <p className="standin-notice" data-testid="standin-notice">{STANDIN_NOTICE}</p>}
        </div>
        <nav className="controls" aria-label="Controls" data-testid="controls">
          {reason && <span id={REASON_ID} className="sr-only" data-testid="control-reason">{reason}</span>}
          {replayReason && replayReason !== reason && <span id="replay-reason" className="sr-only" data-testid="replay-reason">{replayReason}</span>}
          {/* §8.6, interfaces §8: a mirror of the display client's replay bar, driving its own clock in the page. */}
          <button className={`btn play${playing ? '' : ' primary'}`} onClick={() => (playing ? clientSession.pause() : clientSession.play())} data-testid="play" {...replayOff}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <div className="segmented" role="group" aria-label="Replay rate" data-testid="speed">
            {RATES.map((r) => (
              <button key={r} className={`btn${r === rate ? ' on' : ''}`} aria-pressed={r === rate} onClick={() => clientSession.setRate(r)} data-testid={`speed-${r}`} {...replayOff}>{r}×</button>
            ))}
          </div>
          {/* FR-46, FR-75: discard all client state, credentials included; un-reveal. */}
          <button className="btn" data-testid="restart-client" onClick={() => {
            clientSession.restart();
            unrevealAll();
            selectComponent(null);
          }} {...off}>Restart client</button>
          <button className={`btn${control?.pending ? ' attention' : ''}`} data-testid="restart-server" onClick={() => runtime.send('restart-server')}
            title={control?.pending ? 'Field changes are pending until the next server start' : undefined} {...off}>Restart server</button>
          <DemoMenu reason={reason} />
          <button className="btn" onClick={() => setDrawer(!drawer)} aria-expanded={drawer} data-testid="control-panel-toggle" {...off}>Control panel</button>
          <button className="btn" onClick={() => selectComponent(null)} data-testid="overview-button" title="What is adopted, what is written, what is not here" {...off}>Overview</button>
        </nav>
        {ready && <DemoBanner />}
      </header>
      {ready && drawer && <ControlPanel onClose={() => setDrawer(false)} />}
    </>
  );
}

function Main() {
  return (
    <div className="main">
      <section className="left" aria-label="Architecture">
        <Flowchart />
      </section>
      <DetailPanel />
    </div>
  );
}
