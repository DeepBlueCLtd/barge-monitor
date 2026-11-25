// The stacked flowchart (FR-64..FR-68, §11.3, §11.4). React Flow places the
// component cards and zone bands from the committed layout file; the arrows,
// the travelling messages, the status box and the message key are drawn in its
// viewport. The view is fixed: no panning or zooming, only scaling to the column.
//
// With `?hand-made` it first shows the adoption opening (SRD §9.8) from a second
// fixed layout: the data server as eight subsystem cards, drawn by the same card as
// every component (VS-25), joined by plain lines (FR-120a). Adopt moves the eight
// into the Data server card (FR-124) and hands over to the normal layout (FR-125).
import { Node, NodeProps, ReactFlow, useReactFlow, ViewportPortal } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { OPENING_MERGE_MS } from '../config';
import { simClock } from './clock';
import { COMPONENT_IDS, COMPONENTS, ComponentId, isComponentId } from './components';
import { Diamond } from './Diamond';
import {
  allLanes, arrowhead, cardRect, laneFor, LAYOUT_SIZE, OPENING_CARD_IDS, OPENING_ZONE_RECTS, openingRect, Pt, pointAt, Rect, ZONE_RECTS, ZoneRect,
} from './geometry';
import { Glyph } from './Glyph';
import layout from './layout.json';
import { bus, isHandshakeMessage, isUserMessage, Message } from './messages';
import { isSubsystem, opening, OPENING_FLOWS, subsystem, SUBSYSTEM_IDS } from './opening';
import { GOLD, INK, ZoneId, ZONES } from './palette';
import { runtime } from './runtime';
import { useRevealed } from './reveal';
import { selectComponent, selectedComponent, selectedMessage } from './selection';
import { sketchLine, sketchRect } from './sketch';
import { MessageKey, StatusBox } from './StatusBox';
import { useStore } from './store';

