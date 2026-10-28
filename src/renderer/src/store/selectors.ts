// Derived lists: the filtered run list, its sections, and the navigation order (←/→, j/k).
// Sections: Pinned, Recent, Today, Yesterday, Earlier. Recent repeats runs that also appear in
// their day section; navigation follows Pinned + day sections only, so Recent changing never
// reshuffles the order you are stepping through. Opening a run never reorders Recent: it shows the
// last few runs opened, by last update ("Move updated runs to top", the default) or in a fixed order
// where a newly opened run goes on top.

import { useMemo } from 'react';
import type { AgentId, RunStatus, RunSummary } from '@shared/schema';
import { dayBucket } from '../lib/time';
import { matchRun, parseQuery } from '../features/palette/search';
import { useStore, type Filters } from './store';

export type SectionId = 'pinned' | 'recent' | 'today' | 'yesterday' | 'earlier';

export const SECTION_LABELS: Record<SectionId, string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
};

export interface Section {
  id: SectionId;
  runs: RunSummary[];
}

export const RECENT_SHOWN = 5;

export function filterRuns(runs: RunSummary[], f: Filters, now: number): RunSummary[] {
  const q = f.text.trim() ? parseQuery(f.text) : null;
  return runs.filter(
    (r) =>
      (!f.agents.length || f.agents.includes(r.agent)) &&
      (!f.statuses.length || f.statuses.includes(r.status)) &&
      (!q || matchRun(r, q, now)),
  );
}

const newestFirst = (a: RunSummary, b: RunSummary) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * `recent` is the store's list (newest addition first). The last RECENT_SHOWN opened runs are shown;
 * with `moveUpdatedToTop` they are ordered by updatedAt, otherwise they keep the stored order.
 */
export function buildSections(
  filtered: RunSummary[],
  pinned: string[],
  recent: string[],
  now: number,
  moveUpdatedToTop = true,
): Section[] {
  const byId = new Map(filtered.map((r) => [r.id, r]));
  const pinSet = new Set(pinned);
  const pinnedRuns = pinned.map((id) => byId.get(id)).filter((r): r is RunSummary => !!r);
  const recentShown = recent
    .filter((id) => !pinSet.has(id))
    .map((id) => byId.get(id))
    .filter((r): r is RunSummary => !!r)
    .slice(0, RECENT_SHOWN);
  const recentRuns = moveUpdatedToTop ? recentShown.sort(newestFirst) : recentShown;
  const days: Record<'today' | 'yesterday' | 'earlier', RunSummary[]> = { today: [], yesterday: [], earlier: [] };
  for (const r of filtered) if (!pinSet.has(r.id)) days[dayBucket(r.updatedAt, now)].push(r);
  const out: Section[] = [
    { id: 'pinned', runs: pinnedRuns },
    { id: 'recent', runs: recentRuns },
    { id: 'today', runs: days.today },
    { id: 'yesterday', runs: days.yesterday },
    { id: 'earlier', runs: days.earlier },
  ];
  return out.filter((s) => s.runs.length > 0);
}

/** Navigation order: every filtered run once, in the order the sections show them (minus Recent). */
export function navOrder(sections: Section[]): string[] {
  return sections.filter((s) => s.id !== 'recent').flatMap((s) => s.runs.map((r) => r.id));
}

export function countBy<K extends string>(runs: RunSummary[], key: (r: RunSummary) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const r of runs) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}

export interface RunListModel {
  all: RunSummary[];
  filtered: RunSummary[];
  sections: Section[];
  nav: string[];
  agentCounts: Record<AgentId, number>;
  statusCounts: Record<RunStatus, number>;
}

/** The whole list model, memoised on the inputs that matter. `now` should tick slowly (minutes). */
export function useRunListModel(now: number): RunListModel {
  const runs = useStore((s) => s.runs);
  const order = useStore((s) => s.order);
  const filters = useStore((s) => s.filters);
  const pinned = useStore((s) => s.settings.pinned);
  const recent = useStore((s) => s.recent);
  const moveUpdatedToTop = useStore((s) => s.settings.moveUpdatedToTop);
  return useMemo(() => {
    const all = order.map((id) => runs[id]).filter(Boolean);
    const filtered = filterRuns(all, filters, now);
    const sections = buildSections(filtered, pinned, recent, now, moveUpdatedToTop);
    return {
      all,
      filtered,
      sections,
      nav: navOrder(sections),
      agentCounts: countBy(all, (r) => r.agent),
      statusCounts: countBy(all, (r) => r.status),
    };
  }, [runs, order, filters, pinned, recent, moveUpdatedToTop, now]);
}
