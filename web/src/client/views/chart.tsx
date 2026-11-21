// ECharts, drawn plainly with no sketch effect (FR-80, VS-20), in the monitor's
// plain sans-serif (VS-03). Only the parts the views use are bundled.
import { CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { SIM_EPOCH_UNIX } from '../../shell/clock';

echarts.use([LineChart, ScatterChart, HeatmapChart, CustomChart, GridComponent, TooltipComponent, VisualMapComponent, MarkLineComponent, CanvasRenderer]);

export type EChartsOption = echarts.EChartsCoreOption;
export const MONITOR_FONT = "'Inter', system-ui, sans-serif";
export const AXIS = { color: '#4b5563', fontSize: 11, fontFamily: MONITOR_FONT };
/** Series colours inside the monitor: the display client's own, not the demonstrator's letters. */
export const SERIES = ['#2f4ac0', '#c2410c', '#0f766e', '#9333ea', '#be123c', '#4d7c0f', '#0369a1', '#a16207'];

/** Simulated seconds to a JavaScript time value, for the time axes. */
export const ms = (t: number) => (SIM_EPOCH_UNIX + t) * 1000;

export function EChart({ option, testid, height }: { option: EChartsOption; testid?: string; height: number }) {
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
    chart.current?.setOption({ animation: false, textStyle: { fontFamily: MONITOR_FONT }, ...option }, true);
  }, [option]);
  return <div ref={ref} className="echart" data-testid={testid} style={{ height }} />;
}

export function timeLabel(v: number, spanS: number): string {
  const d = new Date(v);
  const hm = d.toISOString().slice(11, 16);
  if (spanS <= 600) return d.toISOString().slice(11, 19); // a short window: seconds matter
  if (spanS <= 86400) return hm;
  return `${d.toISOString().slice(5, 10)}${spanS <= 7 * 86400 ? ` ${hm}` : ''}`;
}
