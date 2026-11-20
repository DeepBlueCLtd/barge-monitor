// The architecture view (FR-47..FR-51, Annex A). React Flow lays out the
// cards and zones from the committed layout file and provides pan and zoom;
// the routed arrows and the moving messages are drawn in its viewport.
import { Background, Edge, Handle, Node, NodeProps, Position, ReactFlow, useViewport, ViewportPortal } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { HOP_S } from '../config';
import { simClock } from './clock';
import { arrowhead, arrows, laneFor, Pt, pointAt } from './geometry';
import layout from './layout.json';
import { bus, LETTERS, Message } from './messages';
import { INK, MUTED, ZONES } from './palette';
import { sketchLine, sketchRect } from './sketch';
import { useStore } from './store';

const [W, H] = layout.card;
const NO_EDGES: Edge[] = [];

// What really runs when the illustrative JS simulation stands in (D-41).
const SIMULATED_LABELS: Record<string, string> = {
  logger: 'Logger store (sim)', adapter: 'Store adapter (sim)', server: 'CS server (JS sim)', fastapi: 'Router (JS sim)',
  analysis: 'Analysis (JS sim)', scilibs: 'Arithmetic (JS sim)', runtime: 'Browser', workspace: 'Workspace', products: 'Promoted products',
};

interface CardData { label: string; role: string; status: string; dashed: boolean; hue: string; hl: boolean; [k: string]: unknown }
interface ZoneData { label: string; zone: string; w: number; h: number; [k: string]: unknown }

const Outline = ({ id, w, h, stroke, width, dashed, className }: { id: string; w: number; h: number; stroke: string; width?: number; dashed?: boolean; className: string }) => {
  const p = useMemo(() => sketchRect(id, w, h, stroke, width, dashed), [id, w, h, stroke, width, dashed]);
  if (!p) return null;
  return (
    <svg className={className} width={w} height={h} aria-hidden="true" data-sketch={id}>
      {p.map((s, i) => <path key={i} d={s.d} stroke={s.stroke} strokeWidth={s.strokeWidth} fill="none" />)}
    </svg>
  );
};

/** A component card (VS-10..VS-12): name, one-line role, live status. Text only. */
const Card = memo(({ id, data }: NodeProps<Node<CardData>>) => (
  <div className={`card ${data.dashed ? 'dashed' : ''} ${data.hl ? 'hl' : ''}`} style={{ width: W, height: H, ['--hue' as string]: data.hue }}>
    <Handle type="target" position={Position.Top} className="handle" isConnectable={false} />
    <Outline id={`card:${id}`} w={W} h={H} stroke={data.dashed ? data.hue : INK} width={data.dashed ? 1.4 : 1.7} dashed={data.dashed} className="sketch" />
    <div className="card-name">{data.label}</div>
    <div className="card-role">{data.role}</div>
    <div className="card-status" data-testid={`status-${id}`}>{data.status}</div>
  </div>
));

/** A zone region (VS-06): pale fill, outline in its hue, its label. */
const Zone = memo(({ id, data }: NodeProps<Node<ZoneData>>) => {
  const z = ZONES[data.zone];
  return (
    <div className={`zone-region ${z.dashed ? 'dashed' : ''}`} style={{ width: data.w, height: data.h, background: z.fill, ['--hue' as string]: z.hue }}>
      <Outline id={id} w={data.w} h={data.h} stroke={z.hue} width={1.5} dashed={z.dashed} className="sketch" />
      <div className="zone-label" style={{ color: z.text }}>{data.label}</div>
    </div>
  );
});

const NODE_TYPES = { card: Card, zone: Zone };

export const Flowchart = memo(function Flowchart({ highlight, simulated = false, status }: { highlight: string; simulated?: boolean; status: Record<string, string> }) {
  const [info, setInfo] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ m: Message; at: Pt } | null>(null);
  const counts = useStore(bus.counts);
  const productsRegistered = (counts['products>relay:Q'] ?? 0) > 0;

  const nodes: Node[] = useMemo(() => [
    ...layout.zones.flatMap((z) => z.rects.map((r, i) => ({
      id: `zone-${z.id}-${i}`, type: 'zone', position: { x: r[0], y: r[1] }, width: r[2], height: r[3],
      data: { label: z.label, zone: z.id, w: r[2], h: r[3] }, selectable: false, draggable: false, connectable: false, zIndex: -1,
    }))),
    ...layout.nodes.map((n) => {
      const zone = n.zone ? ZONES[n.zone] : null;
      const dashed = !!(n as any).hostOnly || (!!(n as any).createdOnly && !productsRegistered) || (simulated && !!SIMULATED_LABELS[n.id]);
      return {
        id: n.id, type: 'card', position: { x: n.x, y: n.y }, width: W, height: H, draggable: false, connectable: false,
        data: { label: simulated ? SIMULATED_LABELS[n.id] ?? n.label : n.label, role: n.role, status: status[n.id] ?? '', dashed,
          hue: zone?.hue ?? MUTED, hl: highlight.split(',').includes(n.id) },
      };
    }),
  ], [highlight, simulated, status, productsRegistered]);

  return (
    <div className="flowchart" data-testid="flowchart">
      <ReactFlow nodes={nodes} edges={NO_EDGES} nodeTypes={NODE_TYPES} fitView fitViewOptions={{ padding: 0.02 }} minZoom={0.3} maxZoom={2}
        nodesConnectable={false} nodesDraggable={false} onNodeClick={(_, n) => n.type === 'card' && setInfo(n.id)} proOptions={{ hideAttribution: true }}>
        <Background gap={36} size={1} color="#e7e5e0" />
        <ViewportPortal>
          <Arrows />
          <Icons selected={selected?.m.id ?? null} onSelect={(m, at) => setSelected({ m, at })} />
          {selected && <SelectedIcon m={selected.m} at={selected.at} />}
        </ViewportPortal>
        {selected && <Leader at={selected.at} colour={LETTERS[selected.m.letter].colour} />}
      </ReactFlow>
      {info && <NodeInfo id={info} counts={counts} onClose={() => setInfo(null)} />}
      {selected && <MessagePopup m={selected.m} onClose={() => setSelected(null)} />}
    </div>
  );
});

