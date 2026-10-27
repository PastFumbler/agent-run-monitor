// Per-tile update throttling for the multiviewer (docs/PLAN.md 5.3 and 5.6).
//
// A tile does not re-render on every store change. useThrottledStore() subscribes to the store
// directly and commits a new value at most once per interval; while paused (off-screen, behind a
// maximised tile, window hidden) it commits nothing and the tile keeps showing what it had. When it
// is resumed it catches up at once. useTilePolicy() does the same for the clocks that components inside
// a tile run themselves (call chip and lattice loader timers).

import { useEffect, useMemo, useRef, useState } from 'react';
import { INTERVAL_HIDDEN, type MotionPolicy } from '../../motion/policy';
import { useStore, type AppState } from '../../store/store';

/** Unfocused tiles in low-GPU mode refresh this often ("frozen" in between). */
export const LOW_GPU_UNFOCUSED_MS = 3000;

export interface TileRate {
  /** Minimum ms between renders of the tile's content. */
  intervalMs: number;
  /** Whether the tile is on the slow low-GPU schedule (show the "updates every 3 s" badge). */
  slow: boolean;
}

/**
 * How often a tile may re-render: the policy's interval (250 ms normally, 1 s in low-GPU mode, 5 s
 * while hidden); in low-GPU mode only the focused tile gets that rate and the others refresh every 3 s.
 */
export function tileRate(policy: Pick<MotionPolicy, 'lowGpu' | 'updateIntervalMs'>, focused: boolean): TileRate {
  const slow = policy.lowGpu && !focused;
  return { intervalMs: slow ? Math.max(LOW_GPU_UNFOCUSED_MS, policy.updateIntervalMs) : policy.updateIntervalMs, slow };
}

/**
 * Ms from `now` to the next multiple of `intervalMs` on the wall clock (0 when exactly on one). Slow
 * tiles refresh only on these boundaries, so they all refresh together and stay frozen in between,
 * whether the change is new data or a ticking timer.
 */
export function msToBoundary(now: number, intervalMs: number): number {
  if (!(intervalMs > 0)) return 0;
  return (intervalMs - (now % intervalMs)) % intervalMs;
}

/**
 * The motion policy a tile's contents see. Live timers inside a tile (call chips, the lattice loader)
 * run their own 1 s clocks and stop only while `hidden`, so a tile that must not update tells them it
 * is hidden:
 * - paused (off-screen, behind a maximised tile, window hidden): hidden and still, nothing animates;
 * - slow (unfocused in low-GPU mode): hidden as far as those clocks go, and refreshed by the tile every
 *   3 s instead (useTilePolicy hands out a new object), so the tile really is frozen in between;
 * - otherwise the app's policy, unchanged (same object).
 */
export function tilePolicy(policy: MotionPolicy, opts: { paused: boolean; slow: boolean }): MotionPolicy {
  if (opts.paused) {
    return {
      ...policy,
      hidden: true,
      animate: false,
      duration: 0,
      allowInfinite: false,
      allowLayered: false,
      updateIntervalMs: Math.max(policy.updateIntervalMs, INTERVAL_HIDDEN),
    };
  }
  if (opts.slow) {
    return { ...policy, hidden: true, allowInfinite: false, updateIntervalMs: Math.max(LOW_GPU_UNFOCUSED_MS, policy.updateIntervalMs) };
  }
  return policy;
}

/**
 * tilePolicy() as a hook: the same object while nothing changes; while slow and live, a new one on every
 * `rate.intervalMs` boundary of the wall clock (in step with useThrottledStore's slow commits).
 */
export function useTilePolicy(policy: MotionPolicy, paused: boolean, rate: TileRate): MotionPolicy {
  const [refresh, setRefresh] = useState(0);
  const { slow, intervalMs } = rate;
  useEffect(() => {
    if (!slow || paused) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(
        () => {
          setRefresh((n) => n + 1);
          arm();
        },
        msToBoundary(Date.now(), intervalMs) || intervalMs,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [slow, paused, intervalMs]);
  return useMemo(
    () => tilePolicy(policy, { paused, slow }),
    // `refresh` is a dependency on purpose: each tick hands the tile's contents a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [policy, paused, slow, refresh],
  );
}

/** Why a tile is paused, or null when it is live. */
export type PauseReason = 'hidden' | 'offscreen' | 'behind-maximized' | null;

export function pauseReason(opts: { windowHidden: boolean; inView: boolean; maximizedId: string | null; id: string }): PauseReason {
  if (opts.windowHidden) return 'hidden';
  if (opts.maximizedId && opts.maximizedId !== opts.id) return 'behind-maximized';
  if (!opts.inView) return 'offscreen';
  return null;
}

/**
 * Like useStore(selector), but commits changes at most once every `intervalMs` (trailing edge, so the
 * newest value always lands) and not at all while `paused`. The first value after nothing (null or
 * undefined, e.g. a detail that just loaded) lands at once, so a slow tile never sits on "Loading…".
 * `deps` must list everything the selector closes over (e.g. the run id). With `aligned`, changes land
 * on the next `intervalMs` boundary of the wall clock instead (see msToBoundary).
 */
export function useThrottledStore<T>(
  selector: (s: AppState) => T,
  intervalMs: number,
  paused: boolean,
  deps: readonly unknown[],
  aligned = false,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const [value, setValue] = useState<T>(() => selector(useStore.getState()));

  useEffect(() => {
    const read = () => selectorRef.current(useStore.getState());
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = Date.now();
    let shown: T = read();
    const commit = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      last = Date.now();
      const v = read();
      shown = v;
      setValue((prev) => (Object.is(prev, v) ? prev : v));
    };
    // Catch up straight away: on mount, when resumed, and when the selector's inputs change.
    commit();
    if (paused) return undefined;
    const unsubscribe = useStore.subscribe((state, prev) => {
      const sel = selectorRef.current;
      const next = sel(state);
      if (Object.is(next, sel(prev))) return;
      if (shown == null && next != null) {
        commit();
        return;
      }
      if (timer) return;
      const now = Date.now();
      // Aligned: the next boundary, or the one after if this boundary's commit has just happened.
      const wait = aligned ? msToBoundary(now, intervalMs) || (now - last < intervalMs ? intervalMs : 0) : Math.max(0, last + intervalMs - now);
      timer = setTimeout(commit, wait);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, intervalMs, aligned, ...deps]);

  return value;
}
