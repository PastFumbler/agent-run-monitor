// The run list viewer's pure parts: filtering, grouping by start time and checkbox selection.
// Groups: Today, Yesterday, This week (from Monday), Earlier this month, then one group per month.

import type { RunSummary } from '@shared/schema';
import { startOfDay } from '../../lib/time';
import type { RunsViewFilter } from '../../store/store';

export interface StartGroup {
  /** 'today' | 'yesterday' | 'week' | 'month' | 'm:YYYY-MM' | 'unknown' */
  id: string;
  label: string;
  runs: RunSummary[];
}

function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** The group a start time falls in. Calendar based (local time); weeks start on Monday. */
export function startGroupOf(ts: number, now: number): { id: string; label: string } {
  if (!Number.isFinite(ts) || ts <= 0) return { id: 'unknown', label: 'Start time unknown' };
  const today = startOfDay(now);
  if (ts >= today) return { id: 'today', label: 'Today' };
  const yesterday = addDays(today, -1);
  if (ts >= yesterday) return { id: 'yesterday', label: 'Yesterday' };
  const sinceMonday = (new Date(today).getDay() + 6) % 7;
  if (ts >= addDays(today, -sinceMonday)) return { id: 'week', label: 'This week' };
  const first = new Date(today);
  first.setDate(1);
  if (ts >= first.getTime()) return { id: 'month', label: 'Earlier this month' };
  const d = new Date(ts);
  return {
    id: `m:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  };
}

/** Runs newest start first, in their start-time groups (empty groups are left out). */
export function groupByStart(runs: readonly RunSummary[], now: number): StartGroup[] {
  const sorted = [...runs].sort(
    (a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out: StartGroup[] = [];
  const byId = new Map<string, StartGroup>();
  for (const r of sorted) {
    const g = startGroupOf(r.startedAt, now);
    let group = byId.get(g.id);
    if (!group) {
      group = { ...g, runs: [] };
      byId.set(g.id, group);
      out.push(group);
    }
    group.runs.push(r);
  }
  return out;
}

/** The folder filter to apply: a folder that no longer exists falls back to 'all'. */
export function effectiveFolder(folder: string, folderIds: ReadonlySet<string>): string {
  return folder === 'all' || folder === 'unfiled' || folderIds.has(folder) ? folder : 'all';
}

export function filterViewer(runs: readonly RunSummary[], f: RunsViewFilter, runFolders: Readonly<Record<string, string>>): RunSummary[] {
  return runs.filter(
    (r) =>
      (!f.statuses.length || f.statuses.includes(r.status)) &&
      (f.folder === 'all' || (f.folder === 'unfiled' ? !runFolders[r.id] : runFolders[r.id] === f.folder)),
  );
}

/**
 * A click on a run's checkbox or row: toggles it, or with `range` (Shift) sets every run between the
 * anchor and it (in display order) to the clicked run's new state.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  order: readonly string[],
  id: string,
  anchor: string | null,
  range: boolean,
): Set<string> {
  const on = !selected.has(id);
  const a = range && anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  const ids = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
  return setSelected(selected, ids, on);
}

export function setSelected(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const x of ids) {
    if (on) next.add(x);
    else next.delete(x);
  }
  return next;
}
