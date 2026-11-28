// The stacked flowchart (FR-64..FR-68, §11.3, §11.4). React Flow places the
// component cards and zone bands from the committed layout file; the arrows,
// the travelling messages, the status box and the message key are drawn in its
// viewport. The view is fixed: no panning or zooming, only scaling to the column.
//
// With `?hand-made` it first shows the adoption opening (SRD §9.8) from a second fixed
// layout: the data server as subsystem cards, drawn by the same card as every component
// (VS-25), joined by plain lines (FR-120a). Adopt moves the subsystem cards into the Data
// server card one at a time, then settles the rest into the normal layout (FR-124, D-360),
// and hands over to it (FR-125). The merge is drawn frame by frame from one clock: each
// card's place, scale and opacity, the zones and the lines are functions of the time since
// Adopt, so every card moves and shrinks smoothly, and the same React Flow nodes, in one
// fixed order, are kept from the opening to the normal layout.
import { Node, NodeProps, ReactFlow, useReactFlow, ViewportPortal } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { drawClock } from './drawclock';
import { COMPONENT_IDS, COMPONENTS, ComponentId, isComponentId } from './components';
import { Diamond } from './Diamond';
import {
  allLanes, arrowhead, cardRect, laneFor, LAYOUT_SIZE, OPENING_ZONE_RECTS, openingRect, Pt, pointAt, Rect, ZONE_RECTS, ZoneRect,
} from './geometry';
import layout from './layout.json';
import openingLayout from './layout-opening.json';
import { bus, isHandshakeMessage, isUserMessage, Message } from './messages';
import { mockTraffic } from './mocktraffic';
import { isRow, isSubsystem, MERGE_SCHEDULE, opening, OPENING_LINES, prefersReducedMotion, subsystem, SUBSYSTEM_IDS } from './opening';
import { GOLD, INK, ZoneId, ZONES } from './palette';
import { runtime } from './runtime';
import { useRevealed } from './reveal';
import { selectComponent, selectedComponent, selectedMessage } from './selection';
import { sketchLine, sketchRect } from './sketch';
import { Glyph } from './Glyph';
import { GodsEyeNote, MessageKey, OpeningStatus, StatusBox } from './StatusBox';
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
  /** During the adoption merge (D-360): the card's scale about its centre, and its opacity. */
  scale?: number;
  opacity?: number;
  [k: string]: unknown;
}
interface ZoneData {
  zone: ZoneId;
  w: number;
  h: number;
  labelAt: string;
  /** False while the merge resizes the zone: its sketched outline would be redrawn every frame (VS-25). */
  outline?: boolean;
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
 * A card (VS-12): its name and a one-line role, text only. Gold once revealed (FR-75). The subsystem
 * cards of the adoption opening are drawn by this same card, so they are the equals of every
 * component card (FR-120, VS-25).
 */
const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  const { w, h } = data;
  const merging = data.scale != null || data.opacity != null;
  return (
    <div className={`card${data.gold ? ' gold' : ''}${data.selected ? ' selected' : ''}`}
      style={merging ? { width: w, height: h, transform: data.scale != null && data.scale !== 1 ? `scale(${data.scale})` : undefined, opacity: data.opacity } : { width: w, height: h }}
      data-testid={`card-${data.id}`} data-revealed={data.gold ? 'true' : 'false'} role="button" aria-pressed={data.selected} aria-label={data.name}>
      {/* The outline is seeded by the card's id: identical whether gold or not (AT-21); in the merge it moves and is not redrawn (VS-25). */}
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
      {data.outline !== false && <Outline id={`zone:${data.zone}`} w={data.w} h={data.h} stroke={z.hue} width={1.5} dashed={z.dashed} />}
      <div className={`zone-label ${data.labelAt}`} style={{ color: z.text }}>{z.label}</div>
    </div>
  );
});

const NODE_TYPES = { card: Card, zone: Zone };

/**
 * One-line roles (VS-12); the importer's says when it is importing. The file's name is in the importer's
 * panel and the display client: on a card the size of the opening's (D-330) it would not fit.
 */
