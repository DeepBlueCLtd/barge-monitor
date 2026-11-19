// The analyst's workspace (FR-27..FR-30): an in-browser Python editor running
// in its own worker, and the coverages its scripts promote.
import { useEffect, useRef, useState } from 'react';
import { api, Coverage } from '../api';
import { EXAMPLES } from '../examples';
import type { Seam } from '../seam';
import { CoverageView } from './CoverageView';

let runId = 0;

export function WorkspacePanel({ seam }: { seam: Seam }) {
  const [code, setCode] = useState(EXAMPLES[0].code);
  const [out, setOut] = useState<{ kind: string; text: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(seam.wsProgress);
  const [promoted, setPromoted] = useState<Record<string, Coverage>>({});
  const [promotedErr, setPromotedErr] = useState<string | null>(null);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    seam.startWorkspace();
    return seam.onWorkspace((m) => {
      if (m.type === 'progress') setProgress(m);
      if (m.type === 'stdout' || m.type === 'stderr') setOut((o) => [...o.slice(-300), { kind: m.type, text: m.text }]);
      if (m.type === 'done' && m.id === pending.current) {
        setRunning(false);
        setOut((o) => [...o, m.ok ? { kind: 'ok', text: `finished in ${(m.ms / 1000).toFixed(1)} s${m.result ? ` → ${m.result}` : ''}` } : { kind: 'error', text: m.error }]);
      }
    });
  }, [seam]);

  // Poll the workspace's promoted outputs, exactly as any other collection.
  useEffect(() => {
    const h = setInterval(async () => {
      try {
        const list = await api.ws<{ collections: { id: string }[] }>('collections');
        const next: Record<string, Coverage> = {};
        for (const c of list.collections) next[c.id] = await api.ws<Coverage>(`collections/${c.id}`);
        setPromoted(next);
        setPromotedErr(null);
      } catch (e) {
        setPromotedErr(String(e));
      }
    }, 2000);
    return () => clearInterval(h);
  }, []);

  function run() {
    pending.current = ++runId;
    setRunning(true);
    setOut((o) => [...o, { kind: 'info', text: '— running —' }]);
    seam.workspace?.postMessage({ type: 'run', id: runId, code });
  }

  function stop() {
    seam.restartWorkspace();
    setRunning(false);
    setPromoted({});
    setOut((o) => [...o, { kind: 'error', text: 'workspace stopped and restarted; the backend was not touched' }]);
  }

  const ready = progress?.stage === 'ready';
  return (
    <div className="workspace">
      <div className="editor-pane">
        <div className="row">
          <label>
            Example{' '}
            <select onChange={(e) => setCode(EXAMPLES.find((x) => x.id === e.target.value)!.code)} aria-label="Example script">
              {EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </label>
          <button onClick={run} disabled={!ready || running}>{running ? 'Running…' : 'Run'}</button>
          <button onClick={stop} disabled={!running}>Stop</button>
          <span className="hint">{ready ? 'Workspace ready (its own Pyodide worker)' : `Workspace loading: ${progress?.detail ?? 'starting'}`}</span>
        </div>
        <textarea className="code" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Python script"
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const s = el.selectionStart;
              setCode(code.slice(0, s) + '    ' + code.slice(el.selectionEnd));
              requestAnimationFrame(() => (el.selectionStart = el.selectionEnd = s + 4));
            }
          }} />
        <pre className="console" aria-label="Workspace output">{out.map((o, i) => <div key={i} className={o.kind}>{o.text}</div>)}</pre>
      </div>
      <div className="promoted">
        <h2>Promoted by the workspace</h2>
        <p className="hint">Served at <code>ws/collections/&lt;name&gt;</code> in the same CoverageJSON shape as everything else, and drawn by the same generic code.</p>
        {promotedErr && <p className="hint">{promotedErr}</p>}
        {Object.keys(promoted).length === 0 && <p className="hint">Nothing promoted yet.</p>}
        {Object.entries(promoted).map(([id, cov]) => <CoverageView key={id} cov={cov} title={id} syncKey="ws" />)}
      </div>
    </div>
  );
}
