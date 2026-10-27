// The renderer's single store (zustand). Plain data in, derived lists out (see selectors.ts).
// Slots for later features (multiview tiles, settings screen, wizard) are already here so those
// features only add components.

import { create } from 'zustand';
import type { AppInfo, PowerState, RunsUpdate } from '@shared/ipc';
import type { AgentId, RunDetail, RunStatus, RunSummary } from '@shared/schema';
import { defaultSettings, type RunView, type Settings } from '@shared/settings';

export type Route = 'run' | 'runs' | 'multiview' | 'settings' | 'wizard';
export type Overlay = 'none' | 'palette' | 'cheatsheet';

export interface Filters {
  agents: AgentId[];
  statuses: RunStatus[];
  text: string;
}

/** The run list viewer's own filters (the sidebar's filters do not apply there). */
export interface RunsViewFilter {
  statuses: RunStatus[];
  /** 'all', 'unfiled' or a folder id (folder ids start with "f_", so they never clash). */
  folder: string;
}

export const RECENT_KEY = 'arm.recent';
export const RECENT_MAX = 10;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    /* memory only */
  }
}

export interface AppState {
  /** Every run by id. */
  runs: Record<string, RunSummary>;
  /** Run ids sorted updatedAt desc (ties: id), stable. */
  order: string[];
  runsLoaded: boolean;
  /** Initial-load progress from the backend (null once everything is read). */
  loadProgress: { parsed: number; total: number } | null;
  appInfo: AppInfo | null;
  /** Live details for watched runs (open run, visible tiles). */
  details: Record<string, RunDetail>;

  filters: Filters;
  /** The open run. */
  currentId: string | null;
  /** Keyboard cursor in the list (j/k); Enter opens it. */
  cursorId: string | null;
  /** Anchor for Shift-click range selection. */
  anchorId: string | null;
  /** Runs picked for the multiviewer, in pick order. */
  multi: string[];
  recent: string[];
  view: RunView;
  route: Route;
  /** Where the user was before the current route, so Esc from settings goes back there. */
  lastRoute: Route;
  overlay: Overlay;
  /** Multiviewer: the focused tile and whether it is maximised (used by the `f` shortcut). */
  focusedTile: string | null;
  maximizedTile: string | null;
  /** Multiviewer: the view each tile shows (falls back to settings.defaultView). */
  tileViews: Record<string, RunView>;
  /** Multiviewer: the page shown when more runs are picked than fit on one page (0-based). */
  multiPage: number;
  /** Run list viewer ('runs' route): its status and folder filters. */
  runsView: RunsViewFilter;

  settings: Settings;
  settingsLoaded: boolean;
  power: PowerState | null;
  /** From the backend's window signal; document.visibilityState is read separately. */
  windowVisible: boolean;
  /** Bumped to ask the search box to take focus ('/' shortcut). */
  searchFocusTick: number;

  // actions
  applyRunsUpdate(u: RunsUpdate): void;
  setRuns(list: RunSummary[]): void;
  setAppInfo(info: AppInfo): void;
  setDetail(d: RunDetail): void;
  setFilters(f: Partial<Filters>): void;
  toggleAgentFilter(a: AgentId): void;
  toggleStatusFilter(s: RunStatus): void;
  clearFilters(): void;
  openRun(id: string | null): void;
  setCursor(id: string | null): void;
  setAnchor(id: string | null): void;
  toggleMulti(id: string): void;
  setMulti(ids: string[]): void;
  setView(v: RunView): void;
  setRoute(r: Route): void;
  setOverlay(o: Overlay): void;
  setFocusedTile(id: string | null): void;
  toggleMaximizeFocused(): void;
  setMaximizedTile(id: string | null): void;
  setTileView(id: string, v: RunView): void;
  setMultiPage(page: number): void;
  setRunsView(f: Partial<RunsViewFilter>): void;
  /** Moves a picked run to another position in the multiviewer order. */
  moveMulti(id: string, toIndex: number): void;
  setSettingsLocal(s: Settings): void;
  setPower(p: PowerState): void;
  setWindowVisible(v: boolean): void;
  focusSearch(): void;
}

function sortOrder(runs: Record<string, RunSummary>): string[] {
  return Object.values(runs)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
}