function useRoles(): Record<ComponentId, string> {
  const control = useStore(runtime.control);
  const importing = control?.folder?.find((f) => f.status === 'importing');
  return Object.fromEntries(COMPONENT_IDS.map((id) => [id,
    id === 'importer' && importing ? `importing · ${importing.pct ?? 0}%` : COMPONENTS[id].role])) as Record<ComponentId, string>;
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
  const first = useRef(true);
  useEffect(() => {
    // Scale the fixed layout to the column; on the 1920×1080 target this is 1 (VS-05).
    const zoom = Math.max(0.4, Math.min(1.6, box.w / LAYOUT_SIZE[0], box.h / LAYOUT_SIZE[1]));
    // D-360: after the opening, the top bar's controls appear at hand-over and the column gets shorter; the flowchart
    // then rescales smoothly rather than jumping. A load without the flag, and reduced motion, rescale at once.
    const ease = !first.current && opening.phase.value !== 'off' && !prefersReducedMotion();
    first.current = false;
    void rf.setViewport({ x: 0, y: 0, zoom }, ease ? { duration: 500 } : undefined);
  }, [box.w, box.h, rf]);
  return null;
}

type Mode = 'opening' | 'merging' | 'normal';

const zoneNode = (z: ZoneRect, outline = true): Node => ({
  id: `zone-${z.id}`, type: 'zone', position: { x: z.rect[0], y: z.rect[1] }, width: z.rect[2], height: z.rect[3],
  data: { zone: z.id as ZoneId, w: z.rect[2], h: z.rect[3], labelAt: z.labelAt, outline }, selectable: false, draggable: false, connectable: false, focusable: false, zIndex: -1,
});

function cardName(id: string): string {
  return isSubsystem(id) ? subsystem(id).name : COMPONENTS[id as ComponentId]?.name ?? id;
}

function cardRole(id: string): string {
  return isSubsystem(id) ? subsystem(id).role : COMPONENTS[id as ComponentId]?.role ?? '';
}

type CardLook = Pick<CardData, 'gold' | 'selected' | 'standin'> & Partial<Pick<CardData, 'scale' | 'opacity'>>;
const cardNode = (id: string, r: Rect, role: string, data: CardLook, zIndex?: number): Node => ({
  id, type: 'card', position: { x: r[0], y: r[1] }, width: r[2], height: r[3], draggable: false, connectable: false, selectable: false,
  ...(zIndex != null ? { zIndex } : {}),
  data: { ...data, id, name: cardName(id), role, w: r[2], h: r[3] },
});

/**
 * Every card, in one fixed order for every mode (D-360). React keeps a node's element in place only while its place
 * among its siblings is kept: a node that changed place was taken out of the page and put back, which cancelled the
 * transition that was to move it. The data server is only in the merge and the normal layout, the subsystems only in
 * the opening and the merge; adding or removing them moves no other node.
 */
const CARD_ORDER: string[] = ['client', 'scilibs', 'server', 'models', 'importer', ...SUBSYSTEM_IDS, 'folder'];
const ZONE_ORDER = ZONE_RECTS.map((z) => z.id);

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Ease in and out (cubic). */
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpRect = (a: Rect, b: Rect, f: number): Rect => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f)];
const sameSize = (a: Rect, b: Rect) => a[2] === b[2] && a[3] === b[3];
const openingZone = (id: string) => OPENING_ZONE_RECTS.find((z) => z.id === id)!;
const normalZone = (id: string) => ZONE_RECTS.find((z) => z.id === id)!;

/** The merge at `t` ms after Adopt (D-360): how far the settle has gone, and each part's fade. */
function mergeAt(t: number) {
  const m = MERGE_SCHEDULE;
  return {
    settle: ease(clamp01((t - m.settleStart) / m.settle)),
    settling: t > m.settleStart && t < m.end,
    /** The opening's plain lines fade out as the merge begins. */
    lines: 1 - clamp01(t / m.intro),
    /** The normal arrows with their labels, the god's-eye note, the key and the status come in over the settle's second half. */
    arrows: clamp01((t - m.settleStart - m.settle * 0.4) / (m.settle * 0.6)),
    /** The opening's "Opening" status goes over the settle's first part. */
    openingStatus: 1 - clamp01((t - m.settleStart) / (m.settle * 0.4)),
  };
}

/**
 * The nodes of each mode: the opening layout; the merge at `t` ms after Adopt; the normal layout. Nodes keep their ids
 * and their order across modes, so a card moves rather than being redrawn.
 */
