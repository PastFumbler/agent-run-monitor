// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { defaultSettings, normalizeSettings, type Settings } from '@shared/settings';
import { setBackendForTests } from '../../backend';
import { FixtureBackend } from '../../backend/fixture';
import { resetStore, useStore } from '../../store/store';
import { cleanLayoutName, deleteLayout, openLayout, openStartupLayoutWhenReady, saveLayout } from './layouts';

const run = (id: string): RunSummary => ({
  id,
  agent: 'codex',
  title: id,
  projectName: 'p',
  startedAt: 1,
  updatedAt: 2,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: '/x',
});

const settings = (patch: Partial<Settings> = {}): Settings => normalizeSettings({ ...defaultSettings(), firstRunComplete: true, ...patch });

beforeEach(() => {
  resetStore();
  localStorage.clear();
  setBackendForTests(new FixtureBackend({ scenario: 'empty', live: false, fresh: true }));
});

afterEach(() => setBackendForTests(null));

describe('layouts', () => {
  it('cleans names', () => {
    expect(cleanLayoutName('  Morning   check ')).toBe('Morning check');
    expect(cleanLayoutName('x'.repeat(200))).toHaveLength(80);
  });

  it('opening a layout picks its runs in order and shows the multiviewer on page 1', () => {
    useStore.setState({ multiPage: 3, maximizedTile: 'zzz' });
    openLayout({ name: 'a', runIds: ['b', 'a', 'gone'] });
    const st = useStore.getState();
    expect(st.multi).toEqual(['b', 'a', 'gone']);
    expect(st.route).toBe('multiview');
    expect(st.multiPage).toBe(0);
    expect(st.maximizedTile).toBeNull();
    expect(st.focusedTile).toBe('b');
  });

  it('saves through the backend, replacing a layout with the same name, and deletes', async () => {
    useStore.getState().setSettingsLocal(settings());
    useStore.getState().setMulti(['r1', 'r2']);
    await saveLayout('Pair');
    expect(useStore.getState().settings.layouts).toEqual([{ name: 'Pair', runIds: ['r1', 'r2'] }]);
    await saveLayout('pair', ['r3']);
    expect(useStore.getState().settings.layouts).toEqual([{ name: 'pair', runIds: ['r3'] }]);
    await expect(saveLayout('   ')).rejects.toThrow();
    await deleteLayout('pair');
    expect(useStore.getState().settings.layouts).toEqual([]);
  });
});

describe('startup layout (appInfo.startup.openLayout)', () => {
  const boot = (openLayoutName: string | undefined, s: Settings) => {
    const st = useStore.getState();
    st.setAppInfo({ version: '1', platform: 'web', settingsPath: '', startup: { openLayout: openLayoutName } });
    st.setSettingsLocal(s);
    st.setRuns([run('a'), run('b')]);
  };

  it('waits for app info, settings and runs, then opens the named layout once', () => {
    const off = openStartupLayoutWhenReady();
    expect(useStore.getState().route).toBe('dashboard'); // the home screen
    boot('Morning', settings({ layouts: [{ name: 'Morning', runIds: ['b', 'a'] }] }));
    expect(useStore.getState().route).toBe('multiview');
    expect(useStore.getState().multi).toEqual(['b', 'a']);
    // Only once: going back to the run view stays there.
    useStore.getState().setRoute('run');
    useStore.getState().setRuns([run('a')]);
    expect(useStore.getState().route).toBe('run');
    off();
  });

  it('does nothing without a name, for an unknown name, or on first run', () => {
    for (const [name, s] of [
      [undefined, settings()],
      ['Nope', settings({ layouts: [{ name: 'Morning', runIds: ['a'] }] })],
      ['Morning', settings({ firstRunComplete: false, layouts: [{ name: 'Morning', runIds: ['a'] }] })],
    ] as const) {
      resetStore();
      const off = openStartupLayoutWhenReady();
      const warn = console.warn;
      console.warn = () => {};
      boot(name, s);
      console.warn = warn;
      expect(useStore.getState().route).toBe('dashboard');
      expect(useStore.getState().multi).toEqual([]);
      off();
    }
  });
});
