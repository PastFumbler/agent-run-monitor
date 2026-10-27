import { describe, expect, it } from 'vitest';
import { RUN_STATUSES, type RunSummary } from '@shared/schema';
import { agentCounts, dashboardSections, EMPTY_LINES } from './sections';

const mk = (id: string, updatedAt: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  id,
  agent: 'codex',
  title: id,
  projectName: 'todo-cli',
  startedAt: updatedAt - 60_000,
  updatedAt,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: `/home/demo/${id}`,
  ...extra,
});

describe('dashboard sections', () => {
  it('has one section per status, in the schema order, even when empty', () => {
    const s = dashboardSections([], []);
    expect(s.map((x) => x.status)).toEqual([...RUN_STATUSES]);
    for (const x of s) expect(x).toMatchObject({ runs: [], matching: 0, total: 0 });
    for (const st of RUN_STATUSES) expect(EMPTY_LINES[st]).toBeTruthy();
  });

  it('lists the 3 most recently updated runs of each status, whatever the input order', () => {
    const runs = [
      mk('d1', 100),
      mk('d2', 500),
      mk('d3', 300),
      mk('d4', 400),
      mk('r1', 200, { status: 'running' }),
      mk('tie-b', 300, { status: 'failed' }),
      mk('tie-a', 300, { status: 'failed' }),
    ];
    const by = Object.fromEntries(dashboardSections(runs, []).map((x) => [x.status, x]));
    expect(by.done.runs.map((r) => r.id)).toEqual(['d2', 'd4', 'd3']);
    expect(by.done).toMatchObject({ matching: 4, total: 4 });
    expect(by.running.runs.map((r) => r.id)).toEqual(['r1']);
    // Equal times: by id, so the order never flickers.
    expect(by.failed.runs.map((r) => r.id)).toEqual(['tie-a', 'tie-b']);
    expect(by.waiting).toMatchObject({ runs: [], matching: 0, total: 0 });
  });

  it('applies the agent filter to every section, while total still counts every agent', () => {
    const runs = [
      mk('c1', 100, { agent: 'codex' }),
      mk('a1', 200, { agent: 'aider' }),
      mk('g1', 300, { agent: 'gemini-cli' }),
      mk('g2', 400, { agent: 'gemini-cli', status: 'running' }),
      mk('c2', 500, { agent: 'codex', status: 'running' }),
    ];
    const by = Object.fromEntries(dashboardSections(runs, ['codex', 'aider']).map((x) => [x.status, x]));
    expect(by.done.runs.map((r) => r.id)).toEqual(['a1', 'c1']);
    expect(by.done).toMatchObject({ matching: 2, total: 3 });
    expect(by.running.runs.map((r) => r.id)).toEqual(['c2']);
    expect(by.running).toMatchObject({ matching: 1, total: 2 });
    // An agent with no runs empties every section but keeps the totals.
    const none = dashboardSections(runs, ['cursor']);
    expect(none.every((x) => x.runs.length === 0 && x.matching === 0)).toBe(true);
    expect(none.find((x) => x.status === 'done')!.total).toBe(3);
  });

  it('counts runs per agent for the chips', () => {
    expect(agentCounts([mk('a', 1), mk('b', 2), mk('c', 3, { agent: 'aider' })])).toEqual({ codex: 2, aider: 1 });
  });
});
