// The value-add diamond (VS-22, VS-23): a small cut gem in the top-right corner
// of each value-add item. Every few seconds it glints: a four-pointed sparkle
// swells and turns, the top facet flashes and a gold glow pulses. Diamonds on
// screen together are staggered so they twinkle in turn. They belong to the
// frame, not the system, so they keep glinting while the simulation is paused.
// Under reduced motion (CSS) they show a still sparkle.
import { useEffect, useState } from 'react';

const PERIOD_S = 5;
const STEP_S = 0.85;
let mounted = 0;

export function Diamond({ size = 24, className = '', label = 'value-add diamond' }: { size?: number; className?: string; label?: string }) {
  // Each diamond takes the next slot in the cycle as it mounts: neighbours glint in turn.
  const [delay] = useState(() => ((mounted++ * STEP_S) % PERIOD_S).toFixed(2));
  useEffect(() => () => void (mounted = Math.max(0, mounted - 1)), []);
  return (
    <svg className={`diamond ${className}`} width={size} height={size} viewBox="-2 -2 28 28" role="img" aria-label={label} data-testid="diamond"
      style={{ ['--glint-delay' as string]: `${delay}s`, ['--glint-period' as string]: `${PERIOD_S}s` }}>
      <g className="diamond-glow">
        <path d="M6 5 H18 L23 10.5 L12 23 L1 10.5 Z" fill="#d6efff" stroke="#1f5f99" strokeWidth={1.4} strokeLinejoin="round" />
        <path className="diamond-top" d="M6 5 H18 L15.5 10.5 H8.5 Z" fill="#f4fbff" stroke="#1f5f99" strokeWidth={0.9} strokeLinejoin="round" />
        <path d="M1 10.5 H23 M8.5 10.5 L12 23 L15.5 10.5 M6 5 L8.5 10.5 M18 5 L15.5 10.5 M12 5 L8.5 10.5 M12 5 L15.5 10.5" fill="none" stroke="#1f5f99" strokeWidth={0.9} strokeLinejoin="round" />
        <path d="M3.5 10.5 L8.5 10.5 L12 23 Z" fill="#a9d7f5" opacity={0.7} />
      </g>
      <g transform="translate(19 4)">
        <path className="diamond-sparkle" d="M0 -5.5 L1.1 -1.1 L5.5 0 L1.1 1.1 L0 5.5 L-1.1 1.1 L-5.5 0 L-1.1 -1.1 Z" fill="#fff" stroke="#a16207" strokeWidth={0.8} strokeLinejoin="round" />
      </g>
    </svg>
  );
}