function layoutNodes(mode: Mode, t: number, sel: string | null, rev: ReadonlySet<ComponentId>, standin: boolean, roles: Record<ComponentId, string>, highlighted: string | null): Node[] {
  if (mode === 'opening') {
    // FR-121, FR-122: nothing gold, no stand-in tags, no data server.
    return [
      ...ZONE_ORDER.map((id) => zoneNode(openingZone(id))),
      ...CARD_ORDER.filter((id) => openingRect(id)).map((id) => cardNode(id, openingRect(id)!, cardRole(id), { gold: false, selected: highlighted === id, standin: false })),
    ];
  }
  if (mode === 'normal') {
    return [
      ...ZONE_ORDER.map((id) => zoneNode(normalZone(id))),
      ...CARD_ORDER.filter(isComponentId).map((id) => cardNode(id, cardRect(id), roles[id], {
        gold: rev.has(id) && COMPONENTS[id].valueAdd,
        selected: sel === id,
        // FR-06h: which cards carry a "stand-in" tag (D-325). None during the merge: they come with the banner, at hand-over.
        standin: standinTag(id, standin),
      })),
    ];
  }
  // FR-124, D-360: the merge.
  const at = mergeAt(t);
  const plain = { gold: false, selected: false, standin: false };
  const server = cardRect('server');
  const subs = MERGE_SCHEDULE.subs;
  const nodes: Node[] = ZONE_ORDER.map((id) => {
    const a = openingZone(id), b = normalZone(id);
    return zoneNode({ id, rect: lerpRect(a.rect, b.rect, at.settle), labelAt: at.settle > 0 ? b.labelAt : a.labelAt }, !(at.settling && !sameSize(a.rect, b.rect)));
  });
  for (const id of CARD_ORDER) {
    if (id === 'server') {
      // The Data server card appears as the lines fade, and fills in as each subsystem lands in it.
      const intro = clamp01(t / MERGE_SCHEDULE.intro);
      const filled = subs.reduce((n, s) => n + clamp01((t - s.land + 250) / 250), 0) / subs.length;
      nodes.push(cardNode(id, server, cardRole(id), { ...plain, opacity: 0.3 * intro + 0.7 * filled }));
    } else if (isSubsystem(id)) {
      // Each subsystem travels into the Data server card in turn, shrinking as it goes, and fades as it lands.
      const i = subs.findIndex((s) => s.id === id);
      const p = clamp01((t - subs[i].start) / (subs[i].land - subs[i].start));
      const e = ease(p);
      const [x, y, w, h] = openingRect(id)!;
      // Landing places spread across the Data server card, left to right in the table's order.
      const tx = server[0] + server[2] * (0.15 + (0.7 * i) / Math.max(1, subs.length - 1)) - w / 2;
      const ty = server[1] + server[3] / 2 - h / 2;
      nodes.push(cardNode(id, [lerp(x, tx, e), lerp(y, ty, e), w, h], cardRole(id),
        { ...plain, scale: 1 - 0.7 * e, opacity: p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3 }, p > 0 && p < 1 ? 10 : undefined));
    } else {
      // The other cards settle into their normal places (the importer and Models keep their size, D-330).
      nodes.push(cardNode(id, lerpRect(openingRect(id)!, cardRect(id), at.settle), cardRole(id), { ...plain, scale: 1 }));
    }
  }
  return nodes;
}

/** Milliseconds since Adopt, once per animation frame while the cards merge (D-360). */
function useMergeClock(on: boolean): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const loop = () => {
      setT(performance.now() - opening.mergeStart);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return on ? t : 0;
}

