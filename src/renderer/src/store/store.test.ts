import { beforeEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { normalizeSettings } from '@shared/settings';
import { goBack, showAllRuns, showUsage } from './actions';
import { buildSections } from './selectors';
import { RECENT_KEY, RECENT_MAX, resetStore, useStore } from './store';

const NOW = new Date(2026, 9, 27, 15, 30).getTime();
const H = 3_600_000;
const mk = (id: string, ago: number): RunSummary => ({
  id,
  agent: 'codex',
  title: id,
  projectName: 'todo-cli',
  startedAt: NOW - ago - H,
  updatedAt: NOW - ago,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: `/home/demo/${id}`,
});

const recentShown = (on: boolean) => {
  const st = useStore.getState();
  const all = st.order.map((id) => st.runs[id]);
  return buildSections(all, [], st.recent, NOW, on)
    .find((s) => s.id === 'recent')
    ?.runs.map((r) => r.id);
};

describe('Recent list', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    useStore.getState().setRuns([mk('a', 1 * H), mk('b', 2 * H), mk('c', 3 * H)]);
  });

  // Regression: clicking a run in Recent used to move it to the top.
  it('opening a run that is already in Recent never reorders it', () => {
    const { openRun } = useStore.getState();
    openRun('c');
    openRun('b');
    openRun('a');
    expect(useStore.getState().recent).toEqual(['a', 'b', 'c']);
    const before = { on: recentShown(true), off: recentShown(false) };
    openRun('c'); // the bottom one
    openRun('b');
    expect(useStore.getState().recent).toEqual(['a', 'b', 'c']);
    expect(useStore.getState().currentId).toBe('b');
    expect(recentShown(true)).toEqual(before.on);
    expect(recentShown(false)).toEqual(before.off);
    expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')).toEqual(['a', 'b', 'c']);
  });

  it('a newly opened run goes on top; the list stays capped', () => {
    const { openRun } = useStore.getState();
    for (let i = 0; i < RECENT_MAX; i++) openRun(`x${i}`);
    openRun('a');
    const recent = useStore.getState().recent;
    expect(recent[0]).toBe('a');
    expect(recent).toHaveLength(RECENT_MAX);
    expect(recent).not.toContain('x0');
  });
});

describe('moveUpdatedToTop setting', () => {
  it('defaults to on and falls back to on when invalid', () => {
    expect(normalizeSettings({}).moveUpdatedToTop).toBe(true);
    expect(normalizeSettings({ moveUpdatedToTop: 'no' }).moveUpdatedToTop).toBe(true);
    expect(normalizeSettings({ moveUpdatedToTop: false }).moveUpdatedToTop).toBe(false);
  });
});

describe('goBack between All runs and Usage', () => {
  beforeEach(() => resetStore());

  it('returns to the screen it came from, then goes home instead of bouncing between the two', () => {
    showUsage();
    showAllRuns();
    goBack();
    expect(useStore.getState().route).toBe('usage');
    goBack();
    expect(useStore.getState().route).toBe('dashboard');

    showAllRuns();
    showUsage();
    goBack();
    expect(useStore.getState().route).toBe('runs');
    goBack();
    expect(useStore.getState().route).toBe('dashboard');
  });

  it('returns to Usage from Settings', () => {
    showUsage();
    useStore.getState().setRoute('settings');
    goBack();
    expect(useStore.getState().route).toBe('usage');
  });
});
