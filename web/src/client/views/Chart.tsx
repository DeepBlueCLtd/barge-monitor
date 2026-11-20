// A thin wrapper over ECharts. Charts in one group share cursor and zoom.
import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';

export function Chart({ option, height = 180, group, testid }: { option: echarts.EChartsOption; height?: number; group?: string; testid?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    if (group) {
      c.group = group;
      echarts.connect(group);
    }
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      c.dispose();
    };
  }, [group]);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: false, lazyUpdate: true, replaceMerge: ['series'] });
  }, [option]);
  return <div ref={el} style={{ height, width: '100%' }} data-testid={testid} />;
}

export const timeAxis = (): echarts.EChartsOption => ({
  animation: false,
  grid: { left: 64, right: 24, top: 36, bottom: 28 },
  xAxis: { type: 'time', axisLabel: { fontSize: 13, formatter: (v: number) => new Date(v).toISOString().slice(11, 16) } },
  yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 13 } },
  tooltip: { trigger: 'axis', textStyle: { fontSize: 14 } },
  axisPointer: { link: [{ xAxisIndex: 'all' }] },
  dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
  legend: { top: 4, textStyle: { fontSize: 14 } },
});
