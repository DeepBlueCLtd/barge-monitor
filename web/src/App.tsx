import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Canal, categories, ClockState, Collection, Coverage, positions, routeWkt, times } from './api';
import { AboutPanel } from './components/AboutPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { LivePanel } from './components/LivePanel';
import { SeamPanel } from './components/SeamPanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { POLL_MS, STARTUP_BUDGET_MS } from './config';
import { useLive } from './live';
import { Seam } from './seam';
import type { Progress } from './workers/common';

const TABS = ['Live', 'Analysis', 'Workspace', 'Seam', 'About'] as const;
type Tab = (typeof TABS)[number];
const WINDOWS = [1, 6, 24];

function seedFromUrl(): number {
  const s = new URLSearchParams(location.search).get('seed');
  if (s && /^\d+$/.test(s)) return Number(s);
  return Math.floor(Math.random() * 1e6);
}

export function App() {
  const [progress, setProgress] = useState<Progress>({ stage: 'page', detail: 'starting', pct: 0 });
  const [startupMs, setStartupMs] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('Live');
  const [canal, setCanal] = useState<Canal | null>(null);
  const [meta, setMeta] = useState<Collection | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [windowHours, setWindowHours] = useState(6);
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [colourBy, setColourBy] = useState('air_temperature');
  const [results, setResults] = useState<Record<string, Coverage | string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const seed = useMemo(seedFromUrl, []);
  const seam = useRef<Seam | null>(null);
  if (!seam.current) seam.current = new Seam(setProgress);
  const ready = progress.stage === 'ready';

  useEffect(() => {
    seam.current!.start(seed).catch((e) => setFailure(String(e)));
  }, [seed]);

  useEffect(() => {
    if (progress.stage === 'error') setFailure(progress.detail);
    if (!ready) return;
    setStartupMs(performance.now());
    api.get<Canal>('sim/canal').then(setCanal).catch((e) => setFailure(String(e)));
    api.get<Collection>('collections/bow').then(setMeta);
  }, [ready, progress.stage, progress.detail]);

  useEffect(() => {
    if (!ready) return;
    const h = setInterval(() => api.get<ClockState>('sim/clock').then(setClock).catch(() => {}), POLL_MS);
    return () => clearInterval(h);
  }, [ready]);

  const route = useMemo(() => (canal ? routeWkt(canal) : null), [canal]);
  const nowUnix = clock ? Date.parse(clock.now) / 1000 : null;
  const live = useLive(ready && !!clock, route, windowHours, nowUnix);

  const changes = useMemo(() => {
    const c = results['analysis-changes'];
    if (!c || typeof c === 'string') return [];
    const t = times(c), pos = positions(c), cats = categories(c, 'cause');
    const cause = c.ranges.cause.values as number[];
    return t.map((x, i) => ({ t: x, lon: pos[i][0], lat: pos[i][1], cause: cats[cause[i]] }));
  }, [results]);
  const clusters = useMemo(() => {
    const c = results['analysis-clusters'];
    if (!c || typeof c === 'string') return null;
    return { t: times(c), c: c.ranges.cluster.values as number[] };
  }, [results]);
  const marks = changes.map((c) => ({ t: c.t, color: c.cause === 'place' ? '#e15759' : '#4e79a7' }));

  async function setRate(rate: number) {
    setClock(await api.put<ClockState>('sim/clock', { rate }));
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>Narrowlog</h1>
          <span>canal barge weather demonstrator</span>
        </div>
        {clock && (
          <div className="clock" aria-label="Simulation clock">
            <span className="now" data-testid="sim-now">{clock.now.replace('T', ' ').replace('Z', ' UTC')}</span>
            <span className="rates">
              {clock.statement.rates.map((r) => (
                <button key={r} className={r === clock.rate ? 'on' : ''} onClick={() => setRate(r)} title={`${r} simulated seconds per real second`}>
                  {r === 0 ? 'pause' : `${r}×`}
                </button>
              ))}
            </span>
            <span className="store">{clock.records.bow?.toLocaleString()} + {clock.records.stern?.toLocaleString()} records · {((clock.store_bytes ?? 0) / 1e6).toFixed(1)} MB in {clock.files} logger files · seed {clock.seed}</span>
          </div>
        )}
      </header>
      <p className="fiction">Fictional canal, fictional places, synthetic weather. A system and architecture demonstrator, not a weather or navigation product.</p>
      {!ready || !canal ? (
        <div className="loading" role="status">
          {failure ? (
            <p className="error">Could not start: {failure}</p>
          ) : (
            <>
              <p>Starting the demonstrator in this browser tab. No chart is shown until the backend is running.</p>
              <progress max={100} value={progress.pct} />
              <p data-testid="progress">{progress.stage}: {progress.detail}</p>
              <p className="hint">The first visit downloads the Python runtime and numpy (about 12 MB) from this site; the workspace's libraries load only when you open it. Budget: {STARTUP_BUDGET_MS / 1000} s.</p>
            </>
          )}
        </div>
      ) : (
        <>
          <nav role="tablist">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
            ))}
            {tab === 'Live' && (
              <span className="window">
                window{' '}
                {WINDOWS.map((w) => (
                  <button key={w} className={w === windowHours ? 'on' : ''} onClick={() => { setWindowHours(w); setXRange(null); }}>{w} h</button>
                ))}
                {xRange && <button onClick={() => setXRange(null)}>follow live</button>}
              </span>
            )}
          </nav>
          {live.error && <p className="error">{live.error}</p>}
          <main>
            {tab === 'Live' && route && (
              <LivePanel canal={canal} meta={meta} bow={live.bow} stern={live.stern} xRange={xRange} setXRange={setXRange}
                cursorT={cursorT} setCursorT={setCursorT} colourBy={colourBy} setColourBy={setColourBy} marks={marks}
                clusters={clusters} changes={changes} />
            )}
            {tab === 'Analysis' && route && <AnalysisPanel route={route} results={results} setResults={setResults} />}
            {tab === 'Workspace' && <WorkspacePanel seam={seam.current} />}
            {tab === 'Seam' && <SeamPanel seam={seam.current} startupMs={startupMs} />}
            {tab === 'About' && <AboutPanel />}
          </main>
        </>
      )}
    </div>
  );
}
