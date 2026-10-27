// @vitest-environment jsdom
// The multiviewer asks the backend for live detail of the tiles that can be seen, and no others:
// this page only, minus tiles behind a maximised one and tiles scrolled out of view.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Backend } from '@shared/ipc';
import type { RunSummary } from '@shared/schema';
import { setBackendForTests } from '../../backend';
import { MotionPolicyContext } from '../../motion/context';
import { computeMotionPolicy } from '../../motion/policy';
import { resetStore, useStore } from '../../store/store';
import { MultiView } from './MultiView';

const NOW = Date.UTC(2026, 9, 27, 15, 30);

const run = (i: number): RunSummary => ({
  id: `codex:${i}`,
  agent: 'codex',
  title: `Task ${i}`,
  projectName: 'demo',
  startedAt: NOW - 60_000,
  updatedAt: NOW - i * 1000,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: `/tmp/${i}.jsonl`,
});

let watchCalls: string[][] = [];
let priorityCalls: [string[], number][] = [];
const lastPriority = () => priorityCalls[priorityCalls.length - 1];
const lastWatch = () => watchCalls[watchCalls.length - 1] ?? [];

const noop = () => () => {};
const stub = {
  getRun: async () => null,
  watchRuns: (ids: string[]) => {
    watchCalls.push([...ids].sort());
  },
  setUpdateInterval: () => {},
  setWatchPriority: (focused: string[], slowMs: number) => {
    priorityCalls.push([[...focused], slowMs]);
  },
  setSettings: async () => useStore.getState().settings,
  onRunsUpdate: noop,
  onRunDetail: noop,
  onPower: noop,
  onRunFinished: noop,
  onWindowVisibility: noop,
} as unknown as Backend;

/** A controllable IntersectionObserver: tests decide which tiles are in view. */
class FakeIO {
  static all: FakeIO[] = [];
  targets = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  static set(id: string, inView: boolean) {
    for (const io of FakeIO.all) {
      const el = [...io.targets].find((t) => (t as HTMLElement).dataset.tileId === id);
      if (el) io.cb([{ target: el, isIntersecting: inView } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    }
  }
}

function setup(count: number) {
  const runs = Array.from({ length: count }, (_, i) => run(i + 1));
  useStore.setState({
    runs: Object.fromEntries(runs.map((r) => [r.id, r])),
    runsLoaded: true,
    multi: runs.map((r) => r.id),
    route: 'multiview',
  });
  render(<MultiView />);
  return runs.map((r) => r.id);
}

const tileEl = (id: string) => document.querySelector<HTMLElement>(`[data-tile-id="${id}"]`)!;

beforeEach(() => {
  resetStore();
  watchCalls = [];
  priorityCalls = [];
  FakeIO.all = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  setBackendForTests(stub);
});

afterEach(() => {
  cleanup();
  setBackendForTests(null);
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe('MultiView watch set', () => {
  it('watches every tile on the page when all are in view', () => {
    const ids = setup(4);
    expect(document.querySelector('[data-testid="mv-grid"]')!.getAttribute('data-grid')).toBe('2x2');
    expect(lastWatch()).toEqual([...ids].sort());
  });

  it('watches only the maximised tile; the others are hidden and paused', () => {
    const ids = setup(4);
    act(() => useStore.getState().setMaximizedTile(ids[1]));
    expect(lastWatch()).toEqual([ids[1]]);
    for (const id of [ids[0], ids[2], ids[3]]) {
      expect(tileEl(id).hidden).toBe(true);
      expect(tileEl(id).getAttribute('data-paused')).toBe('behind-maximized');
    }
    expect(tileEl(ids[1]).hasAttribute('data-paused')).toBe(false);
    act(() => useStore.getState().setMaximizedTile(null));
    expect(lastWatch()).toEqual([...ids].sort());
  });

  it('drops tiles scrolled out of view and takes them back when they return', () => {
    const ids = setup(6);
    act(() => FakeIO.set(ids[5], false));
    expect(lastWatch()).toEqual(ids.slice(0, 5).sort());
    expect(tileEl(ids[5]).getAttribute('data-paused')).toBe('offscreen');
    act(() => FakeIO.set(ids[5], true));
    expect(lastWatch()).toEqual([...ids].sort());
    expect(tileEl(ids[5]).hasAttribute('data-paused')).toBe(false);
  });

  it('watches only the current page', () => {
    const ids = setup(13);
    expect(lastWatch()).toEqual(ids.slice(0, 12).sort());
    act(() => useStore.getState().setMultiPage(1));
    expect(lastWatch()).toEqual([ids[12]]);
  });

  it('watches nothing once the multiviewer closes', () => {
    setup(3);
    cleanup();
    expect(lastWatch()).toEqual([]);
  });
});

describe('MultiView watch priority (low GPU)', () => {
  const lowGpuPolicy = computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'on', osReducedMotion: false, power: null, hidden: false });

  function setupLowGpu(count: number) {
    const runs = Array.from({ length: count }, (_, i) => run(i + 1));
    useStore.setState({
      runs: Object.fromEntries(runs.map((r) => [r.id, r])),
      runsLoaded: true,
      multi: runs.map((r) => r.id),
      route: 'multiview',
    });
    render(
      <MotionPolicyContext.Provider value={lowGpuPolicy}>
        <MultiView />
      </MotionPolicyContext.Provider>,
    );
    return runs.map((r) => r.id);
  }

  it('asks main to slow the unfocused tiles, follows the focus and clears on close', () => {
    const ids = setupLowGpu(4);
    expect(lastPriority()).toEqual([[ids[0]], 3000]);
    act(() => useStore.getState().setFocusedTile(ids[2]));
    expect(lastPriority()).toEqual([[ids[2]], 3000]);
    cleanup();
    expect(lastPriority()).toEqual([[], 0]);
  });

  it('sets no slow tiles when low GPU mode is off', () => {
    setup(4);
    expect(priorityCalls.length).toBeGreaterThan(0);
    expect(priorityCalls.every(([f, ms]) => f.length === 0 && ms === 0)).toBe(true);
  });
});
