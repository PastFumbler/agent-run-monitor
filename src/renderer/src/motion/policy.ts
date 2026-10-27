// The motion policy: one decision, read by every animated component (docs/PLAN.md 5.6).
// Pure so it can be unit-tested; useMotionPolicy() feeds it the live inputs.

import type { PowerState } from '@shared/ipc';
import type { TriState } from '@shared/settings';

export interface MotionInputs {
  /** settings.reduceMotion */
  reduceMotion: TriState;
  /** settings.lowGpu */
  lowGpu: TriState;
  /** matchMedia('(prefers-reduced-motion: reduce)').matches, live. */
  osReducedMotion: boolean;
  /** Backend power state; null until known. */
  power: PowerState | null;
  /** Window hidden or minimised (document visibility or the backend's window signal). */
  hidden: boolean;
}

export interface MotionPolicy {
  /** Accessibility: no movement. */
  reduce: boolean;
  /** Performance: opacity/transform only, short, no infinite loops, no blur/filter/shadow layers. */
  lowGpu: boolean;
  /** Window hidden: everything stops. */
  hidden: boolean;
  /** Whether anything should animate at all. */
  animate: boolean;
  /** Standard transition length in ms (0 = instant). */
  duration: number;
  /** Infinite loops (spinners, shimmer, breathing). */
  allowInfinite: boolean;
  /** Layered effects: shadows, blur, filters, backdrop-filter. */
  allowLayered: boolean;
  /** Minimum ms between live pushes from the backend. */
  updateIntervalMs: number;
}

export const DURATION_NORMAL = 200;
export const DURATION_LOW_GPU = 120;
export const INTERVAL_NORMAL = 250;
export const INTERVAL_LOW_GPU = 1000;
export const INTERVAL_HIDDEN = 5000;

const resolve = (t: TriState, auto: boolean) => (t === 'on' ? true : t === 'off' ? false : auto);

export function computeMotionPolicy(i: MotionInputs): MotionPolicy {
  const reduce = resolve(i.reduceMotion, i.osReducedMotion);
  const powerAuto = !!i.power && i.power.known && (i.power.onBattery || i.power.powerSaver);
  const lowGpu = resolve(i.lowGpu, powerAuto);
  const hidden = i.hidden;
  const animate = !reduce && !hidden;
  return {
    reduce,
    lowGpu,
    hidden,
    animate,
    duration: !animate ? 0 : lowGpu ? DURATION_LOW_GPU : DURATION_NORMAL,
    allowInfinite: animate && !lowGpu,
    allowLayered: !lowGpu && !hidden,
    updateIntervalMs: hidden ? INTERVAL_HIDDEN : lowGpu ? INTERVAL_LOW_GPU : INTERVAL_NORMAL,
  };
}

/** What components get when no provider is mounted (unit tests): full motion, visible. */
export const DEFAULT_POLICY: MotionPolicy = computeMotionPolicy({
  reduceMotion: 'off',
  lowGpu: 'off',
  osReducedMotion: false,
  power: null,
  hidden: false,
});
