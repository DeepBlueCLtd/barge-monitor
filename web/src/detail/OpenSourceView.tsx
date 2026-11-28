// The Open Source view of the opening panel (D-365): reached from "Open Source" in the Open Standards view, a short
// account of OpenSensorHub (what it is, who made it, its licence, who it was made for), then "Adopt", which starts the
// merge (FR-124, D-360). Shown in the panel only: the flowchart and its illustrative traffic are unchanged, and nothing
// starts before Adopt (FR-122). Crisp (VS-18); nothing gold (FR-121); no digits (FR-120, §16).
//
// Facts kept conservative, each from a public source (D-365): the origins from GPS World, "OpenSensorHub: Tackling a
// modern geospatial 'Tower of Babel'" (2016); the licence from osh-core's LICENSE on GitHub; GeoRobotix from
// georobotix.com. No current government user was found in a public source, so none is named.
import { opening } from '../shell/opening';

export const OPEN_SOURCE: { head: string; text: string }[] = [
  { head: 'Who made it', text: 'It grew from the work of Mike Botts, of Botts Innovative Research, and Alex Robin, of Sensia Software, both long involved in OGC\'s sensor standards. GeoRobotix offers development and support for it.' },
  { head: 'Who it was made for', text: 'Its early development was done for NASA. The OGC sensor standards it builds on are used by scientists, emergency responders and the military.' },
  { head: 'Licence', text: 'Free to use and to change, under the Mozilla Public License. The source is on GitHub.' },
  { head: 'Here', text: 'It would be our data server: it already does what the subsystems in the table do, so we would not write them.' },
];

export function OpenSourceView() {
  return (
    <div className="standards open-source" data-testid="open-source">
      <p className="standards-lead">OpenSensorHub is an open-source server for sensors and the systems around them. It implements OGC API – Connected Systems.</p>
      <dl className="open-source-facts" data-testid="open-source-facts">
        {OPEN_SOURCE.map((f) => (
          <div key={f.head}><dt>{f.head}</dt><dd>{f.text}</dd></div>
        ))}
      </dl>
      <div className="standards-choice" role="group" aria-label="The data server" data-testid="open-source-choice">
        <button className="btn" data-testid="choose-adopt" onClick={() => opening.adopt()}>Adopt</button>
      </div>
    </div>
  );
}
