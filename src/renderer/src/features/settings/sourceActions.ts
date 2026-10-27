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

/**
 * Opens the folder picker and adds the choice as a custom root for this agent. Returns the folder,
 * or null when nothing was picked or the folder was already listed.
 */
export async function addCustomRoot(agent: AgentId): Promise<string | null> {
  const picked = await getBackend().pickFolder();
  if (!picked) return null;
  const s = useStore.getState().settings;
  const cur = s.sources[agent]?.customRoots ?? [];
  const roots = addFolder(cur, picked);
  if (roots === cur) return null;
  await updateSettings({ sources: patchSource(s.sources, agent, { customRoots: roots }) });
  return picked;
}

export function removeCustomRoot(agent: AgentId, path: string) {
  const s = useStore.getState().settings;
  return updateSettings({ sources: patchSource(s.sources, agent, { customRoots: removeFolder(s.sources[agent]?.customRoots ?? [], path) }) });
}

/**
 * Adding a custom folder for one agent. Once the folder is saved it rescans; when the agent found no
 * more runs than before, `emptyFolder` holds the folder so the card can say which folder to pick
 * instead (otherwise a wrong folder just gives 0 runs and no clue). `rescan` defaults to a fresh scan.
 */
export function useAddFolder(agent: AgentId, runCount: number, rescan?: () => Promise<SourceStatus[] | null>) {
  const [emptyFolder, setEmptyFolder] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const countRef = useRef(runCount);
  countRef.current = runCount;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onAdd = useCallback(async () => {
    const before = countRef.current;
    const picked = await addCustomRoot(agent);
    if (!picked || !alive.current) return;
    setEmptyFolder(null);
    setChecking(true);
    try {
      const list = rescan ? await rescan() : await getBackend().getSources(true);
      const after = list?.find((x) => x.agent === agent)?.runCount;
      if (alive.current && after != null && after <= before) setEmptyFolder(picked);
    } catch {
      /* the sources list shows scan errors */
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [agent, rescan]);

  const onRemove = useCallback(
    (path: string) => {
      setEmptyFolder((cur) => (cur === path ? null : cur));
      void removeCustomRoot(agent, path);
    },
    [agent],
  );

  return { onAdd, onRemove, emptyFolder, checking };
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

  /** Loads (with `rescan`, re-detects) the sources; resolves to the fresh list, or null on error. */
  const load = useCallback(async (rescan: boolean): Promise<SourceStatus[] | null> => {
    const mine = ++seq.current;
    if (rescan) setScanning(true);
    try {
      const next = await getBackend().getSources(rescan);
      if (mine === seq.current) {
        setList(next);
        setError(null);
      }
      return next;
    } catch (e) {
      if (mine === seq.current) setError(`Couldn't look for agents: ${String((e as Error)?.message ?? e)}`);
      return null;
    } finally {
      if (rescan) setScanning(false);
    }
  }, []);

  useEffect(() => {
    const rescan = first.current && rescanFirst;
    first.current = false;
    void load(rescan);
  }, [load, rescanFirst, sources, projectRoots]);

  const rescan = useCallback(() => load(true), [load]);
  return { list, scanning, error, rescan };
}
