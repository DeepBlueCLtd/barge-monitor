// Models panel (FR-71, mockup 2): the Models component in gold with its
// description; beneath it, joined by lines, the models as cards in one row
// (Data cleanse, Model A, Model B registered; Model C, Model D empty slots),
// each with a diamond (FR-76); three steps for adding a model; and the line
// stating that each model runs in its own worker. Selecting an empty slot opens
// the Python editor (FR-36), which needs the Python back end (FR-06f).
import { Diamond } from '../shell/Diamond';
import { runtime } from '../shell/runtime';
import { openSlot } from '../shell/selection';
import { useStore } from '../shell/store';
import { ModelActivity } from './ModelActivity';
import { ModelEditor } from './ModelEditor';

interface Slot {
  id: string;
  label: string;
  core: boolean;
  sub: string;
  text: string;
}

const SLOTS: Slot[] = [
  { id: 'data-cleanse', label: 'Data cleanse', core: true, sub: 'core model · runs first', text: 'Flags and removes noise before any other model sees the data.' },
  { id: 'model-a', label: 'Model A', core: true, sub: 'core model · registered', text: 'Live. Publishes its own datastreams.' },
  { id: 'model-b', label: 'Model B', core: true, sub: 'core model · registered', text: 'Live. Publishes its own datastreams.' },
  { id: 'model-c', label: 'Model C', core: false, sub: 'empty slot', text: 'Room for a new model. Appears at the next handshake.' },
  { id: 'model-d', label: 'Model D', core: false, sub: 'empty slot', text: 'Room for a new model. Appears at the next handshake.' },
];

const PHASE_WORDS: Record<string, string> = { loading: 'loading its worker', starting: 'starting its worker', failed: 'failed', waiting: 'waiting for the server' };

export function ModelsDetail() {
  const control = useStore(runtime.control);
  const workers = useStore(runtime.modelWorkers);
  const slot = useStore(openSlot);
  const standin = runtime.kind === 'standin';
  const phaseOf = (id: string): string | null => {
    const m = control?.models?.find((x) => x.id === id);
    const w = workers[id];
    const p = m?.phase ?? w?.phase;
    return p ? PHASE_WORDS[p] ?? p : null;
  };
  return (
    <div className="models-detail" data-testid="detail-models">
      <div className="models-main gold-box">
        <Diamond className="box-diamond" size={24} />
        <h3>★ Models</h3>
        <p className="va-line">our value-add · a home for models, each an OGC process system</p>
        <p>Hosts the models that turn sensor data into insight. Each model reads observations from the data server, registers its own
          datastreams there, and takes its settings as commands. The display client finds every model's output at its next handshake, with no
          new display code.</p>
      </div>
      <div className="model-links" aria-hidden="true"><span className="trunk" /><span className="bar" /></div>
      <div className="model-row">
        {SLOTS.map((s) => {
          // A model written in an empty slot becomes a registered model like any other.
          const registered = s.core || !!phaseOf(s.id);
          const phase = phaseOf(s.id);
          const Tag = s.core ? 'div' : 'button';
          return (
            <Tag key={s.id} className={`model-card${registered ? ' gold-box' : ' empty'}${slot === s.id ? ' open' : ''}`} data-testid={`model-${s.id}`}
              {...(s.core ? {} : { onClick: () => openSlot.set(slot === s.id ? null : s.id), 'aria-expanded': slot === s.id,
                'aria-label': `${s.label}${registered ? '' : ', empty slot: open the editor'}` })}>
              <span className="tick" />
              <Diamond className="box-diamond" size={20} />
              <b>{registered ? '★ ' : ''}{s.label}</b>
              <small>{registered && !s.core ? 'new model · registered' : s.sub}</small>
              <span className="model-text">{registered && !s.core ? 'Your model, in its own worker.' : s.text}</span>
              {registered && <ModelActivity model={s.id} />}
              {registered && <span className={`phase${phase === 'live' || (!phase && standin) ? ' live' : ''}`} data-testid={`phase-${s.id}`}>{phase ? `now: ${phase}` : standin ? 'now: running in the stand-in' : 'now: starting'}</span>}
            </Tag>
          );
        })}
      </div>
      {slot && (standin ? (
        <div className="editor-off" role="note" data-testid="editor-unavailable">
          <b>The model editor is unavailable here.</b> It runs Python in the browser (Pyodide), and this session is running the JavaScript
          stand-in because WebAssembly is blocked. The steps below are how a model is added; with the Python back end you can write one here.
        </div>
      ) : <ModelEditor slot={slot} />)}
      <div className="adding">
        <h4 className="small-caps">Adding a model</h4>
        <ol>
          <li><b>1 · Write it</b><span>Python, using the scientific libraries, reading observations from the data server.</span></li>
          <li><b>2 · Register it</b><span>As a process system with its own datastreams, using ordinary resource creation.</span></li>
          <li><b>3 · See it</b><span>Restart the display client: the new stream appears as a field, drawn by its schema type.</span></li>
        </ol>
      </div>
      <p className="footline">Each model runs in its own worker and reaches the data server only through its interface, so a failing model never stops the data server.</p>
    </div>
  );
}
