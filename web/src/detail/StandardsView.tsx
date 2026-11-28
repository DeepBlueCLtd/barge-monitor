// The Open Standards view of the opening panel (SRD 4.7 §9.8, FR-123a; D-363): a very short history of the OGC
// Connected Systems standard and a tree of its entities, related to this demonstrator, then the two choices:
// "Custom Components" (back to the table) and "Open Source" (a short account of OpenSensorHub, whose "Adopt" is
// FR-124; D-365). Shown in the panel only: the flowchart
// and its illustrative traffic are unchanged, and nothing starts (FR-122). Crisp, not sketched (VS-18); nothing gold
// (FR-121). The only digits are the history's periods and the standard's part numbers, which are not counts (D-363).
import overview from '../assets/connected-systems-overview.webp';
import { opening } from '../shell/opening';

/** The history, oldest first: a period and a plain sentence or two. Facts kept conservative (D-363). */
export const HISTORY: { when: string; what: string }[] = [
  { when: '2000s', what: 'Sensor Web Enablement: OGC standards to describe sensors (SensorML) and their readings (Observations & Measurements), with web services to fetch readings (SOS) and to task sensors (SPS).' },
  { when: 'Late 2010s', what: 'The OGC API family: the same kind of ideas as simple, modern web APIs, starting with OGC API – Features.' },
  { when: '2020s', what: 'OGC API – Connected Systems brings sensors and systems into that family. Part 1 describes what exists; Part 2 carries what changes. Both were approved as OGC standards in 2025.' },
  { when: 'Today', what: 'OpenSensorHub is an open-source server that implements Connected Systems.' },
];

type Part = 'p1' | 'p2';
interface Node { name: string; example: string; level: number; part: Part; schema?: boolean }

/** The tree: a System and what hangs from it, with this demonstrator's examples. */
const TREE: Node[] = [
  { name: 'System', example: 'the barge; each model', level: 0, part: 'p1' },
  { name: 'Subsystems', example: 'bow and stern sensors (Systems too)', level: 1, part: 'p1' },
  { name: 'Datastreams', example: 'the weather fields, e.g. wind speed', level: 1, part: 'p2', schema: true },
  { name: 'Observations', example: 'a reading: a time and its values', level: 2, part: 'p2' },
  { name: 'Control streams', example: "a model's settings", level: 1, part: 'p2' },
  { name: 'Commands', example: 'change a setting', level: 2, part: 'p2' },
  { name: 'Command status', example: 'accepted, completed or failed', level: 3, part: 'p2' },
];
/** Part 1 resources that describe the setting around a System. */
const AROUND: { name: string; example: string }[] = [
  { name: 'Deployments', example: "the barge's trips" },
  { name: 'Procedures', example: 'how a sensor measures' },
  { name: 'Sampling features', example: 'where it is measured' },
  { name: 'Properties', example: 'what is measured' },
];

const W = 640;
const BOX_W = 150, BOX_H = 30, INDENT = 32, X0 = 8, TOP = 44, STEP = 40, EX_X = 280;
const rowY = (i: number) => TOP + i * STEP;
const boxX = (level: number) => X0 + level * INDENT;
const AROUND_Y = rowY(TREE.length) + 34;
const AROUND_W = 148, AROUND_GAP = (W - 2 * X0 - 4 * AROUND_W) / 3;
const H = AROUND_Y + BOX_H + 26;

/** Each node's parent: the nearest row above it one level up. */
const parentOf = (i: number) => {
  for (let j = i - 1; j >= 0; j--) if (TREE[j].level === TREE[i].level - 1) return j;
  return -1;
};

