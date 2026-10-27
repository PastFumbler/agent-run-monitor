// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { computeMotionPolicy } from '../../motion/policy';
import { resetStore, useStore, type AppState } from '../../store/store';
import { LOW_GPU_UNFOCUSED_MS, msToBoundary, pauseReason, tilePolicy, tileRate, useThrottledStore, useTilePolicy } from './throttle';

const policy = (o: { lowGpu?: boolean; hidden?: boolean }) =>
  computeMotionPolicy({ reduceMotion: 'off', lowGpu: o.lowGpu ? 'on' : 'off', osReducedMotion: false, power: null, hidden: !!o.hidden });

/** The store's search tick is a convenient number to drive the hook with. */
const bump = () => act(() => useStore.getState().focusSearch());
const tick = (s: AppState) => s.searchFocusTick;

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  useStore.setState({ searchFocusTick: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('tileRate', () => {
  it('normal: every tile at the policy rate (250 ms)', () => {
    expect(tileRate(policy({}), true)).toEqual({ intervalMs: 250, slow: false });
    expect(tileRate(policy({}), false)).toEqual({ intervalMs: 250, slow: false });
  });

  it('low GPU: the focused tile at 1 s, the others every 3 s', () => {
    expect(tileRate(policy({ lowGpu: true }), true)).toEqual({ intervalMs: 1000, slow: false });
    expect(tileRate(policy({ lowGpu: true }), false)).toEqual({ intervalMs: LOW_GPU_UNFOCUSED_MS, slow: true });
  });

  it('hidden window: 5 s for everyone (and the tiles are paused anyway)', () => {
    expect(tileRate(policy({ hidden: true }), true).intervalMs).toBe(5000);
    expect(tileRate(policy({ hidden: true, lowGpu: true }), false).intervalMs).toBe(5000);
  });
});

describe('pauseReason', () => {
  const base = { windowHidden: false, inView: true, maximizedId: null as string | null, id: 'a' };
  it('live when visible, in view and not covered', () => {
    expect(pauseReason(base)).toBeNull();
    expect(pauseReason({ ...base, maximizedId: 'a' })).toBeNull();
  });
  it('paused when hidden, off-screen or behind a maximised tile', () => {
    expect(pauseReason({ ...base, windowHidden: true })).toBe('hidden');
    expect(pauseReason({ ...base, inView: false })).toBe('offscreen');
    expect(pauseReason({ ...base, maximizedId: 'b' })).toBe('behind-maximized');
  });
});

describe('tilePolicy', () => {
  it('a live tile on the normal schedule sees the app policy itself', () => {
    const p = policy({});
    expect(tilePolicy(p, { paused: false, slow: false })).toBe(p);
  });
  it('a paused tile looks hidden and still to its contents, so their own clocks stop', () => {
    const t = tilePolicy(policy({}), { paused: true, slow: false });
    expect(t).toMatchObject({ hidden: true, animate: false, duration: 0, allowInfinite: false, allowLayered: false });
    expect(t.updateIntervalMs).toBeGreaterThanOrEqual(5000);
  });
  it('a slow low-GPU tile stops its own clocks but may still fade (opacity only)', () => {
    const p = policy({ lowGpu: true });
    const t = tilePolicy(p, { paused: false, slow: true });
    expect(t).toMatchObject({ hidden: true, animate: p.animate, duration: p.duration, allowInfinite: false });
    expect(t.updateIntervalMs).toBe(LOW_GPU_UNFOCUSED_MS);
  });
});

describe('msToBoundary', () => {
  it('counts to the next multiple of the interval', () => {
    expect(msToBoundary(3000, 3000)).toBe(0);
    expect(msToBoundary(3001, 3000)).toBe(2999);
    expect(msToBoundary(5999, 3000)).toBe(1);
    expect(msToBoundary(123, 0)).toBe(0);
  });
});

describe('useTilePolicy', () => {
  it('renews the object on every 3 s boundary while slow and live, and never while paused', () => {
    vi.setSystemTime(LOW_GPU_UNFOCUSED_MS * 1_000_000);
    const p = policy({ lowGpu: true });
    const slow = tileRate(p, false);
    const { result, rerender } = renderHook(({ paused }) => useTilePolicy(p, paused, slow), { initialProps: { paused: false } });
    const first = result.current;
    act(() => vi.advanceTimersByTime(LOW_GPU_UNFOCUSED_MS - 10));
    expect(result.current).toBe(first);
    act(() => vi.advanceTimersByTime(20));
    expect(result.current).not.toBe(first);
    rerender({ paused: true });
    const paused = result.current;
    act(() => vi.advanceTimersByTime(10 * LOW_GPU_UNFOCUSED_MS));
    expect(result.current).toBe(paused);
  });
  it('is the app policy, unchanged and stable, for a focused tile', () => {
    const p = policy({ lowGpu: true });
    const { result } = renderHook(() => useTilePolicy(p, false, tileRate(p, true)));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(p);
  });
});

describe('useThrottledStore (aligned, for slow tiles)', () => {
  it('lands changes only on interval boundaries of the wall clock', () => {
    // Renders are seen at the end of each 50 ms step, so a boundary commit shows up on a boundary.
    vi.setSystemTime(LOW_GPU_UNFOCUSED_MS * 1_000_000 + 1000);
    const commits: number[] = [];
    const { result } = renderHook(() => {
      const v = useThrottledStore(tick, LOW_GPU_UNFOCUSED_MS, false, [], true);
      commits.push(Date.now());
      return v;
    });
    commits.length = 0;
    for (let i = 0; i < 200; i++) {
      if (i % 5 === 0) bump(); // a change every 250 ms for 10 s
      act(() => vi.advanceTimersByTime(50));
    }
    for (let i = 0; i < LOW_GPU_UNFOCUSED_MS / 50; i++) act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe(40);
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits.length).toBeLessThanOrEqual(4);
    for (const t of commits) expect(t % LOW_GPU_UNFOCUSED_MS).toBe(0);
  });
});

describe('useThrottledStore', () => {
  it('starts with the current value', () => {
    useStore.setState({ searchFocusTick: 7 });
    const { result } = renderHook(() => useThrottledStore(tick, 250, false, []));
    expect(result.current).toBe(7);
  });

  it('commits at most once per interval, always landing on the newest value', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useThrottledStore(tick, 250, false, []);
    });
    const base = renders;
    // Ten changes inside one interval...
    for (let i = 0; i < 10; i++) {
      bump();
      act(() => vi.advanceTimersByTime(20));
    }
    // ...land as a single render with the last value.
    act(() => vi.advanceTimersByTime(250));
    expect(result.current).toBe(10);
    expect(renders - base).toBe(1);
  });

  it('does not render more often than the interval under a steady stream', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useThrottledStore(tick, 1000, false, []);
    });
    const base = renders;
    for (let i = 0; i < 50; i++) {
      bump();
      act(() => vi.advanceTimersByTime(100)); // 5 s of changes every 100 ms
    }
    act(() => vi.advanceTimersByTime(1000));
    expect(renders - base).toBeGreaterThanOrEqual(4);
    expect(renders - base).toBeLessThanOrEqual(6);
  });

  it('a change after a quiet spell shows without waiting a full interval', () => {
    const { result } = renderHook(() => useThrottledStore(tick, 3000, false, []));
    act(() => vi.advanceTimersByTime(5000));
    bump();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe(1);
  });

  it('paused: frozen, then catches up at once when resumed', () => {
    const { result, rerender } = renderHook(({ paused }) => useThrottledStore(tick, 250, paused, []), { initialProps: { paused: true } });
    bump();
    bump();
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(0);
    rerender({ paused: false });
    expect(result.current).toBe(2);
  });

  it('the first value after nothing lands at once, even on the slow schedule', () => {
    useStore.setState({ tileViews: {} });
    const { result } = renderHook(() => useThrottledStore((s) => s.tileViews.a, 3000, false, []));
    expect(result.current).toBeUndefined();
    act(() => useStore.getState().setTileView('a', 'files'));
    expect(result.current).toBe('files');
    // Later changes wait for the interval again.
    act(() => useStore.getState().setTileView('a', 'tools'));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe('files');
    act(() => vi.advanceTimersByTime(2100));
    expect(result.current).toBe('tools');
  });

  it('ignores store changes the selector does not care about', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useThrottledStore((s) => s.multi.length, 250, false, []);
    });
    const base = renders;
    for (let i = 0; i < 5; i++) bump();
    act(() => vi.advanceTimersByTime(1000));
    expect(renders - base).toBe(0);
  });

  it('re-reads when its inputs (deps) change', () => {
    useStore.setState({ tileViews: { a: 'files', b: 'tools' } });
    const { result, rerender } = renderHook(({ id }) => useThrottledStore((s) => s.tileViews[id], 250, false, [id]), {
      initialProps: { id: 'a' },
    });
    expect(result.current).toBe('files');
    rerender({ id: 'b' });
    expect(result.current).toBe('tools');
  });
});
