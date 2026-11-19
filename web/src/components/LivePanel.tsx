// Seven linked time series, bow and stern overlaid (FR-31), beside the map.
import { useMemo } from 'react';
import type { Canal, Collection } from '../api';
import { Buffer, PARAMS } from '../live';
import { CanalMap } from './CanalMap';
import { Mark, Series, TimeChart } from './TimeChart';

interface Props {
  canal: Canal;
  meta: Collection | null;
  bow: Buffer;
  stern: Buffer;
  xRange: [number, number] | null;
  setXRange: (r: [number, number] | null) => void;
  cursorT: number | null;
  setCursorT: (t: number | null) => void;
  colourBy: string;
  setColourBy: (s: string) => void;
  marks: Mark[];
  clusters: { t: number[]; c: number[] } | null;
  changes: { t: number; lon: number; lat: number; cause: string }[];
}

export function LivePanel(p: Props) {
  const charts = useMemo(() => {
    return PARAMS.map((name) => {
      const def = p.meta?.parameter_names?.[name];
      const title = (def?.observedProperty?.label as Record<string, string> | undefined)?.en ?? name;
      const unit = def?.unit?.symbol ?? '';
      const isDir = name === 'apparent_wind_direction';
      // Both sensors on the bow's time axis; records are 1 Hz in both.
      const t = p.bow.t;
      const stIndex = new Map<number, number>();
      p.stern.t.forEach((x, i) => stIndex.set(x, i));
      const sv = p.stern.v[name] ?? [];
      const stern = t.map((x) => {
        const i = stIndex.get(x);
        return i == null ? null : sv[i];
      });
      const bv = p.bow.v[name] ?? [];
      const bq = p.bow.qc[name] ?? [];
      const flagged = bv.map((v, i) => (bq[i] === 1 || bq[i] === 2 ? v : null));
      const series: Series[] = [
        { label: 'bow', values: bv, color: '#e15759', points: isDir },
        { label: 'stern', values: stern, color: '#4e79a7', points: isDir },
        { label: 'QC-flagged (bow)', values: flagged, color: '#f2b701', points: true },
      ];
      return { name, title, unit, t, series, isDir };
    });
  }, [p.bow, p.stern, p.meta]);

  return (
    <div className="live">
      <div className="map-pane">
        <CanalMap canal={p.canal} bow={p.bow} stern={p.stern} colourBy={p.colourBy} cursorT={p.cursorT} clusters={p.clusters} changes={p.changes} />
        <label className="row">
          Colour the track by{' '}
          <select value={p.colourBy} onChange={(e) => p.setColourBy(e.target.value)}>
            {PARAMS.map((n) => <option key={n} value={n}>{n.replace(/_/g, ' ')}</option>)}
            <option value="cluster">cluster (run the analysis first)</option>
          </select>
        </label>
        <p className="hint">Drag across a chart to zoom all seven; double-click to follow live again. The ring on the map follows the cursor.</p>
      </div>
      <div className="charts">
        {p.bow.t.length === 0 ? (
          <p className="hint">Waiting for the first records from the logger…</p>
        ) : (
          charts.map((c) => (
            <TimeChart key={c.name} title={c.title} unit={c.unit} t={c.t} series={c.series} syncKey="live" height={105}
              xRange={p.xRange} onZoom={p.setXRange} onCursor={p.setCursorT} marks={p.marks}
              yRange={c.isDir ? [0, 360] : undefined} />
          ))
        )}
      </div>
    </div>
  );
}
