// Pure helpers for the dashboard (home screen): one section per run status, the most recently updated
// runs in each, and the counts the "See all" links show.

import { RUN_STATUSES, type AgentId, type RunStatus, type RunSummary } from '@shared/schema';

/** How many runs each section lists. */
export const SECTION_SIZE = 3;

export interface DashboardSection {
  status: RunStatus;
  /** The newest runs (by updatedAt) with this status that match the agent filter, at most SECTION_SIZE. */
  runs: RunSummary[];
  /** Runs with this status that match the agent filter. */
  matching: number;
  /** Runs with this status from every agent: what "See all" opens in the run list viewer. */
  total: number;
}

const newestFirst = (a: RunSummary, b: RunSummary) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One section per status in the schema's order (every status, even when it has no runs). `agents` is
 * the agent filter; empty means every agent.
 */
export function dashboardSections(runs: readonly RunSummary[], agents: readonly AgentId[], size = SECTION_SIZE): DashboardSection[] {
  const pick = agents.length ? new Set(agents) : null;
  const by = new Map<RunStatus, { runs: RunSummary[]; total: number }>(RUN_STATUSES.map((s) => [s, { runs: [], total: 0 }]));
  for (const r of runs) {
    const b = by.get(r.status);
    if (!b) continue;
    b.total++;
    if (!pick || pick.has(r.agent)) b.runs.push(r);
  }
  return RUN_STATUSES.map((status) => {
    const b = by.get(status)!;
    const sorted = b.runs.sort(newestFirst);
    return { status, runs: sorted.slice(0, size), matching: sorted.length, total: b.total };
  });
}

/** Runs per agent, for the filter chips. */
export function agentCounts(runs: readonly RunSummary[]): Partial<Record<AgentId, number>> {
  const out: Partial<Record<AgentId, number>> = {};
  for (const r of runs) out[r.agent] = (out[r.agent] ?? 0) + 1;
  return out;
}

/** The calm line an empty section shows. */
export const EMPTY_LINES: Record<RunStatus, string> = {
  running: 'Nothing is running right now.',
  waiting: 'Nothing is waiting for you.',
  idle: 'No idle runs.',
  done: 'No finished runs yet.',
  failed: 'No failed runs.',
  stuck: 'Nothing looks stuck.',
  unreadable: 'Every run could be read.',
};
