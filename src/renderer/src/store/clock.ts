// A slow app clock for relative times and day sections. Ticks every 30 s while visible; components
// that need a faster clock (live timers) run their own, gated by the motion policy.

import { useEffect } from 'react';
import { create } from 'zustand';
import { nowMs } from '../backend/clock';

interface ClockState {
  now: number;
  tick(): void;
}

export const useClock = create<ClockState>()((set) => ({
  now: nowMs(),
  tick: () => set({ now: nowMs() }),
}));

export function useNow(): number {
  return useClock((s) => s.now);
}

/** Mount once (App). Stops while the window is hidden; catches up when shown. */
export function useClockDriver(hidden: boolean, everyMs = 30_000): void {
  useEffect(() => {
    if (hidden) return undefined;
    useClock.getState().tick();
    const id = setInterval(() => useClock.getState().tick(), everyMs);
    return () => clearInterval(id);
  }, [hidden, everyMs]);
}
