// The value-add diamond (VS-22, VS-23): a small cut gem in the top-right corner
// of each value-add item. Every few seconds it glints: a four-pointed sparkle
// swells and turns, the top facet flashes and a gold glow pulses. Diamonds on
// screen together are staggered so they twinkle in turn. They belong to the
// frame, not the system, so they keep glinting while the simulation is paused.
// Under reduced motion they show a still sparkle. Animated with SVG SMIL, not CSS.
import { useEffect, useId, useState } from 'react';

const PERIOD_S = 2;
const STEP_S = 0.45;
let mounted = 0;

export function Diamond({ size = 24, className = '', label = 'value-add diamond' }: { size?: number; className?: string; label?: string }) {
  // Each diamond takes the next slot in the cycle as it mounts: neighbours glint in turn.
  const [delay] = useState(() => ((mounted++ * STEP_S) % PERIOD_S).toFixed(2));
  useEffect(() => () => void (mounted = Math.max(0, mounted - 1)), []);
  const clip = `gem-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const GEM = 'M6 5 H18 L23 10.5 L12 23 L1 10.5 Z';
  const reduced = prefersReducedMotion();
  // SMIL animation, inside the graphic itself: it runs wherever SVG renders, independent of
  // the page's CSS. One cycle every PERIOD_S; the glint occupies the last third of it.
  const anim = { begin: `${delay}s`, dur: `${PERIOD_S}s`, repeatCount: 'indefinite', calcMode: 'spline' as const };
  const kt = '0;0.35;0.6;0.85;1';
  const ks = '0 0 1 1;0.4 0 0.2 1;0.4 0 0.2 1;0 0 1 1';
  return (
    <svg className={`diamond ${className}`} width={size} height={size} viewBox="-4 -4 32 32" role="img" aria-label={label} data-testid="diamond">
      {/* The gold glow behind the gem pulses as it glints. */}
      <circle cx={12} cy={13} r={13} fill="#facc15" opacity={0}>
        {!reduced && <animate attributeName="opacity" values="0;0;0.55;0;0" keyTimes={kt} keySplines={ks} {...anim} />}
      </circle>
      <path d={GEM} fill="#d6efff" stroke="#1f5f99" strokeWidth={1.4} strokeLinejoin="round" />
      <path d="M6 5 H18 L15.5 10.5 H8.5 Z" fill="#f4fbff" stroke="#1f5f99" strokeWidth={0.9} strokeLinejoin="round">
        {!reduced && <animate attributeName="fill" values="#f4fbff;#f4fbff;#fff3a3;#f4fbff;#f4fbff" keyTimes={kt} keySplines={ks} {...anim} />}
      </path>
      <path d="M1 10.5 H23 M8.5 10.5 L12 23 L15.5 10.5 M6 5 L8.5 10.5 M18 5 L15.5 10.5 M12 5 L8.5 10.5 M12 5 L15.5 10.5" fill="none" stroke="#1f5f99" strokeWidth={0.9} strokeLinejoin="round" />
      <path d="M3.5 10.5 L8.5 10.5 L12 23 Z" fill="#a9d7f5" opacity={0.7} />
      {/* A band of light sweeps across the gem, clipped to its outline. */}
      <clipPath id={clip}><path d={GEM} /></clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect x={-14} y={-6} width={7} height={38} fill="#fff" opacity={0.95} transform="rotate(25 12 13)">
          {!reduced && <animate attributeName="x" values="-14;-14;10;34;34" keyTimes={kt} keySplines={ks} {...anim} />}
        </rect>
      </g>
      {/* The four-pointed sparkle swells and turns. */}
      <g transform="translate(19 4)">
        <path d="M0 -7 L1.3 -1.3 L7 0 L1.3 1.3 L0 7 L-1.3 1.3 L-7 0 L-1.3 -1.3 Z" fill="#fffbe6" stroke="#b45309" strokeWidth={0.9} strokeLinejoin="round"
          transform={reduced ? 'rotate(45) scale(0.85)' : 'scale(0)'}>
          {!reduced && <>
            <animateTransform attributeName="transform" type="rotate" values="0;0;60;120;120" keyTimes={kt} keySplines={ks} {...anim} />
            <animateTransform attributeName="transform" type="scale" additive="sum" values="0;0;1.5;0;0" keyTimes={kt} keySplines={ks} {...anim} />
          </>}
        </path>
      </g>
    </svg>
  );
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
