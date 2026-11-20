// The value-add diamond (VS-22, VS-23): a small cut gem in the top-right corner
// of each value-add item. Every few seconds it glints: a four-pointed sparkle
// swells and turns, the top facet flashes and a gold glow pulses. Diamonds on
// screen together are staggered so they twinkle in turn. They belong to the
// frame, not the system, so they keep glinting while the simulation is paused.
// Under reduced motion (CSS) they show a still sparkle.
import { useEffect, useId, useState } from 'react';

const PERIOD_S = 3.6;
const STEP_S = 0.7;
let mounted = 0;

export function Diamond({ size = 24, className = '', label = 'value-add diamond' }: { size?: number; className?: string; label?: string }) {
  // Each diamond takes the next slot in the cycle as it mounts: neighbours glint in turn.
  const [delay] = useState(() => ((mounted++ * STEP_S) % PERIOD_S).toFixed(2));
  useEffect(() => () => void (mounted = Math.max(0, mounted - 1)), []);
  const clip = `gem-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const GEM = 'M6 5 H18 L23 10.5 L12 23 L1 10.5 Z';
  return (
    <svg className={`diamond ${className}`} width={size} height={size} viewBox="-2 -2 28 28" role="img" aria-label={label} data-testid="diamond"
      style={{ ['--glint-delay' as string]: `${delay}s`, ['--glint-period' as string]: `${PERIOD_S}s` }}>
      <g className="diamond-glow">
        <path d="M6 5 H18 L23 10.5 L12 23 L1 10.5 Z" fill="#d6efff" stroke="#1f5f99" strokeWidth={1.4} strokeLinejoin="round" />
        <path className="diamond-top" d="M6 5 H18 L15.5 10.5 H8.5 Z" fill="#f4fbff" stroke="#1f5f99" strokeWidth={0.9} strokeLinejoin="round" />
        <path d="M1 10.5 H23 M8.5 10.5 L12 23 L15.5 10.5 M6 5 L8.5 10.5 M18 5 L15.5 10.5 M12 5 L8.5 10.5 M12 5 L15.5 10.5" fill="none" stroke="#1f5f99" strokeWidth={0.9} strokeLinejoin="round" />
        <path d="M3.5 10.5 L8.5 10.5 L12 23 Z" fill="#a9d7f5" opacity={0.7} />
        {/* The glint: a band of light sweeps across the gem, clipped to its outline. */}
        <clipPath id={clip}><path d={GEM} /></clipPath>
        <g clipPath={`url(#${clip})`}>
          <rect className="diamond-shine" x={-14} y={-4} width={7} height={34} fill="#fff" transform="rotate(25 12 13)" />
        </g>
      </g>
      <g transform="translate(19 4)">
        <path className="diamond-sparkle" d="M0 -7 L1.3 -1.3 L7 0 L1.3 1.3 L0 7 L-1.3 1.3 L-7 0 L-1.3 -1.3 Z" fill="#fffbe6" stroke="#b45309" strokeWidth={0.9} strokeLinejoin="round" />
      </g>
    </svg>
  );
}
