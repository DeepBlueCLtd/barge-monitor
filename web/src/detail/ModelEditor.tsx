// The empty-slot model editor (FR-36, AT-13): CodeMirror 6 with Python mode,
// pre-filled with an example model. Run starts a new model worker with the code;
// the model registers itself like any other and appears in the display client
// at its next handshake (Restart client).
import { python } from '@codemirror/lang-python';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { EXAMPLE_MODEL, resolve } from '../config';
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';

/** The example is written for New model 1; for another slot its id and label are changed to match. */
function forSlot(code: string, slot: string): string {
  const letter = slot.slice(-1).toUpperCase();
  return code.replaceAll('new-model-1', slot).replaceAll('New model 1', `Model ${letter}`);
}

export function ModelEditor({ slot }: { slot: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workers = useStore(runtime.modelWorkers);
  const output = useStore(runtime.modelOutput).filter((o) => o.model === slot).slice(-40);
  const status = workers[slot];

  useEffect(() => {
    let cancelled = false;
    view.current = new EditorView({ doc: '# loading the example model…', extensions: [basicSetup, python(), EditorView.lineWrapping], parent: host.current! });
    fetch(resolve(EXAMPLE_MODEL))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${EXAMPLE_MODEL}: HTTP ${r.status}`))))
      .then((code) => {
        if (cancelled || !view.current) return;
        view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: forSlot(code, slot) } });
      })
      .catch((e) => !cancelled && setError(`Could not load the example model: ${e.message}`));
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [slot]);

  const run = () => {
    const code = view.current?.state.doc.toString() ?? '';
    if (!runtime.startModel(slot, code)) setError('The model editor needs the Python back end.');
  };

  return (
    <div className="editor" data-testid="model-editor">
      <div className="editor-head">
        <b>Model {slot.slice(-1).toUpperCase()}: write a model in Python</b>
        <span className="editor-status" data-testid="editor-status">{status ? `${status.phase}${status.detail ? ` · ${status.detail}` : ''}` : 'not running'}</span>
        <button className="btn primary" onClick={run} data-testid="run-model">{status ? 'Run again' : 'Run'}</button>
      </div>
      <div className="cm-host" ref={host} />
      {error && <p className="error">{error}</p>}
      {output.length > 0 && (
        <pre className="mono editor-out" data-testid="editor-output">
          {output.map((o, i) => <span key={i} className={o.stream}>{o.text}{o.text.endsWith('\n') ? '' : '\n'}</span>)}
        </pre>
      )}
      <p className="hint">Run starts the code in a new worker of its own. It registers with the data server as a process system; Restart client to see its output as a field.</p>
    </div>
  );
}
