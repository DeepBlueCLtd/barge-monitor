// The stacked flowchart (FR-64..FR-68, §11.3, §11.4). React Flow places the
// component cards and zone bands from the committed layout file; the arrows,
// the travelling messages, the status box and the message key are drawn in its
// viewport. The view is fixed: no panning or zooming, only scaling to the column.
import { Node, NodeProps, ReactFlow, useReactFlow, ViewportPortal } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { drawClock } from './drawclock';
import { COMPONENT_IDS, COMPONENTS, ComponentId } from './components';
import { Diamond } from './Diamond';
import { allLanes, arrowhead, cardRect, laneFor, LAYOUT_SIZE, Pt, pointAt } from './geometry';
import layout from './layout.json';
import { bus, isHandshakeMessage, isUserMessage, LETTERS, Message } from './messages';
import { GOLD, INK, ZoneId, ZONES } from './palette';
import { runtime } from './runtime';
import { useRevealed } from './reveal';
import { selectComponent, selectedComponent, selectedMessage } from './selection';
import { sketchLine, sketchRect } from './sketch';
import { Glyph } from './Glyph';
import { GodsEyeNote, MessageKey, StatusBox } from './StatusBox';
import { useStore } from './store';

interface CardData {
  id: ComponentId;
  gold: boolean;
  selected: boolean;
  standin: boolean;
  role: string;
  [k: string]: unknown;
}
interface ZoneData {
  zone: ZoneId;
  w: number;
  h: number;
  labelAt: string;
  [k: string]: unknown;
}

/** A seeded sketch outline (VS-15, VS-16); null without the renderer, and CSS draws the outline (VS-17). */
export const Outline = memo(function Outline({ id, w, h, stroke, width = 1.7, dashed = false }: { id: string; w: number; h: number; stroke: string; width?: number; dashed?: boolean }) {
  const p = useMemo(() => sketchRect(id, w, h, stroke, width, dashed), [id, w, h, stroke, width, dashed]);
  if (!p) return null;
  return (
    <svg className="sketch" width={w} height={h} aria-hidden="true" data-sketch={id}>
      {p.map((s, i) => <path key={i} d={s.d} stroke={s.stroke} strokeWidth={s.strokeWidth} fill="none" />)}
    </svg>
  );
});

/** A component card (VS-12): its name and a one-line role, text only. Gold once revealed (FR-75). */
const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  const c = COMPONENTS[data.id];
  const [, , w, h] = cardRect(data.id);
  return (
    <div className={`card${data.gold ? ' gold' : ''}${data.selected ? ' selected' : ''}`} style={{ width: w, height: h }}
      data-testid={`card-${data.id}`} data-revealed={data.gold ? 'true' : 'false'} role="button" aria-pressed={data.selected} aria-label={c.name}>
      {/* The outline is seeded by the component's name: identical whether gold or not (AT-21). */}
      <Outline id={`card:${data.id}`} w={w} h={h} stroke={data.gold ? GOLD.outline : INK} width={data.gold ? 2 : 1.7} />
      <div className="card-name">{data.gold ? '★ ' : ''}{c.name}</div>
      <div className="card-role" data-testid={`role-${data.id}`}>{data.gold ? 'our value-add · ' : ''}{data.role}</div>
      {data.standin && <span className="standin-tag" data-testid="standin-tag">stand-in</span>}
      {data.gold && <Diamond className="card-diamond" size={26} />}
    </div>
  );
});

/** A zone band (VS-07): pale fill, an outline in its hue, its label (VS-10). */
const Zone = memo(function Zone({ data }: NodeProps<Node<ZoneData>>) {
  const z = ZONES[data.zone];
  return (
    <div className={`zone-band${z.dashed ? ' dashed' : ''}`} style={{ width: data.w, height: data.h, background: z.fill, ['--hue' as string]: z.hue }} data-zone={data.zone}>
      <Outline id={`zone:${data.zone}`} w={data.w} h={data.h} stroke={z.hue} width={1.5} dashed={z.dashed} />
      <div className={`zone-label ${data.labelAt}`} style={{ color: z.text }}>{z.label}</div>
    </div>
  );
});

const NODE_TYPES = { card: Card, zone: Zone };

/** One-line roles (VS-12); the importer's says when it is importing. */
function useRoles(): Record<ComponentId, string> {
  const control = useStore(runtime.control);
  const importing = control?.folder?.find((f) => f.status === 'importing');
  return Object.fromEntries(COMPONENT_IDS.map((id) => [id,
    id === 'importer' && importing ? `importing ${importing.file} · ${importing.pct ?? 0}%` : COMPONENTS[id].role])) as Record<ComponentId, string>;
}

/**
 * FR-06h: which cards carry a "stand-in" tag. The data server is a stand-in for OpenSensorHub in both back ends
 * (FR-06j); in stand-in mode the importer, the models and their numerical helpers run in the JavaScript stand-in too.
 * The data folder is the real files in either mode.
 */
function standinTag(id: ComponentId, standin: boolean): boolean {
  return id === 'server' || (standin && (id === 'importer' || id === 'models' || id === 'scilibs'));
}

function FixedView({ box }: { box: { w: number; h: number } }) {
  const rf = useReactFlow();
  useEffect(() => {
    // Scale the fixed layout to the column; on the 1920×1080 target this is 1 (VS-05).
    const zoom = Math.max(0.4, Math.min(1.6, box.w / LAYOUT_SIZE[0], box.h / LAYOUT_SIZE[1]));
    void rf.setViewport({ x: 0, y: 0, zoom });
  }, [box.w, box.h, rf]);
  return null;
}

