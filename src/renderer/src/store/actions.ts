// Actions that talk to the backend as well as the store.

import type { FolderOp, FolderResult } from '@shared/folders';
import type { RunView, Settings } from '@shared/settings';
import { getBackend } from '../backend';
import { useStore, type RunsViewFilter } from './store';

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  // Optimistic: the UI follows immediately; the backend's normalised answer wins.
  const cur = useStore.getState().settings;
  useStore.getState().setSettingsLocal({ ...cur, ...patch });
  const saved = await getBackend().setSettings(patch);
  useStore.getState().setSettingsLocal(saved);
  return saved;
}

export function togglePin(id: string): Promise<Settings> {
  const pinned = useStore.getState().settings.pinned;
  return updateSettings({ pinned: pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned] });
}

/**
 * Run folders. Not optimistic: the backend applies the change (so it never races a settings patch)
 * and its saved settings are taken as they come. `error` is plain words for the user.
 */
export async function editFolders(op: FolderOp): Promise<FolderResult> {
  let r: FolderResult;
  try {
    r = await getBackend().editFolders(op);
  } catch {
    // e.g. the settings file could not be written: nothing changed, say so instead of failing silently.
    return { settings: useStore.getState().settings, error: "Couldn't save that change. Try again." };
  }
  useStore.getState().setSettingsLocal(r.settings);
  return r;
}

export const createFolder = (name: string) => editFolders({ kind: 'create', name });
export const renameFolder = (id: string, name: string) => editFolders({ kind: 'rename', id, name });
/** Its runs go back to Unfiled; the runs themselves are untouched. */
export const deleteFolder = (id: string) => editFolders({ kind: 'delete', id });
/** folderId null moves the runs back to Unfiled. */
export const moveRunsToFolder = (runIds: string[], folderId: string | null) => editFolders({ kind: 'move', runIds, folderId });

export function isPinned(id: string | null): boolean {
  return !!id && useStore.getState().settings.pinned.includes(id);
}

export function openRunWithDefaultView(id: string): void {
  const s = useStore.getState();
  s.openRun(id);
  if (s.route !== 'run') s.setRoute('run');
}

/**
 * Opens the run list viewer. `filter` replaces the given parts of its filters (e.g. the dashboard's
 * "See all" passes `{ statuses: [status], folder: 'all' }`); without it the last filters stay.
 */
export function showAllRuns(filter?: Partial<RunsViewFilter>): void {
  const st = useStore.getState();
  if (filter) st.setRunsView(filter);
  if (st.route !== 'runs') st.setRoute('runs');
}

/** Opens the dashboard (the home screen). */
export function showDashboard(): void {
  const st = useStore.getState();
  if (st.route !== 'dashboard') st.setRoute('dashboard');
}

/**
 * Leaves a full-screen route (settings, the run list viewer): back to the dashboard, the multiviewer
 * or the run list viewer when that is where the user came from, else to the run view.
 */
export function goBack(): void {
  const st = useStore.getState();
  const last = st.lastRoute;
  st.setRoute((last === 'dashboard' || last === 'multiview' || last === 'runs') && last !== st.route ? last : 'run');
}

export function setView(v: RunView): void {
  useStore.getState().setView(v);
}

export function revealSource(id: string): void {
  void getBackend().revealSource(id);
}