function Tree() {
  // Elbow connectors: down from a parent's left side, across to the child's middle.
  const links = TREE.map((n, i) => {
    const p = parentOf(i);
    if (p < 0) return null;
    const x = boxX(TREE[p].level) + 14, y1 = rowY(p) + BOX_H, y2 = rowY(i) + BOX_H / 2;
    return <path key={`l${i}`} d={`M${x} ${y1} V${y2} H${boxX(n.level)}`} className="std-link" />;
  });
  return (
    <svg className="standards-tree" data-testid="standards-tree" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-labelledby="std-tree-title std-tree-desc">
      <title id="std-tree-title">The entities of OGC API – Connected Systems</title>
      <desc id="std-tree-desc">
        A System has subsystems, which are Systems too; datastreams, each with a schema, made of observations; and
        control streams, which take commands, each with a status. Datastreams, observations, control streams, commands and
        command status are Part 2, dynamic data. Systems, deployments, procedures, sampling features and properties are
        Part 1, feature resources. In this demonstrator the barge, its sensors and each model are Systems, the weather
        fields are datastreams, and a model's settings are commands.
      </desc>
      <g className="std-legend">
        <rect x={X0} y={6} width={14} height={14} rx={3} className="std-p1" />
        <text x={X0 + 20} y={18}>Part 1 · Feature resources: what exists</text>
        <rect x={330} y={6} width={14} height={14} rx={3} className="std-p2" />
        <text x={350} y={18}>Part 2 · Dynamic data: what changes</text>
      </g>
      {links}
      {TREE.map((n, i) => {
        const x = boxX(n.level), y = rowY(i);
        return (
          <g key={n.name} data-entity={n.name} data-part={n.part}>
            <rect x={x} y={y} width={BOX_W} height={BOX_H} rx={6} className={`std-box std-${n.part}`} />
            <text x={x + 12} y={y + 20} className="std-name">{n.name}</text>
            {n.schema && (
              <g data-entity="Schema">
                <path d={`M${x + BOX_W} ${y + BOX_H / 2} H${x + BOX_W + 10}`} className="std-link" />
                <rect x={x + BOX_W + 10} y={y + 5} width={58} height={BOX_H - 10} rx={10} className="std-schema" />
                <text x={x + BOX_W + 39} y={y + 19} textAnchor="middle" className="std-schema-text">schema</text>
              </g>
            )}
            <text x={EX_X} y={y + 20} className="std-example">{n.example}</text>
          </g>
        );
      })}
      <line x1={X0} x2={W - X0} y1={AROUND_Y - 22} y2={AROUND_Y - 22} className="std-rule" />
      <text x={X0} y={AROUND_Y - 6} className="std-around-head">Also in Part 1, describing the setting around a System:</text>
      {AROUND.map((a, i) => {
        const x = X0 + i * (AROUND_W + AROUND_GAP);
        return (
          <g key={a.name} data-entity={a.name} data-part="p1">
            <rect x={x} y={AROUND_Y + 4} width={AROUND_W} height={BOX_H} rx={6} className="std-box std-p1" />
            <text x={x + AROUND_W / 2} y={AROUND_Y + 24} textAnchor="middle" className="std-name">{a.name}</text>
            <text x={x + AROUND_W / 2} y={AROUND_Y + BOX_H + 22} textAnchor="middle" className="std-example">{a.example}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function StandardsView() {
  return (
    <div className="standards" data-testid="standards">
      <p className="standards-lead">A data server like ours is already described by an open standard, from OGC, the Open Geospatial Consortium.</p>
      <ol className="standards-history" data-testid="standards-history">
        {HISTORY.map((h) => (
          <li key={h.when}><b>{h.when}</b><span>{h.what}</span></li>
        ))}
      </ol>
      {/* The owner, 2026-11-28: the Connected Systems ecosystem overview, from the OGC developer site
          (csapi.developer.ogc.org/assets/img/overview.png), bundled so nothing is fetched from a third party (NFR-06). */}
      <figure className="standards-overview" data-testid="standards-overview">
        <img src={overview} alt="Connected Systems ecosystem overview" width={1400} height={765} loading="lazy" />
        <figcaption>Image: OGC, Connected Systems developer site.</figcaption>
      </figure>
      <Tree />
      <p className="standards-here" data-testid="standards-here">
        Here, the barge, its sensors and the models are Systems; each weather field is a Datastream of Observations; a
        model's settings are Commands.
      </p>
      <div className="standards-choice" role="group" aria-label="The data server" data-testid="standards-choice">
        <button className="btn" data-testid="choose-custom" onClick={() => opening.showComponents()}>Custom Components</button>
        <button className="btn" data-testid="choose-open-source" onClick={() => opening.showOpenSource()}>Open Source</button>
      </div>
    </div>
  );
}
