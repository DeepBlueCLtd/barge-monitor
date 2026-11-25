// The display client's panel layout: its views sit on a grid, and the user
// moves a view by its header and resizes it by its corner (FR-57 to FR-62). The
// arrangement is a harmless preference, the only thing the client keeps in the
// browser (FR-100): which view sits where, never what it shows.
import { ReactElement, RefObject, useState } from 'react';
import ReactGridLayout, { Layout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const COLS = 12;
const ROW = 25;
const GAP = 8;
const KEY = 'barge-monitor:view-layout';

function saved(): Layout | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return Array.isArray(v) ? (v as Layout) : null;
  } catch {
    return null;
  }
}

function save(l: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))));
  } catch {
    /* storage unavailable: the layout lasts until reload */
  }
}

export interface PanelSpec {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  node: ReactElement;
}

export function PanelGrid({ panels }: { panels: PanelSpec[] }) {
  const { width, containerRef, mounted } = useContainerWidth();
  const [layout, setLayout] = useState<Layout>(() => {
    const kept = saved();
    return panels.map(({ id, node: _node, ...at }) => ({ i: id, ...at, ...(kept?.find((k) => k.i === id) ?? {}) }));
  });
  return (
    <div ref={containerRef as RefObject<HTMLDivElement>} className="dc-grid" data-testid="panel-grid">
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={layout}
          onLayoutChange={(l) => {
            setLayout(l);
            save(l);
          }}
          gridConfig={{ cols: COLS, rowHeight: ROW, margin: [GAP, GAP], containerPadding: [0, 0] }}
          dragConfig={{ enabled: true, bounded: true, handle: '.dc-view > header' }}
          resizeConfig={{ enabled: true, handles: ['se'] }}
          compactor={verticalCompactor}
        >
          {panels.map((p) => <div key={p.id} className="dc-panel" data-panel={p.id}>{p.node}</div>)}
        </ReactGridLayout>
      )}
    </div>
  );
}