export function Flowchart() {
  const sel = useStore(selectedComponent);
  const rev = useRevealed();
  const roles = useRoles();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: LAYOUT_SIZE[0], h: LAYOUT_SIZE[1] });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const standin = runtime.kind === 'standin';

  const nodes: Node[] = useMemo(() => [
    ...layout.zones.map((z) => ({
      id: `zone-${z.id}`, type: 'zone', position: { x: z.rect[0], y: z.rect[1] }, width: z.rect[2], height: z.rect[3],
      data: { zone: z.id as ZoneId, w: z.rect[2], h: z.rect[3], labelAt: z.labelAt }, selectable: false, draggable: false, connectable: false, focusable: false, zIndex: -1,
    })),
    ...COMPONENT_IDS.map((id) => {
      const [x, y, w, h] = cardRect(id);
      return {
        id, type: 'card', position: { x, y }, width: w, height: h, draggable: false, connectable: false, selectable: false,
        // FR-06h: in stand-in mode every component behind the seam runs in the stand-in worker.
        data: { id, gold: rev.has(id) && COMPONENTS[id].valueAdd, selected: sel === id, standin: standinTag(id, standin), role: roles[id] },
      };
    }),
  ], [rev, sel, standin, roles]);

  return (
    <div className="flowchart" data-testid="flowchart" ref={ref}>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} defaultViewport={{ x: 0, y: 0, zoom: 1 }} minZoom={0.4} maxZoom={1.6}
        panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnScroll={false} preventScrolling={false}
        nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
        onNodeClick={(_, n) => n.type === 'card' && selectComponent(n.id as ComponentId)} proOptions={{ hideAttribution: true }}>
        <FixedView box={box} />
        <ViewportPortal>
          <Arrows />
          <Icons />
          <GodsEyeNote rect={layout.note as [number, number, number, number]} />
          <StatusBox rect={layout.status as [number, number, number, number]} />
          <MessageKey rect={layout.key as [number, number, number, number]} />
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}

/** Ink arrows with filled heads, one per direction (FR-65, VS-13), sketched and seeded (VS-15, VS-16). */
const Arrows = memo(function Arrows() {
  const lanes = useMemo(() => allLanes(), []);
  return (
    <svg className="arrows" width={LAYOUT_SIZE[0]} height={LAYOUT_SIZE[1]} aria-hidden="true">
      {lanes.map((a) => {
        const sk = sketchLine(`flow:${a.id}`, a.points, INK, 1.6);
        return (
          <g key={a.id} data-sketch={sk ? `flow:${a.id}` : undefined} data-flow={a.id}>
            {sk ? sk.map((p, i) => <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill="none" />)
              : <polyline points={a.points.map((p) => p.join(',')).join(' ')} stroke={INK} strokeWidth={1.6} fill="none" />}
            <path d={arrowhead(a.points)} fill={INK} />
            {a.label && a.labelAt && <text x={a.labelAt[0]} y={a.labelAt[1]} className="flow-label" data-testid={`flow-label-${a.id}`}>{a.label}</text>}
          </g>
        );
      })}
    </svg>
  );
});

function position(m: Message, now: number): Pt | null {
  const lane = laneFor(m.src, m.dst);
  if (!lane) return null;
  const f = (now - m.start) / m.dur;
  if (f < 0 || f > 1) return null;
  // A failed request stops at the boundary (VS-14).
  return pointAt(lane, m.failed ? Math.min(f, 0.55) : f);
}

/** Messages move on the drawing clock, in real time (D-302); a picked one stays where it was picked. */
function Icons() {
  const live = useStore(bus.live);
  const picked = useStore(selectedMessage);
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      bus.tick();
      setFrame((f) => (f + 1) % 1e6);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const now = drawClock.now();
  return (
    <>
      {live.map((m) => {
        if (m.key === picked?.m.key) return null;
        const at = position(m, now);
        if (!at) return null;
        return (
          <button key={m.key} className={`icon${m.failed ? ' failed' : ''}`} data-letter={m.letter} data-user={isUserMessage(m) || undefined} data-handshake={isHandshakeMessage(m) || undefined} data-testid="message-icon"
            aria-label={`${m.letter} message: ${m.summary}`} title={`${m.letter}: ${m.summary}`}
            style={{ transform: `translate(${at[0] - 19}px, ${at[1] - 19}px)` }}
            onClick={(e) => {
              e.stopPropagation();
              selectedMessage.set({ m, at, follow: false });
            }}>
            <Glyph letter={m.letter} failed={m.failed} user={isUserMessage(m)} />
          </button>
        );
      })}
      <SelectedIcon now={now} />
    </>
  );
}

/** A selected message, tinted and haloed (VS-14): where it was picked, or travelling on if picked while paused. */
function SelectedIcon({ now }: { now: number }) {
  const picked = useStore(selectedMessage);
  if (!picked) return null;
  const { m } = picked;
  const at = picked.follow ? position(m, now) ?? picked.at : picked.at;
  return (
    <div className="icon selected" data-letter={m.letter} data-testid="selected-icon" style={{ transform: `translate(${at[0] - 19}px, ${at[1] - 19}px)` }}>
      <Glyph letter={m.letter} failed={m.failed} selected user={isUserMessage(m)} />
    </div>
  );
}