export const useStore = create<AppState>()((set, get) => ({
  runs: {},
  order: [],
  runsLoaded: false,
  loadProgress: null,
  appInfo: null,
  details: {},
  filters: { agents: [], statuses: [], text: '' },
  currentId: null,
  cursorId: null,
  anchorId: null,
  multi: [],
  recent: loadRecent(),
  view: 'activity',
  route: 'run',
  lastRoute: 'run',
  overlay: 'none',
  focusedTile: null,
  maximizedTile: null,
  tileViews: {},
  multiPage: 0,
  runsView: { statuses: [], folder: 'all' },
  settings: defaultSettings(),
  settingsLoaded: false,
  power: null,
  windowVisible: true,
  searchFocusTick: 0,

  setRuns(list) {
    const runs: Record<string, RunSummary> = {};
    for (const r of list) runs[r.id] = r;
    set({ runs, order: sortOrder(runs), runsLoaded: true });
  },

  applyRunsUpdate(u) {
    const runs = u.full ? {} : { ...get().runs };
    for (const r of u.upserts) runs[r.id] = r;
    for (const id of u.removed) delete runs[id];
    const details = { ...get().details };
    let detailsChanged = false;
    for (const id of u.removed) {
      if (details[id]) {
        delete details[id];
        detailsChanged = true;
      }
    }
    const loadProgress = u.progress && u.progress.parsed < u.progress.total ? u.progress : u.progress ? null : get().loadProgress;
    set({ runs, order: sortOrder(runs), runsLoaded: true, loadProgress, ...(detailsChanged ? { details } : {}) });
  },

  setAppInfo(info) {
    set({ appInfo: info });
  },

  setDetail(d) {
    const runs = get().runs;
    const known = runs[d.summary.id];
    // A detail push carries the freshest summary too.
    const nextRuns = known && known.updatedAt <= d.summary.updatedAt ? { ...runs, [d.summary.id]: d.summary } : runs;
    set({
      details: { ...get().details, [d.summary.id]: d },
      ...(nextRuns !== runs ? { runs: nextRuns, order: sortOrder(nextRuns) } : {}),
    });
  },

  setFilters(f) {
    set({ filters: { ...get().filters, ...f } });
  },
  toggleAgentFilter(a) {
    const cur = get().filters.agents;
    set({ filters: { ...get().filters, agents: cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a] } });
  },
  toggleStatusFilter(s) {
    const cur = get().filters.statuses;
    set({ filters: { ...get().filters, statuses: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] } });
  },
  clearFilters() {
    set({ filters: { agents: [], statuses: [], text: '' } });
  },

  openRun(id) {
    if (!id) {
      set({ currentId: null });
      return;
    }
    const recent = [id, ...get().recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
    saveRecent(recent);
    set({ currentId: id, cursorId: id, anchorId: id, recent, route: get().route === 'run' ? 'run' : get().route });
  },
  setCursor(id) {
    set({ cursorId: id });
  },
  setAnchor(id) {
    set({ anchorId: id });
  },
  toggleMulti(id) {
    const cur = get().multi;
    set({ multi: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  setMulti(ids) {
    set({ multi: [...new Set(ids)] });
  },
  setView(v) {
    set({ view: v });
  },
  setRoute(r) {
    const cur = get().route;
    set({ route: r, overlay: 'none', lastRoute: cur !== r ? cur : get().lastRoute });
  },
  setOverlay(o) {
    set({ overlay: o });
  },
  setFocusedTile(id) {
    set({ focusedTile: id });
  },
  toggleMaximizeFocused() {
    // The multiviewer reads maximizedTile to show one tile full size (f, Esc, double-click).
    const { focusedTile, maximizedTile } = get();
    set({ maximizedTile: maximizedTile ? null : focusedTile });
  },
  setMaximizedTile(id) {
    set({ maximizedTile: id, ...(id ? { focusedTile: id } : {}) });
  },
  setTileView(id, v) {
    set({ tileViews: { ...get().tileViews, [id]: v } });
  },
  setMultiPage(page) {
    set({ multiPage: Math.max(0, Math.floor(page)) });
  },
  setRunsView(f) {
    set({ runsView: { ...get().runsView, ...f } });
  },
  moveMulti(id, toIndex) {
    const cur = get().multi;
    const from = cur.indexOf(id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(cur.length - 1, toIndex));
    if (from === to) return;
    const next = cur.slice();
    next.splice(from, 1);
    next.splice(to, 0, id);
    set({ multi: next });
  },
  setSettingsLocal(s) {
    set({ settings: s, settingsLoaded: true });
  },
  setPower(p) {
    set({ power: p });
  },
  setWindowVisible(v) {
    set({ windowVisible: v });
  },
  focusSearch() {
    set({ searchFocusTick: get().searchFocusTick + 1 });
  },
}));

/** Reset for tests. */
export function resetStore(): void {
  useStore.setState({
    runs: {},
    order: [],
    runsLoaded: false,
    loadProgress: null,
    appInfo: null,
    details: {},
    filters: { agents: [], statuses: [], text: '' },
    currentId: null,
    cursorId: null,
    anchorId: null,
    multi: [],
    recent: [],
    view: 'activity',
    route: 'run',
    lastRoute: 'run',
    overlay: 'none',
    focusedTile: null,
    maximizedTile: null,
    tileViews: {},
    multiPage: 0,
    runsView: { statuses: [], folder: 'all' },
    settings: defaultSettings(),
    settingsLoaded: false,
    power: null,
    windowVisible: true,
  });
}
