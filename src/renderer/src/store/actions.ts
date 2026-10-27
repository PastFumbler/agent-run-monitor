// Actions that talk to the backend as well as the store.

import type { RunView, Settings } from '@shared/settings';
import { getBackend } from '../backend';
import { useStore } from './store';

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

export function isPinned(id: string | null): boolean {
  return !!id && useStore.getState().settings.pinned.includes(id);
}

export function openRunWithDefaultView(id: string): void {
  const s = useStore.getState();
  s.openRun(id);
  if (s.route !== 'run') s.setRoute('run');
}

export function setView(v: RunView): void {
  useStore.getState().setView(v);
}

export function revealSource(id: string): void {
  void getBackend().revealSource(id);
}
