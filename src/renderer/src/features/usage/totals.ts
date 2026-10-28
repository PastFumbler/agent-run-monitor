// The Usage screen's pure parts: which runs a time range covers, their tokens in that range, totals per
// agent and sorting. Only what the sources recorded is counted: a field no run reported stays undefined
// ("Not reported"), never 0, and nothing is estimated or priced.
//
// Attribution: tokens count on the local day of the message that reported them (RunUsage.byDay). Tokens
// whose time the source did not record count on the day the run was last updated.

import type { AgentId, RunSummary, TokenUsage } from '@shared/schema';
import { USAGE_FIELDS, dayKey, hasUsage, totalTokens } from '@shared/usage';
import { startOfDay } from '../../lib/time';
import type { UsageRange } from '../../store/store';

export const USAGE_RANGES: readonly { id: UsageRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
];

export type UsageSort = 'total' | (typeof USAGE_FIELDS)[number];

/** Start of the range (epoch ms, local time; weeks start on Monday), or 0 for all time. */
export function rangeStart(range: UsageRange, now: number): number {
  if (range === 'all') return 0;
  const d = new Date(startOfDay(now));
  if (range === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (range === 'month') d.setDate(1);
  return d.getTime();
}

/**
 * A run's tokens from `start` on: its per-day buckets on or after that day, plus the tokens with no
 * recorded time when the run was last updated in range. Undefined when the run reported no usage.
 */
export function usageSince(run: RunSummary, start: number): TokenUsage | undefined {
  const u = run.usage;
  if (!hasUsage(u)) return undefined;
  const out: TokenUsage = {};
  if (start <= 0) {
    for (const k of USAGE_FIELDS) if (u[k] !== undefined) out[k] = u[k];
    return out;
  }
  const from = dayKey(start);
  const days = Object.entries(u.byDay ?? {});
  const undatedInRange = run.updatedAt >= start;
  for (const k of USAGE_FIELDS) {
    const total = u[k];
    if (total === undefined) continue;
    let dated = 0;
    let inRange = 0;
    for (const [day, d] of days) {
      const n = d[k] ?? 0;
      dated += n;
      if (day >= from) inRange += n;
    }
    out[k] = inRange + (undatedInRange ? Math.max(0, total - dated) : 0);
  }
  return out;
}

export interface UsageRow {
  run: RunSummary;
  /** Tokens in the range; undefined when the run reported no usage ("Not reported"). */
  usage?: TokenUsage;
  total?: number;
}

/** Runs active in the range (last updated on or after its start), with their tokens in it. */
export function usageRows(runs: readonly RunSummary[], range: UsageRange, now: number): UsageRow[] {
  const start = rangeStart(range, now);
  const out: UsageRow[] = [];
  for (const run of runs) {
    if (start > 0 && run.updatedAt < start) continue;
    const usage = usageSince(run, start);
    out.push({ run, usage, total: totalTokens(usage) });
  }
  return out;
}

export interface AgentUsage {
  agent: AgentId;
  /** Runs in the range. */
  runs: number;
  /** Of those, runs that reported usage. */
  reported: number;
  /** Sums of the reported fields; a field no run reported is undefined. Undefined when none reported. */
  usage?: TokenUsage;
  total?: number;
}

function addInto(into: TokenUsage, u: TokenUsage): void {
  for (const k of USAGE_FIELDS) if (u[k] !== undefined) into[k] = (into[k] ?? 0) + u[k]!;
}

/** Totals over rows (the "All agents" line), in the same shape as an agent's. */
export function sumRows(rows: readonly UsageRow[]): Omit<AgentUsage, 'agent'> {
  let usage: TokenUsage | undefined;
  let reported = 0;
  for (const r of rows) {
    if (!r.usage) continue;
    reported++;
    addInto((usage ??= {}), r.usage);
  }
  return { runs: rows.length, reported, usage, total: totalTokens(usage) };
}

/** One line per agent with runs in the range: most tokens first, agents that reported none last. */
export function agentUsage(rows: readonly UsageRow[]): AgentUsage[] {
  const by = new Map<AgentId, UsageRow[]>();
  for (const r of rows) {
    const list = by.get(r.run.agent);
    if (list) list.push(r);
    else by.set(r.run.agent, [r]);
  }
  return [...by]
    .map(([agent, list]) => ({ agent, ...sumRows(list) }))
    .sort((a, b) => compareValues(a.total, b.total, -1) || byText(a.agent, b.agent));
}

function valueOf(x: { usage?: TokenUsage; total?: number }, key: UsageSort): number | undefined {
  return key === 'total' ? x.total : x.usage?.[key];
}

/** Compares two token values in `dir`; an unreported (undefined) value always goes last. 0 on a tie. */
function compareValues(a: number | undefined, b: number | undefined, dir: 1 | -1): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return (a - b) * dir;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The per-run list: by `key` (ties: most recently updated first, then id); unreported values last. */
export function sortRows(rows: readonly UsageRow[], key: UsageSort, dir: 1 | -1): UsageRow[] {
  return [...rows].sort(
    (a, b) => compareValues(valueOf(a, key), valueOf(b, key), dir) || b.run.updatedAt - a.run.updatedAt || byText(a.run.id, b.run.id),
  );
}

export const formatTokens = (n: number): string => n.toLocaleString();