/** Ink arrows with filled heads; two-way flows as two arrows side by side (VS-13, VS-14). */
const Arrows = memo(function Arrows() {
  const all = useMemo(() => arrows(), []);
  return (
    <svg className="arrows" width={layout.size[0]} height={layout.size[1]} aria-hidden="true">
      {all.map((a) => {
        const sk = sketchLine(`flow:${a.id}`, a.points, INK, 1.5);
        return (
          <g key={a.id} data-sketch={`flow:${a.id}`}>
            {sk ? sk.map((p, i) => <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill="none" />)
              : <polyline points={a.points.map((p) => p.join(',')).join(' ')} stroke={INK} strokeWidth={1.5} fill="none" />}
            <path d={arrowhead(a.points)} fill={INK} />
            {a.label && a.labelAt && <text x={a.labelAt[0]} y={a.labelAt[1]} className="flow-label">{a.label}</text>}
          </g>
        );
      })}
    </svg>
  );
});

function position(m: Message, now: number): { at: Pt; f: number } | null {
  const lane = laneFor(m.src, m.dst);
  if (!lane) return null;
  const f = (now - (m.start ?? m.t)) / HOP_S;
  if (f < 0 || f > 1) return null;
  return { at: pointAt(lane, m.failed ? Math.min(f, 0.5) : f), f };
}

/** A message: a white circle with a ring and its letter in its colour (VS-15); a failed one has a broken ring and a cross (VS-17). */
function Glyph({ m, selected }: { m: Message; selected?: boolean }) {
  const c = LETTERS[m.letter].colour;
  return (
    <svg width={34} height={34} viewBox="-17 -17 34 34" aria-hidden="true">
      {selected && <circle r={16} fill={c} opacity={0.18} />}
      <circle r={12.5} fill={selected ? `${c}26` : '#fff'} stroke={c} strokeWidth={2.4} strokeDasharray={m.failed ? '5 4' : undefined} />
      <text y={6} textAnchor="middle" fill={c} fontSize={17} fontWeight={700} fontFamily="'Patrick Hand', system-ui, sans-serif">{m.letter}</text>
      {m.failed && <path d="M7,-13 L13,-7 M13,-13 L7,-7" stroke={c} strokeWidth={2.2} />}
    </svg>
  );
}

/** Messages move on the simulation clock: paused, they freeze in place and stay clickable. */
function Icons({ onSelect, selected }: { onSelect: (m: Message, at: Pt) => void; selected: string | null }) {
  const live = useStore(bus.live);
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      bus.tick();
      setFrame((f) => f + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const now = simClock.displayNow();
  return (
    <>
      {live.map((m) => {
        if (m.id === selected) return null;
        const p = position(m, now);
        if (!p) return null;
        return (
          <button key={m.id} className={`icon ${m.failed ? 'failed' : ''}`} data-letter={m.letter} title={`${m.letter}: ${m.summary}`}
            style={{ transform: `translate(${p.at[0] - 17}px, ${p.at[1] - 17}px)` }} onClick={() => onSelect(m, p.at)}>
            <Glyph m={m} />
          </button>
        );
      })}
    </>
  );
}

/** A selected message stays where it was picked, tinted and haloed (VS-16). */
function SelectedIcon({ m, at }: { m: Message; at: Pt }) {
  return (
    <div className="icon selected" data-letter={m.letter} style={{ transform: `translate(${at[0] - 17}px, ${at[1] - 17}px)` }}>
      <Glyph m={m} selected />
    </div>
  );
}

/** A dashed leader line in the message's colour from the icon to its popup (VS-16). */
function Leader({ at, colour }: { at: Pt; colour: string }) {
  const { x, y, zoom } = useViewport();
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
  }, []);
  const sx = at[0] * zoom + x, sy = at[1] * zoom + y;
  const tx = box ? box.w - 470 : sx, ty = 60;
  return (
    <svg ref={ref} className="leader" aria-hidden="true">
      <line x1={sx} y1={sy} x2={tx} y2={ty} stroke={colour} strokeWidth={2} strokeDasharray="6 5" />
    </svg>
  );
}

/** Message popups are crisp: they are the evidence (VS-22, FR-50). */
function MessagePopup({ m, onClose }: { m: Message; onClose: () => void }) {
  const c = LETTERS[m.letter].colour;
  return (
    <div className="message-popup" role="dialog" aria-label="Message" style={{ borderColor: c }}>
      <h2 style={{ color: c }}><span className="ring" style={{ borderColor: c, color: c }}>{m.letter}</span> {label(m.src)} → {label(m.dst)}</h2>
      <p className="summary">{m.summary}{m.failed ? ' (failed: no answer)' : ''}</p>
      <pre data-testid="message-content">{pretty(m.content)}</pre>
      <p className="standard">{LETTERS[m.letter].standard}</p>
      <button onClick={onClose}>Close</button>
    </div>
  );
}

const label = (id: string) => layout.nodes.find((n) => n.id === id)?.label ?? id;

function pretty(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
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
            {!flows.length && <tr><td colSpan={4}>No message flows of its own: it hosts others.</td></tr>}
          </tbody>
        </table>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
