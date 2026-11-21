// Data server panel (FR-72, mockup 3): the Connected Systems resources that
// describe this system, why the standard fits, and its gaps.
import { Fragment } from 'react';

type Box = { id: string; x: number; y: number; w: number; title: string; sub: string };
const H = 52;

// Coordinates in an 980 x 330 drawing; two columns, Sensing and Models.
const BOXES: Box[] = [
  { id: 'platform', x: 110, y: 22, w: 170, title: 'Collection platform', sub: 'System · Platform' },
  { id: 'bow', x: 20, y: 100, w: 170, title: 'Bow sensor', sub: 'System · Sensor' },
  { id: 'stern', x: 210, y: 100, w: 170, title: 'Stern sensor', sub: 'System · Sensor' },
  { id: 'ds-bow', x: 20, y: 178, w: 170, title: 'Datastream', sub: '7 fields + QC flags' },
  { id: 'ds-stern', x: 210, y: 178, w: 170, title: 'Datastream', sub: '7 fields + QC flags' },
  { id: 'obs-s', x: 20, y: 256, w: 360, title: 'Observations', sub: 'one per sensor per second · SWE Common JSON' },
  { id: 'models', x: 560, y: 22, w: 280, title: 'Models', sub: 'System · asset type Process' },
  { id: 'cores', x: 560, y: 100, w: 280, title: 'Data cleanse · Model A · Model B', sub: 'one process system each' },
  { id: 'outs', x: 560, y: 178, w: 280, title: 'Output datastreams', sub: 'cleaned values, summaries, clusters' },
  { id: 'obs-m', x: 560, y: 256, w: 280, title: 'Observations', sub: 'published by each model' },
];
const box = (id: string) => BOXES.find((b) => b.id === id)!;
const cx = (b: Box) => b.x + b.w / 2;

/** Orthogonal connectors: parent bottom-centre to child top-centre. */
const LINKS: [string, string][] = [
  ['platform', 'bow'], ['platform', 'stern'], ['bow', 'ds-bow'], ['stern', 'ds-stern'], ['ds-bow', 'obs-s'], ['ds-stern', 'obs-s'],
  ['models', 'cores'], ['cores', 'outs'], ['outs', 'obs-m'],
];

function linkPath(a: Box, b: Box): string {
  const x1 = cx(a), y1 = a.y + H, x2 = b.id === 'obs-s' ? cx(a) : cx(b), y2 = b.y;
  const mid = (y1 + y2) / 2;
  return x1 === x2 ? `M${x1},${y1} V${y2 - 1}` : `M${x1},${y1} V${mid} H${x2} V${y2 - 1}`;
}

export function ServerDetail() {
  return (
    <div className="server-detail" data-testid="detail-server">
      <p className="lede">The data server describes this system in Connected Systems' own terms. Every box below is a standard resource.</p>
      <div className="cs-diagram">
        <span className="cs-col-label" style={{ left: 20 }}>Sensing</span>
        <span className="cs-col-label" style={{ left: 560 }}>Models</span>
        <svg width="980" height="330" viewBox="0 0 980 330" aria-hidden="true" className="cs-links">
          <defs>
            <marker id="cs-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#374151" /></marker>
          </defs>
          {LINKS.map(([a, b]) => <path key={`${a}-${b}`} d={linkPath(box(a), box(b))} fill="none" stroke="#374151" strokeWidth={1.4} markerEnd="url(#cs-head)" />)}
        </svg>
        {BOXES.map((b) => (
          <Fragment key={b.id}>
            <div className="cs-box" style={{ left: b.x, top: b.y + 8, width: b.w, height: H }}>
              <b>{b.title}</b>
              <span>{b.sub}</span>
            </div>
          </Fragment>
        ))}
      </div>
      <h4 className="small-caps">Also used</h4>
      <div className="also">
        <div className="cs-box"><b>Property definitions</b><span>the seven parameters and derived values</span></div>
        <div className="cs-box"><b>Control streams and commands</b><span>model settings from the display client</span></div>
        <div className="cs-box"><b>System events</b><span>restarts and field changes</span></div>
      </div>
      <div className="why">
        <h4 className="small-caps">Why it fits</h4>
        <ul>
          <li>A platform carrying sensors is exactly its <b>Platform</b> and <b>Sensor</b> systems.</li>
          <li>No position needed: a system's <b>location is optional</b>.</li>
          <li>One <b>record datastream</b> carries all seven parameters per reading, with QC flags beside them.</li>
          <li>Models are first-class <b>process systems</b>, so adding one is ordinary resource creation.</li>
          <li>Settings travel as <b>commands</b>, with their bounds in the control stream's schema.</li>
          <li>Restarts and configuration changes are standard <b>system events</b>.</li>
        </ul>
        <p className="gaps"><b>Gaps:</b> no standard aggregation, so summaries are their own datastreams; publish/subscribe (Part 3) is not yet published, so the display polls.</p>
      </div>
    </div>
  );
}
