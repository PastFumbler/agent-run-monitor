// Saved multiviewer layouts: a name and the picked run ids, in order (settings.layouts, saved through
// backend.setSettings). Opening a layout whose runs have since disappeared is fine: those tiles say
// "run no longer available" instead of failing.

import type { SavedLayout } from '@shared/settings';
import { updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';

export const LAYOUT_NAME_MAX = 80;

export function cleanLayoutName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, LAYOUT_NAME_MAX);
}

/** Opens the multiviewer on these runs (page 1, nothing maximised, first tile focused). */
export function openMultiview(runIds?: string[]): void {
  const st = useStore.getState();
  if (runIds) st.setMulti(runIds);
  const ids = useStore.getState().multi;
  st.setMultiPage(0);
  st.setMaximizedTile(null);
  st.setFocusedTile(ids[0] ?? null);
  st.setRoute('multiview');
}

export function openLayout(layout: SavedLayout): void {
  openMultiview(layout.runIds);
}

export function findLayout(name: string): SavedLayout | undefined {
  const want = cleanLayoutName(name).toLowerCase();
  return useStore.getState().settings.layouts.find((l) => l.name.toLowerCase() === want);
}

/** Saves the current selection under `name`, replacing a layout with the same name (case-insensitive). */
export function saveLayout(name: string, runIds: string[] = useStore.getState().multi) {
  const clean = cleanLayoutName(name);
  if (!clean) return Promise.reject(new Error('A layout needs a name.'));
  const others = useStore.getState().settings.layouts.filter((l) => l.name.toLowerCase() !== clean.toLowerCase());
  return updateSettings({ layouts: [...others, { name: clean, runIds: [...runIds] }] });
}

export function deleteLayout(name: string) {
  const layouts = useStore.getState().settings.layouts.filter((l) => l.name !== name);
  return updateSettings({ layouts });
}

/**
 * appInfo.startup.openLayout (ARM_OPEN_LAYOUT) names a saved layout to open on start. Waits until the
 * app info, settings and runs have loaded, then opens it once (never over the first-run wizard).
 * Returns an unsubscribe for the boot effect's cleanup.
 */
export function openStartupLayoutWhenReady(): () => void {
  let done = false;
  const tryOpen = () => {
    if (done) return;
    const st = useStore.getState();
    if (!st.appInfo || !st.settingsLoaded || !st.runsLoaded) return;
    done = true;
    const name = st.appInfo.startup?.openLayout;
    if (!name || st.route === 'wizard' || !st.settings.firstRunComplete) return;
    const layout = findLayout(name);
    if (layout) openLayout(layout);
    else console.warn(`Saved layout "${name}" was not found.`);
  };
  const unsubscribe = useStore.subscribe(() => {
    tryOpen();
    if (done) unsubscribe();
  });
  tryOpen();
  if (done) unsubscribe();
  return unsubscribe;
}
