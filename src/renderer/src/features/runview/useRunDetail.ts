// Run detail for a view or a tile. Details live in the store: the first one is fetched with
// getRun(); after that the backend pushes changes for watched runs (see useWatchRuns).

import { useEffect, useState } from 'react';
import type { RunDetail } from '@shared/schema';
import { getBackend } from '../../backend';
import { useStore } from '../../store/store';

export function useRunDetail(id: string | null): { detail: RunDetail | null; loading: boolean; missing: boolean } {
  const detail = useStore((s) => (id ? (s.details[id] ?? null) : null));
  const updatedAt = useStore((s) => (id ? s.runs[id]?.updatedAt : undefined));
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    // Fetch when we have nothing yet, or when the summary moved past the detail we hold
    // (a run that is not watched, e.g. after the watch set changed).
    const have = useStore.getState().details[id];
    if (have && (isWatched(id) || (updatedAt !== undefined && have.summary.updatedAt >= updatedAt))) return undefined;
    setLoading(!have);
    getBackend()
      .getRun(id)
      .then((d) => {
        if (!alive) return;
        setLoading(false);
        if (d) {
          setMissing(false);
          useStore.getState().setDetail(d);
        } else setMissing(true);
      })
      .catch(() => {
        if (alive) {
          setLoading(false);
          setMissing(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [id, updatedAt]);

  return { detail, loading, missing };
}

/** Registers runs whose detail should be pushed live. Union of all registrations goes to the backend. */
const watchers = new Map<string, string[]>();
let lastSent = '';
let watchedSet = new Set<string>();

function isWatched(id: string): boolean {
  return watchedSet.has(id);
}

function sendWatch() {
  const ids = [...new Set([...watchers.values()].flat())].sort();
  const key = ids.join('|');
  if (key === lastSent) return;
  lastSent = key;
  const before = watchedSet;
  watchedSet = new Set(ids);
  getBackend().watchRuns(ids);
  // Details of runs no longer watched would go stale: drop them so the next view fetches fresh.
  const dropped = [...before].filter((x) => !watchedSet.has(x));
  if (dropped.length) {
    const details = { ...useStore.getState().details };
    for (const x of dropped) delete details[x];
    useStore.setState({ details });
  }
}

export function useWatchRuns(key: string, ids: string[]): void {
  const joined = ids.join('|');
  useEffect(() => {
    watchers.set(key, joined ? joined.split('|') : []);
    sendWatch();
    return () => {
      watchers.delete(key);
      sendWatch();
    };
  }, [key, joined]);
}
