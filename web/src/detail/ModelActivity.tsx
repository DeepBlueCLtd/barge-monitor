// A model card's live activity (Models panel): the illustrative view inside the
// model and a busy indicator that turns while the model has a run in progress
// (4.7: models process each dataset on import, D-220; no simulation clock, D-302).
// Models now run rarely, so while the Models panel is open each card shows its
// work all the time, labelled 'showing its work' when no run is in progress.
import { useEffect, useState } from 'react';
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';
import { ModelInner } from './ModelInner';

export function ModelActivity({ model }: { model: string }) {
  const control = useStore(runtime.control);
  const phase = control?.models?.find((m) => m.id === model)?.phase ?? '';
  const working = phase !== '' && phase !== 'live' && phase !== 'failed';
  return (
    <>
      <ModelInner model={model} playing />
      <div className="summariesctivity" data-testid={`activity-${model}`} data-working={working}>
        <Busy on />
        <span className="model-quiet">{working ? 'working' : 'showing its work'}</span>
      </div>
    </>
  );
}

/** Turns for 0.5 s of every second while the model works. */
function Busy({ on }: { on: boolean }) {
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    if (!on) {
      setSpin(false);
      return;
    }
    let off: ReturnType<typeof setTimeout> | undefined;
    const pulse = () => {
      setSpin(true);
      off = setTimeout(() => setSpin(false), 500);
    };
    pulse();
    const every = setInterval(pulse, 1000);
    return () => {
      clearInterval(every);
      if (off) clearTimeout(off);
    };
  }, [on]);
  return (
    <svg className={`busy${spin ? ' spinning' : ''}`} width={22} height={22} viewBox="0 0 22 22" role="img" aria-label={spin ? 'busy' : 'idle'}>
      <circle cx={11} cy={11} r={8} fill="none" stroke="#e7d39a" strokeWidth={3} />
      <path d="M11 3 A8 8 0 0 1 19 11" fill="none" stroke="#a16207" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}