interface CardData {
  id: string;
  name: string;
  role: string;
  w: number;
  h: number;
  gold: boolean;
  selected: boolean;
  standin: boolean;
  /** During the adoption merge: the eight leave, the Data server arrives (FR-124). */
  merge?: 'out' | 'in';
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

/**
 * A card (VS-12): its name and a one-line role, text only. Gold once revealed (FR-75).
 * The subsystem cards of the adoption opening are drawn by this same card, so they are the
 * equals of every component card (FR-120, VS-25).
 */
const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  const { w, h } = data;
  return (
    <div className={`card${data.gold ? ' gold' : ''}${data.selected ? ' selected' : ''}${data.merge ? ` merge-${data.merge}` : ''}`} style={{ width: w, height: h }}
      data-testid={`card-${data.id}`} data-revealed={data.gold ? 'true' : 'false'} role="button" aria-pressed={data.selected} aria-label={data.name}>
      {/* Seeded by the card's id: identical whether gold or not (AT-21); in the merge it moves and is not redrawn (VS-25). */}
      <Outline id={`card:${data.id}`} w={w} h={h} stroke={data.gold ? GOLD.outline : INK} width={data.gold ? 2 : 1.7} />
      <div className="card-name">{data.gold ? '★ ' : ''}{data.name}</div>
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

function FixedView({ box }: { box: { w: number; h: number } }) {
  const rf = useReactFlow();
  useEffect(() => {
    // Scale the fixed layout to the column; on the 1920×1080 target this is 1 (VS-05).
    const zoom = Math.max(0.4, Math.min(1.6, box.w / LAYOUT_SIZE[0], box.h / LAYOUT_SIZE[1]));
    void rf.setViewport({ x: 0, y: 0, zoom });
  }, [box.w, box.h, rf]);
  return null;
}

type Mode = 'opening' | 'merging' | 'normal';

const zoneNode = (z: ZoneRect): Node => ({
  id: `zone-${z.id}`, type: 'zone', position: { x: z.rect[0], y: z.rect[1] }, width: z.rect[2], height: z.rect[3],
  data: { zone: z.id as ZoneId, w: z.rect[2], h: z.rect[3], labelAt: z.labelAt }, selectable: false, draggable: false, connectable: false, focusable: false, zIndex: -1,
});

function infoOf(id: string): { name: string; role: string } {
  return isSubsystem(id) ? subsystem(id) : COMPONENTS[id as ComponentId] ?? { name: id, role: '' };
}

const cardNode = (id: string, r: Rect, data: Pick<CardData, 'gold' | 'selected' | 'standin' | 'merge'>): Node => ({
  id, type: 'card', position: { x: r[0], y: r[1] }, width: r[2], height: r[3], draggable: false, connectable: false, selectable: false,
  data: { ...data, id, ...infoOf(id), w: r[2], h: r[3] },
});

/** The nodes of each mode: the opening layout; the merge (the normal layout, with the eight converging on the Data server); the normal layout. */
function layoutNodes(mode: Mode, sel: string | null, rev: ReadonlySet<ComponentId>, standin: boolean, highlighted: string | null): Node[] {
  if (mode === 'opening') {
    // FR-121, FR-122: nothing gold, no stand-in tags, no data server.
    return [
      ...OPENING_ZONE_RECTS.map(zoneNode),
      ...OPENING_CARD_IDS.map((id) => cardNode(id, openingRect(id)!, { gold: false, selected: highlighted === id, standin: false })),
    ];
  }
  const normal = mode === 'normal';
  const nodes = [
    ...ZONE_RECTS.map(zoneNode),
    ...COMPONENT_IDS.map((id) => cardNode(id, cardRect(id), {
      gold: normal && rev.has(id),
      selected: normal && sel === id,
      // FR-06h: in stand-in mode every component behind the seam runs in the stand-in worker.
      standin: normal && ((standin && id !== 'client') || id === 'server'),
      merge: !normal && id === 'server' ? 'in' : undefined,
    })),
  ];
  if (!normal) {
    // FR-124: the eight move to the Data server card's place and merge into it.
    const [sx, sy, sw, sh] = cardRect('server');
    for (const id of SUBSYSTEM_IDS) {
      const [, , w, h] = openingRect(id)!;
      nodes.push(cardNode(id, [sx + (sw - w) / 2, sy + (sh - h) / 2, w, h], { gold: false, selected: false, standin: false, merge: 'out' }));
    }
  }
  return nodes;
}

export function Flowchart() {
  const sel = useStore(selectedComponent);
  const rev = useRevealed();
  const phase = useStore(opening.phase);
  const highlighted = useStore(opening.highlighted);
  const mode: Mode = phase === 'build' ? 'opening' : phase === 'merging' ? 'merging' : 'normal';
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

  const nodes: Node[] = useMemo(() => layoutNodes(mode, sel, rev, standin, highlighted), [mode, rev, sel, standin, highlighted]);

  const onCardClick = (id: string) => {
    if (opening.active) {
      // FR-123: a subsystem card highlights its row; any other card does nothing, and nothing is revealed (FR-121).
      if (opening.phase.value === 'build' && isSubsystem(id)) opening.highlighted.set(id);
      return;
    }
    if (isComponentId(id)) selectComponent(id);
  };

  return (
    <div className={`flowchart mode-${mode}`} data-testid="flowchart" data-mode={mode} ref={ref} style={{ ['--merge-ms' as string]: `${OPENING_MERGE_MS}ms` }}>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} defaultViewport={{ x: 0, y: 0, zoom: 1 }} minZoom={0.4} maxZoom={1.6}
        panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnScroll={false} preventScrolling={false}
        nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
        onNodeClick={(_, n) => n.type === 'card' && onCardClick(n.id)} proOptions={{ hideAttribution: true }}>
        <FixedView box={box} />
        <ViewportPortal>
          {mode === 'normal' ? <Arrows /> : <OpeningLines fading={mode === 'merging'} />}
          {mode === 'merging' && <Arrows arriving />}
          {mode === 'normal' && <Icons />}
          <StatusBox rect={layout.status as [number, number, number, number]} />
          {/* No letters in the opening (FR-120a): the key comes with the messages. */}
          {mode === 'normal' && <MessageKey rect={layout.key as [number, number, number, number]} />}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}

/** FR-120a: the opening's flows as plain lines, without letters; a head at each end of a two-way flow. */
const OpeningLines = memo(function OpeningLines({ fading }: { fading: boolean }) {
  return (
    <svg className={`arrows opening-lines${fading ? ' fading' : ''}`} width={LAYOUT_SIZE[0]} height={LAYOUT_SIZE[1]} aria-hidden="true" data-testid="opening-lines">
      {OPENING_FLOWS.map((f) => {
        const id = `${f.a}>${f.b}`;
        const pts = f.path as Pt[];
        const sk = sketchLine(`line:${id}`, pts, INK, 1.4);
        return (
          <g key={id} data-sketch={sk ? `line:${id}` : undefined} data-line={id}>
            {sk ? sk.map((p, i) => <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill="none" />)
              : <polyline points={pts.map((p) => p.join(',')).join(' ')} stroke={INK} strokeWidth={1.4} fill="none" />}
            <path d={arrowhead(pts, 8)} fill={INK} />
            {f.both && <path d={arrowhead(pts, 8, true)} fill={INK} />}
          </g>
        );
      })}
    </svg>
  );
});

/** Ink arrows with filled heads, one per direction (FR-65, VS-13), sketched and seeded (VS-15, VS-16). */
const Arrows = memo(function Arrows({ arriving = false }: { arriving?: boolean }) {
  const lanes = useMemo(() => allLanes(), []);
  return (
    <svg className={`arrows${arriving ? ' arriving' : ''}`} width={LAYOUT_SIZE[0]} height={LAYOUT_SIZE[1]} aria-hidden="true">
      {lanes.map((a) => {
        const sk = sketchLine(`flow:${a.id}`, a.points, INK, 1.6);
        return (
          <g key={a.id} data-sketch={sk ? `flow:${a.id}` : undefined} data-flow={a.id}>
            {sk ? sk.map((p, i) => <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill="none" />)
              : <polyline points={a.points.map((p) => p.join(',')).join(' ')} stroke={INK} strokeWidth={1.6} fill="none" />}
            <path d={arrowhead(a.points)} fill={INK} />
            {a.label && a.labelAt && <text x={a.labelAt[0]} y={a.labelAt[1]} className="flow-label">{a.label}</text>}
          </g>
        );
      })}
    </svg>
  );
});

function position(m: Message, now: number): Pt | null {
  // A message naming an id this flowchart does not draw has no lane, and is not drawn.
  const lane = laneFor(m.src, m.dst);
  if (!lane) return null;
  const f = (now - m.start) / m.dur;
  if (f < 0 || f > 1) return null;
  // A failed request stops at the boundary (VS-14).
  return pointAt(lane, m.failed ? Math.min(f, 0.55) : f);
}

/** Messages move on the simulation clock: paused, they freeze in place and stay clickable (FR-77). */
function Icons() {
  const live = useStore(bus.live);
  const picked = useStore(selectedMessage);
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      bus.tick();
      // A message picked while paused travels on at Play; once it arrives it is deselected.
      const sel = selectedMessage.value;
      if (sel?.follow && simClock.playing && !position(sel.m, simClock.displayNow())) selectedMessage.set(null);
      setFrame((f) => (f + 1) % 1e6);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const now = simClock.displayNow();
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
              selectedMessage.set({ m, at, follow: !simClock.playing });
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
  if (!at) return null;
  return (
    <div className="icon selected" data-letter={m.letter} data-testid="selected-icon" style={{ transform: `translate(${at[0] - 19}px, ${at[1] - 19}px)` }}>
      <Glyph letter={m.letter} failed={m.failed} selected user={isUserMessage(m)} />
    </div>
  );
}