export function Flowchart() {
  const sel = useStore(selectedComponent);
  const rev = useRevealed();
  const roles = useRoles();
  const phase = useStore(opening.phase);
  const highlighted = useStore(opening.highlighted);
  const mode: Mode = phase === 'build' ? 'opening' : phase === 'merging' ? 'merging' : 'normal';
  const t = useMergeClock(mode === 'merging');
  const ready = useStore(runtime.progress).stage === 'ready';
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

  const nodes: Node[] = useMemo(() => layoutNodes(mode, t, sel, rev, standin, roles, highlighted), [mode, t, sel, rev, standin, roles, highlighted]);
  const at = mode === 'merging' ? mergeAt(t) : null;
  // D-361: illustrative traffic in the opening, none with reduced motion (AT-66); it stops at the Adopt click.
  const illustrative = !prefersReducedMotion();

  const onCardClick = (id: string) => {
    if (opening.active) {
      // FR-123 (D-359): any card highlights its row in the table; nothing is revealed (FR-121).
      if (isRow(id)) opening.highlight(id);
      return;
    }
    // D-360: after Adopt, the components are there before the back end has started; they open their panels once it has.
    if (!ready) return;
    if (isComponentId(id)) selectComponent(id);
  };

  return (
    <div className={`flowchart mode-${mode}`} data-testid="flowchart" data-mode={mode} data-ready={ready ? 'true' : 'false'} ref={ref}>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} defaultViewport={{ x: 0, y: 0, zoom: 1 }} minZoom={0.4} maxZoom={1.6}
        panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnScroll={false} preventScrolling={false}
        nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
        onNodeClick={(_, n) => n.type === 'card' && onCardClick(n.id)} proOptions={{ hideAttribution: true }}>
        <FixedView box={box} />
        <ViewportPortal>
          {/* D-360: the opening's lines fade as the merge begins; the normal arrows, with their labels, fade in as it settles. */}
          {mode === 'opening' && <OpeningLines />}
          {at && at.lines > 0 && <OpeningLines opacity={at.lines} />}
          {mode === 'normal' && <Arrows />}
          {at && at.arrows > 0 && <Arrows opacity={at.arrows} />}
          {/* FR-122: nothing is sent or drawn before hand-over; the key and the god's-eye note come with the messages. */}
          {mode === 'normal' && <Icons />}
          {illustrative && (mode === 'opening' || mode === 'merging') && <MockIcons />}
          {(mode === 'normal' || (at && at.arrows > 0)) && <Fade opacity={at?.arrows}><GodsEyeNote rect={layout.note as [number, number, number, number]} /></Fade>}
          {mode === 'opening' || (at && at.openingStatus > 0)
            ? <Fade opacity={at?.openingStatus}><OpeningStatus rect={openingLayout.status as [number, number, number, number]} illustrative={illustrative && mode === 'opening'} /></Fade>
            : <Fade opacity={at?.arrows}><StatusBox rect={layout.status as [number, number, number, number]} /></Fade>}
          {(mode === 'normal' || (at && at.arrows > 0)) && <Fade opacity={at?.arrows}><MessageKey rect={layout.key as [number, number, number, number]} /></Fade>}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}

/** During the merge (D-360), a box below the flowchart fades with the arrows; otherwise it is drawn as it is. */
function Fade({ opacity, children }: { opacity?: number; children: React.ReactNode }) {
  return <div className="merge-fade" style={opacity == null ? undefined : { opacity }}>{children}</div>;
}

/** FR-120a: the opening's flows as plain lines, without letters; a head at each end of a two-way flow. */
const OpeningLines = memo(function OpeningLines({ opacity }: { opacity?: number }) {
  return (
    <svg className="arrows opening-lines" width={LAYOUT_SIZE[0]} height={LAYOUT_SIZE[1]} aria-hidden="true" data-testid="opening-lines" style={opacity != null ? { opacity } : undefined}>
      {OPENING_LINES.map((f) => {
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
const Arrows = memo(function Arrows({ opacity }: { opacity?: number }) {
  const lanes = useMemo(() => allLanes(), []);
  return (
    <svg className="arrows" width={LAYOUT_SIZE[0]} height={LAYOUT_SIZE[1]} aria-hidden="true" data-testid="flow-arrows" style={opacity != null ? { opacity } : undefined}>
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

/**
 * D-361: the opening's illustrative traffic (mocktraffic.ts), drawn with the real icons but not as messages: not
 * buttons, not clickable, hidden from assistive technology, and never in the message bus. It stops, fading out, at Adopt.
 */
function MockIcons() {
  const [icons, setIcons] = useState(() => mockTraffic.step());
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setIcons(mockTraffic.step());
      if (!mockTraffic.done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="mock-traffic" aria-hidden="true" data-testid="mock-traffic">
      {icons.map((m) => (
        <div key={m.key} className="mock-icon" data-testid="mock-icon" data-mock-letter={m.letter}
          style={{ transform: `translate(${m.at[0] - 19}px, ${m.at[1] - 19}px)`, opacity: m.opacity < 1 ? m.opacity : undefined }}>
          <Glyph letter={m.letter} />
        </div>
      ))}
    </div>
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
