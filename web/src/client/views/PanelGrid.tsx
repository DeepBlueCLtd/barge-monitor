// The display client's panel layout: its views sit on a grid, and the user
// moves a view by its header and resizes it by its corner. A placeholder for
// user configuration of the display client: the set of panels is fixed, and
// the arrangement lasts until the page is reloaded.
import { ReactElement, RefObject, useState } from 'react';
import ReactGridLayout, { Layout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const COLS = 12;
const ROW = 25;
const GAP = 8;

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
  const [layout, setLayout] = useState<Layout>(() => panels.map(({ id, node: _node, ...at }) => ({ i: id, ...at })));
  return (
    <div ref={containerRef as RefObject<HTMLDivElement>} className="dc-grid" data-testid="panel-grid">
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={layout}
          onLayoutChange={setLayout}
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
