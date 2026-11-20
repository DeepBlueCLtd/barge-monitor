// The architecture view (FR-47..FR-51): components in their zones, and every
// captured message as a lettered icon crossing its boundary.
import { Background, Edge, Node, ReactFlow, ViewportPortal } from '@xyflow/react';

const NO_EDGES: Edge[] = [];
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useState } from 'react';
import { HOP_S } from '../config';
import { simClock } from './clock';
import layout from './layout.json';
import { bus, LETTERS, Message } from './messages';
import { useStore } from './store';

const W = 170;
const H = 58;
const pos = new Map(layout.nodes.map((n) => [n.id, { x: n.x + W / 2, y: n.y + H / 2 }]));

export const Flowchart = memo(function Flowchart({ highlight }: { highlight: string }) {
  const [info, setInfo] = useState<string | null>(null);
  const [selected, setSelected] = useState<Message | null>(null);
  const counts = useStore(bus.counts);

  const nodes: Node[] = useMemo(() => [
    ...layout.zones.flatMap((z) => z.rects.map((r, i) => ({
      id: `zone-${z.id}-${i}`, position: { x: r[0], y: r[1] }, data: { label: i === 0 ? z.label : '' }, selectable: false, draggable: false,
      className: 'zone', width: r[2], height: r[3], style: { width: r[2], height: r[3], background: z.colour, zIndex: -1 }, connectable: false,
    }))),
    ...layout.nodes.map((n) => ({
      id: n.id, position: { x: n.x, y: n.y }, draggable: false,
      data: { label: n.label }, className: `cnode ${highlight.split(',').includes(n.id) ? 'hl' : ''} ${n.zone ? '' : 'outside'}`,
      width: W, height: H, style: { width: W, height: H },
    })),
  ], [highlight]);

  return (
    <div className="flowchart" data-testid="flowchart">
      <ReactFlow nodes={nodes} edges={NO_EDGES} fitView minZoom={0.3} maxZoom={2} nodesConnectable={false}
        onNodeClick={(_, n) => !n.id.startsWith('zone-') && setInfo(n.id)} proOptions={{ hideAttribution: true }}>
        <Background gap={40} size={1} />
        <ViewportPortal>
          <svg className="flows" width={layout.size[0]} height={layout.size[1]} aria-hidden="true">
            {layout.flows.map((f) => {
              const a = pos.get(f.a)!, b = pos.get(f.b)!;
              return <line key={`${f.a}-${f.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })}
          </svg>
          <Icons onSelect={setSelected} />
        </ViewportPortal>
      </ReactFlow>
      {info && <NodeInfo id={info} counts={counts} onClose={() => setInfo(null)} />}
      {selected && (
        <div className="modal" role="dialog" aria-label="Message">
          <div className="modal-body message-popup">
            <h2><span className="letter" style={{ background: LETTERS[selected.letter].colour }}>{selected.letter}</span> {LETTERS[selected.letter].standard}</h2>
            <p>{label(selected.src)} → {label(selected.dst)}: {selected.summary}{selected.failed ? ' (failed)' : ''}</p>
            <pre data-testid="message-content">{pretty(selected.content)}</pre>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
});

const label = (id: string) => layout.nodes.find((n) => n.id === id)?.label ?? id;

function pretty(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** Icons move along their edge on the simulation clock: paused, they freeze in place. */
function Icons({ onSelect }: { onSelect: (m: Message) => void }) {
  const live = useStore(bus.live);
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 40) {
        last = ts;
        bus.tick();
        setFrame((f) => f + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const now = simClock.displayNow();
  return (
    <>
      {live.map((m) => {
        const a = pos.get(m.src), b = pos.get(m.dst);
        if (!a || !b) return null;
        const f = (now - (m.start ?? m.t)) / HOP_S;
        if (f < 0 || f > 1.5) return null;
        const g = m.failed ? Math.min(f, 0.5) : Math.min(f, 1);
        const x = a.x + (b.x - a.x) * g, y = a.y + (b.y - a.y) * g;
        return (
          <button key={m.id} className={`icon ${m.failed ? 'failed' : ''}`} data-letter={m.letter}
            style={{ transform: `translate(${x - 14}px, ${y - 14}px)`, background: LETTERS[m.letter].colour }}
            onClick={() => onSelect(m)} title={`${m.letter}: ${m.summary}`}>
            {m.letter}
          </button>
        );
      })}
    </>
  );
}

function NodeInfo({ id, counts, onClose }: { id: string; counts: Record<string, number>; onClose: () => void }) {
  const n = layout.nodes.find((x) => x.id === id)!;
  const flows = layout.flows.filter((f) => f.a === id || f.b === id);
  const seen = (src: string, dst: string) => Object.entries(counts).filter(([k]) => k.startsWith(`${src}>${dst}:`))
    .map(([k, v]) => `${k.split(':')[1]} ×${v}`).join(', ') || 'none yet';
  return (
    <div className="modal" role="dialog" aria-label={n.label}>
      <div className="modal-body">
        <h2>{n.label} <small>{n.code}{n.zone ? ` · ${layout.zones.find((z) => z.id === n.zone)?.label}` : ' · outside the system'}</small></h2>
        <p>{n.does}</p>
        <table className="interfaces">
          <thead><tr><th>Flow</th><th>Letters</th><th>Emits (seen)</th><th>Accepts (seen)</th></tr></thead>
          <tbody>
            {flows.map((f) => {
              const other = f.a === id ? f.b : f.a;
              return <tr key={other}><td>{label(other)}</td><td>{f.letters.join(' ')}</td><td>{seen(id, other)}</td><td>{seen(other, id)}</td></tr>;
            })}
          </tbody>
        </table>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
