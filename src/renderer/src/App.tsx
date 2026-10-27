// The app shell: boots from the backend, keeps the store in sync with pushed updates, applies the
// look (theme, text size, density) and the motion policy, and lays out sidebar, main area, status bar
// and overlays.

import { useEffect, useRef } from 'react';
import { Settings02Icon, CommandIcon, ListViewIcon } from '@hugeicons/core-free-icons';
import { getBackend } from './backend';
import { Icon } from './components/Icon';
import { CommandPalette } from './features/palette/CommandPalette';
import { FilterChips, RunList, SearchBox } from './features/runlist/RunList';
import { CheatSheet } from './features/shortcuts/CheatSheet';
import { useShortcuts } from './features/shortcuts/useShortcuts';
import { StatusBar } from './features/statusbar/StatusBar';
import { useMotionPolicy } from './motion/context';
import { MotionPolicyProvider } from './motion/MotionPolicyProvider';
import { useClockDriver, useNow } from './store/clock';
import { useRunListModel } from './store/selectors';
import { useStore } from './store/store';
import { applyLook } from './theme/applyTheme';
import { RouteView } from './views/RouteView';
import { openRunWithDefaultView, showAllRuns } from './store/actions';
import { MOD, shortcutText } from './features/shortcuts/shortcuts';
import { openStartupLayoutWhenReady } from './features/multiview/layouts';
import { OpenMultiviewButton } from './features/multiview/OpenMultiviewButton';

function useBoot() {
  useEffect(() => {
    const b = getBackend();
    const st = useStore.getState();
    let alive = true;
    const offs = [
      b.onRunsUpdate((u) => useStore.getState().applyRunsUpdate(u)),
      b.onRunDetail((d) => useStore.getState().setDetail(d)),
      b.onPower((p) => useStore.getState().setPower(p)),
      b.onWindowVisibility((v) => useStore.getState().setWindowVisible(v)),
      // A click on a finish notification (desktop) shows that run.
      b.onOpenRun?.((id) => {
        if (useStore.getState().runs[id]) openRunWithDefaultView(id);
      }) ?? (() => {}),
    ];
    // appInfo.startup.openLayout names a saved layout to open on start (once everything has loaded).
    offs.push(openStartupLayoutWhenReady());
    b.appInfo()
      .then((info) => alive && st.setAppInfo(info))
      .catch(() => {});
    Promise.all([b.getSettings(), b.listRuns(), b.getPower()])
      .then(([settings, runs, power]) => {
        if (!alive) return;
        st.setSettingsLocal(settings);
        st.setPower(power);
        st.setRuns(runs);
        st.setView(settings.defaultView);
        if (!settings.firstRunComplete) st.setRoute('wizard');
      })
      .catch((e) => console.error('Could not load runs', e));
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);
}

function Shell() {
  const policy = useMotionPolicy();
  useClockDriver(policy.hidden);
  const now = useNow();
  const model = useRunListModel(now);
  const route = useStore((s) => s.route);
  const overlay = useStore((s) => s.overlay);
  const currentId = useStore((s) => s.currentId);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const setRoute = useStore((s) => s.setRoute);
  const setOverlay = useStore((s) => s.setOverlay);
  const navRef = useRef(model.nav);
  navRef.current = model.nav;
  useShortcuts(() => navRef.current);

  // Open the most recent run once runs arrive (and whenever the open run disappears).
  useEffect(() => {
    if (!runsLoaded) return;
    const st = useStore.getState();
    if (currentId && st.runs[currentId]) return;
    const newest = st.order.find((id) => model.nav.includes(id));
    const first = st.recent.find((id) => st.runs[id]) ?? newest ?? model.nav[0] ?? null;
    if (first) st.openRun(first);
    else if (currentId) st.openRun(null);
  }, [runsLoaded, currentId, model.nav]);

  return (
    <div className="app" data-route={route}>
      <a className="skip-link" href="#main">
        Skip to run
      </a>
      {/* The wizard and the run list viewer use the full width. */}
      {route !== 'wizard' && route !== 'runs' ? (
        <aside className="sidebar" aria-label="Runs">
          <div className="sidebar__top">
            <div className="brand">
              <span className="brand__mark" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M7.5 12h2.5l1.5-3 2 6 1.5-3h1.5" />
                </svg>
              </span>
              <span>Agent Run Monitor</span>
              <span className="brand__actions">
                <button
                  type="button"
                  className="btn btn--icon btn--ghost"
                  aria-label="Command palette"
                  title={`Command palette (${MOD}+K)`}
                  onClick={() => setOverlay('palette')}
                >
                  <Icon icon={CommandIcon} />
                </button>
                <button
                  type="button"
                  className="btn btn--icon btn--ghost"
                  aria-label="All runs"
                  title={`All runs: organise into folders (${shortcutText('openRuns')})`}
                  onClick={() => showAllRuns()}
                  data-testid="open-all-runs"
                >
                  <Icon icon={ListViewIcon} />
                </button>
                <button
                  type="button"
                  className="btn btn--icon btn--ghost"
                  aria-label="Settings"
                  title={`Settings (${MOD}+,)`}
                  aria-pressed={route === 'settings'}
                  onClick={() => setRoute(route === 'settings' ? 'run' : 'settings')}
                >
                  <Icon icon={Settings02Icon} />
                </button>
              </span>
            </div>
            <SearchBox />
            <FilterChips model={model} />
            <OpenMultiviewButton />
          </div>
          <RunList model={model} />
        </aside>
      ) : null}
      <main className="main" id="main" tabIndex={-1}>
        <RouteView nav={model.nav} />
      </main>
      <StatusBar all={model.all} />
      {overlay === 'palette' ? <CommandPalette /> : null}
      {overlay === 'cheatsheet' ? <CheatSheet /> : null}
    </div>
  );
}

export function App() {
  useBoot();
  const theme = useStore((s) => s.settings.theme);
  const textSize = useStore((s) => s.settings.textSize);
  const density = useStore((s) => s.settings.density);
  useEffect(() => applyLook({ theme, textSize, density }), [theme, textSize, density]);
  return (
    <MotionPolicyProvider>
      <Shell />
    </MotionPolicyProvider>
  );
}
