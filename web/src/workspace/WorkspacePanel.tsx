// The Python workspace panel: a CodeMirror editor whose scripts run in the
// workspace's own Pyodide worker (B-C12). The worker outlives the display
// client; so does the script being edited.
import { python } from '@codemirror/lang-python';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';
import { EXAMPLES, editorText } from './examples';

let runId = 0;

export function WorkspacePanel() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [out, setOut] = useState<{ kind: string; text: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [suite, setSuite] = useState<string | null>(null);
  const pending = useRef<number | null>(null);
  const progress = useStore(runtime.wsProgress);
  const ready = progress?.stage === 'ready';

  useEffect(() => {
    if (!host.current) return;
    view.current = new EditorView({
      doc: editorText.get(), parent: host.current,
      extensions: [basicSetup, python(), EditorView.updateListener.of((u) => u.docChanged && editorText.set(u.state.doc.toString()))],
    });
    return () => view.current?.destroy();
  }, []);

  useEffect(() => runtime.onWorkspace((m) => {
    if (m.type === 'stdout' || m.type === 'stderr') setOut((o) => [...o.slice(-200), { kind: m.type, text: m.text }]);
    if (m.type === 'done' && m.id === pending.current) {
      setRunning(false);
      setOut((o) => [...o, m.ok ? { kind: 'ok', text: `finished in ${(m.ms / 1000).toFixed(1)} s` } : { kind: 'error', text: m.error }]);
    }
    if (m.type === 'contract') {
      setRunning(false);
      if (m.error) setSuite(`error: ${m.error}`);
      else {
        const c = (k: string) => m.results.filter((r: any) => r.outcome === k).length;
        setSuite(`${c('passed')} passed, ${c('failed')} failed, ${c('skipped')} skipped`);
        m.results.filter((r: any) => r.outcome !== 'passed').forEach((r: any) => setOut((o) => [...o, { kind: 'error', text: `${r.test}: ${r.detail}` }]));
      }
    }
  }), []);

  const setCode = (c: string) => {
    editorText.set(c);
    view.current?.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: c } });
  };
  const run = () => {
    pending.current = ++runId;
    setRunning(true);
    setOut((o) => [...o, { kind: 'info', text: '— running —' }]);
    runtime.workspace?.postMessage({ type: 'run', id: runId, code: editorText.get() });
  };
  const stop = () => {
    runtime.restartWorkspace();
    setRunning(false);
    setOut((o) => [...o, { kind: 'error', text: 'workspace stopped and restarted; the backend was not touched' }]);
  };
  const contract = () => {
    setRunning(true);
    setSuite('running…');
    runtime.workspace?.postMessage({ type: 'contract', id: ++runId });
  };

  return (
    <div className="workspace">
      <header className="panel-head">
        <h2>Python workspace</h2>
        <span className="toggles">
          <select aria-label="Example script" onChange={(e) => setCode(EXAMPLES.find((x) => x.id === e.target.value)!.code)}>
            {EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
          <button onClick={run} disabled={!ready || running}>Run</button>
          <button onClick={stop} disabled={!running}>Stop</button>
          <button onClick={contract} disabled={!ready || running} title="AT-02: the contract suite, from this worker through the relay">Contract suite</button>
        </span>
      </header>
      {!ready && <p className="hint">Workspace: {progress?.detail ?? 'waiting for the backend'}…</p>}
      {suite && <p data-testid="contract-summary">Contract suite in the browser: {suite}</p>}
      <div className="editor" ref={host} aria-label="Python script" />
      <pre className="console" aria-label="Workspace output">{out.map((o, i) => <div key={i} className={o.kind}>{o.text}</div>)}</pre>
    </div>
  );
}
