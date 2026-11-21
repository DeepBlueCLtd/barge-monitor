// A model card's live activity (Models panel): the illustrative view inside the
// model and a busy indicator that turns for half of each second while the
// simulation runs, and stands still when it is paused (FR-77).
import { useEffect, useState } from 'react';
import { simClock } from '../shell/clock';
import { useStore } from '../shell/store';
import { ModelInner } from './ModelInner';

export function ModelActivity({ model }: { model: string }) {
  const clock = useStore(simClock.state);
  const playing = !!clock?.playing;
  return (
    <>
      <ModelInner model={model} playing={playing} />
      <div className="model-activity" data-testid={`activity-${model}`}>
        <Busy on={playing} />
        <span className="model-quiet">{playing ? 'working' : 'paused'}</span>
      </div>
    </>
  );
}

/** Turns for 0.5 s of every second while the simulation plays. */
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
