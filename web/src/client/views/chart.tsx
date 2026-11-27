// ECharts, drawn plainly with no sketch effect (FR-80, VS-20), in the monitor's
// plain sans-serif (VS-03). Only the parts the views use are bundled.
import { CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([LineChart, ScatterChart, HeatmapChart, CustomChart, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, MarkLineComponent, CanvasRenderer]);

export type EChartsOption = echarts.EChartsCoreOption;
export const MONITOR_FONT = "'Inter', system-ui, sans-serif";
export const AXIS = { color: '#4b5563', fontSize: 13, fontFamily: MONITOR_FONT };
/** Series colours inside the monitor: the display client's own, not the demonstrator's letters. */
export const SERIES = ['#2f4ac0', '#c2410c', '#0f766e', '#9333ea', '#be123c', '#4d7c0f', '#0369a1', '#a16207'];

/** Replay time (Unix seconds, UTC as in the files) to a JavaScript time value, for the time axes. */
export const ms = (t: number) => t * 1000;

/** A chart that fills its panel and follows the panel's size. */
export function EChart({ option, testid, extra }: { option: EChartsOption; testid?: string; extra?: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const el = ref.current!;
    chart.current = echarts.init(el, undefined, { renderer: 'canvas' });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    // Merged, not replaced: replacing the whole option once a second while playing hid the tooltip under the pointer.
    // Series are replaced, so one removed from the selection goes. The tooltip stays inside the chart, not cut by its panel.
    const tooltip = option.tooltip ? { confine: true, ...(option.tooltip as object) } : undefined;
    chart.current?.setOption({ animation: false, textStyle: { fontFamily: MONITOR_FONT }, ...option, ...(tooltip ? { tooltip } : {}) },
      { replaceMerge: ['series', 'visualMap'] });
  }, [option]);
  return <div ref={ref} className="echart" data-testid={testid} {...extra} />;
}

export function timeLabel(v: number, spanS: number): string {
  const d = new Date(v);
  const hm = d.toISOString().slice(11, 16);
  if (spanS <= 600) return d.toISOString().slice(11, 19); // a short window: seconds matter
  if (spanS <= 86400) return hm;
  return `${d.toISOString().slice(5, 10)}${spanS <= 7 * 86400 ? ` ${hm}` : ''}`;
}
