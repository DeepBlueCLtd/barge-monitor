// The demonstrator shell (§9.1): top bar with title, subtitle and controls;
// the stacked flowchart on the left with status and key below it; the detail
// panel on the right. The shell frames the system and is not a component.
// With `?hand-made` it opens on the adoption opening (SRD §9.8): only the title in the
// top bar, and nothing started until the viewer adopts (FR-122). At hand-over the back
// end starts with the usual named loading steps (FR-125, NFR-10a, D-332).
import { useEffect, useState } from 'react';
import { clientSession } from '../client/session';
import { RATES, STARTUP_BUDGET_MS } from '../config';
import { DetailPanel } from '../detail/DetailPanel';
import { ControlPanel } from './ControlPanel';
import { DemoBanner, DemoMenu } from './Demos';
import { Flowchart } from './Flowchart';
import { opening } from './opening';
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
  const phase = useStore(opening.phase);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('sketch-off', !sketchEnabled);
    const start = () => {
      runtime.start().catch((e) => setFailure(String(e?.message ?? e)));
    };
    // FR-122: in the adoption opening the back end does not start (no worker, no relay) until
    // hand-over (FR-125); without the flag it starts at once (FR-77).
    if (opening.phase.value === 'off') start();
    else opening.onHandOver(start);
  }, []);
  useEffect(() => {
    if (progress.stage === 'error') setFailure(progress.detail);
  }, [progress]);

  // FR-122: before hand-over, the opening: the title alone in the top bar, the flowchart and its panel.
  if (opening.active) {
    return (
      <div className="shell" data-opening={phase}>
        <OpeningTopBar />
        <Main />
      </div>
    );
  }
  // FR-15: the flowchart becomes available when the server answers, Mission A imported silently.
  // Until then the top bar is shown with its controls disabled, each saying why (FR-125a). After
  // the opening's hand-over this is the same startup as a load without the flag (FR-125, D-332).
  const ready = progress.stage === 'ready';
  return (
    <div className="shell" data-opening={phase}>
      <TopBar ready={ready} />
      {ready ? <Main /> : <Loading pct={progress.pct} detail={progress.detail} failure={failure} />}
    </div>
  );
}

/**
 * FR-122: in the opening the top bar holds the title only: no control and no stand-in notice in the page. The lines
 * below the title are kept empty, not removed, so the top bar keeps its height and the flowchart does not rescale
 * when the controls and the notice appear at hand-over.
 */
function OpeningTopBar() {
  return (
    <header className="topbar">
      <div className="brand">
        <h1>{TITLE}</h1>
        <p className="subtitle placeholder" aria-hidden="true">&nbsp;</p>
        {runtime.kind === 'standin' && <p className="standin-notice placeholder" aria-hidden="true">&nbsp;</p>}
      </div>
    </header>
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
            starting the data server, whose CSV importer imports Mission A from the data folder before the server answers. The flowchart
            opens when it has (budget {STARTUP_BUDGET_MS / 1000} s).</p>
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
  useStore(clientSession.selection);
  if (startup) return startup;
  if (phase === 'login' || phase === 'locked') return 'Log in to the display client first';
  if (!replay) return 'Open a dataset first';
  return clientSession.replayOff();
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
          {/* §8.6, interfaces §8: a mirror of the display client's replay bar, driving its own clock in the page. */}
          <button className={`btn play${playing ? '' : ' primary'}`} onClick={() => (playing ? clientSession.pause() : clientSession.play())} data-testid="play" {...replayOff}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <div className="segmented" role="group" aria-label="Replay rate" data-testid="speed">
            {RATES.map((r) => (
              <button key={r} className={`btn${r === rate ? ' on' : ''}`} aria-pressed={r === rate} onClick={() => clientSession.setRate(r)} data-testid={`speed-${r}`} {...replayOff}>{r}×</button>
            ))}
          </div>
          {/* FR-46, FR-75: discard all client state, credentials included; un-reveal. §9.1: Restart client and Restart server are here, in the top bar. */}
          <button className="btn" data-testid="restart-client" onClick={() => {
            clientSession.restart();
            unrevealAll();
            selectComponent(null);
          }} {...off}>Restart client</button>
          <button className={`btn${control?.pending ? ' attention' : ''}`} data-testid="restart-server" onClick={() => runtime.send('restart-server')}
            title={control?.pending ? 'Field changes are pending until the next server start' : undefined} {...off}>Restart server</button>
          <DemoMenu reason={reason} />
          <button className="btn" onClick={() => setDrawer(!drawer)} aria-expanded={drawer} data-testid="control-panel-toggle" {...off}>Control panel</button>
          <button className="btn" onClick={() => {
            opening.dismissPanel(); // FR-125: the overview closes the opening's savings
            selectComponent(null);
          }} data-testid="overview-button" title="What is adopted, what is written, what is not here" {...off}>Overview</button>
          {/* A quick way back to the pre-OSH stage: reload this page with the adoption opening's flag (§9.8). */}
          <a className="btn" href={customBackendHref()} data-testid="custom-backend-link"
            title="Reload on the opening: the data server written ourselves, before adopting OpenSensorHub">Custom backend</a>
          {/* FR-125a: why controls are disabled, in sight. A browser shows no tooltip on a disabled button, so a title alone is not enough. */}
          {reason && <p id={REASON_ID} className="control-reason" data-testid="control-reason">{reason}</p>}
          {replayReason && replayReason !== reason && <p id="replay-reason" className="control-reason" data-testid="replay-reason">Play and speed: {replayReason}</p>}
        </nav>
        {ready && <DemoBanner />}
      </header>
      {ready && drawer && <ControlPanel onClose={() => setDrawer(false)} />}
    </>
  );
}

/** This page with `?hand-made` added, keeping its other parameters (e.g. ?backend=). */
function customBackendHref(): string {
  const params = new URLSearchParams(location.search);
  params.set('hand-made', '');
  return `${location.pathname}?${params.toString().replace('hand-made=', 'hand-made')}${location.hash}`;
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
