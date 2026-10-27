// Source and folder edits, saved through the backend (updateSettings is optimistic), plus a hook that
// keeps the detected-sources list fresh. Shared by the settings screen and the wizard.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentId, SourceStatus } from '@shared/schema';
import { getBackend } from '../../backend';
import { updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';
import { addFolder, patchSource, removeFolder } from './describe';

export function setSourceEnabled(agent: AgentId, enabled: boolean) {
  const s = useStore.getState().settings;
  return updateSettings({ sources: patchSource(s.sources, agent, { enabled }) });
}

/** Opens the folder picker and adds the choice as a custom root for this agent. */
export async function addCustomRoot(agent: AgentId): Promise<string | null> {
  const picked = await getBackend().pickFolder();
  if (!picked) return null;
  const s = useStore.getState().settings;
  const roots = addFolder(s.sources[agent]?.customRoots ?? [], picked);
  if (roots !== (s.sources[agent]?.customRoots ?? [])) await updateSettings({ sources: patchSource(s.sources, agent, { customRoots: roots }) });
  return picked;
}

export function removeCustomRoot(agent: AgentId, path: string) {
  const s = useStore.getState().settings;
  return updateSettings({ sources: patchSource(s.sources, agent, { customRoots: removeFolder(s.sources[agent]?.customRoots ?? [], path) }) });
}

export async function addProjectRoot(): Promise<string | null> {
  const picked = await getBackend().pickFolder();
  if (!picked) return null;
  const cur = useStore.getState().settings.projectRoots;
  const next = addFolder(cur, picked);
  if (next !== cur) await updateSettings({ projectRoots: next });
  return picked;
}

export function removeProjectRoot(path: string) {
  return updateSettings({ projectRoots: removeFolder(useStore.getState().settings.projectRoots, path) });
}

/**
 * The detected sources. Scans once on mount (`rescanFirst` forces a fresh scan, as the wizard does)
 * and reloads whenever the source settings change, so counts, switches and folders stay in step.
 */
export function useSources(rescanFirst = false) {
  const [list, setList] = useState<SourceStatus[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sources = useStore((s) => s.settings.sources);
  const projectRoots = useStore((s) => s.settings.projectRoots);
  const seq = useRef(0);
  const first = useRef(true);

  const load = useCallback(async (rescan: boolean) => {
    const mine = ++seq.current;
    if (rescan) setScanning(true);
    try {
      const next = await getBackend().getSources(rescan);
      if (mine === seq.current) {
        setList(next);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(`Couldn't look for agents: ${String((e as Error)?.message ?? e)}`);
    } finally {
      if (rescan) setScanning(false);
    }
  }, []);

  useEffect(() => {
    const rescan = first.current && rescanFirst;
    first.current = false;
    void load(rescan);
  }, [load, rescanFirst, sources, projectRoots]);

  return { list, scanning, error, rescan: () => load(true) };
}
