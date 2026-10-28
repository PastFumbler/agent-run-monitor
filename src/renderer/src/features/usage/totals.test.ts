import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { dayKey } from '@shared/usage';
import { agentUsage, rangeStart, sortRows, sumRows, usageRows, usageSince } from './totals';

// Wednesday 28 October 2026, 15:00 local time.
const NOW = new Date(2026, 9, 28, 15, 0, 0).getTime();
const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
const key = (month: number, day: number) => dayKey(at(month, day));

const mk = (id: string, updatedAt: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  id,
  agent: 'claude-code',
  title: id,
  projectName: 'todo-cli',
  startedAt: updatedAt - 60_000,
  updatedAt,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: `/home/demo/${id}`,
  ...extra,
});

describe('usage ranges', () => {
  it('starts today at midnight, the week on Monday, the month on the 1st; all time at 0', () => {
    expect(rangeStart('today', NOW)).toBe(new Date(2026, 9, 28).getTime());
    expect(rangeStart('week', NOW)).toBe(new Date(2026, 9, 26).getTime()); // Monday
    expect(rangeStart('month', NOW)).toBe(new Date(2026, 9, 1).getTime());
    expect(rangeStart('all', NOW)).toBe(0);
    // A Monday is its own week start, and a Sunday belongs to the week that began six days before.
    expect(rangeStart('week', at(10, 26, 9))).toBe(new Date(2026, 9, 26).getTime());
    expect(rangeStart('week', at(11, 1, 9))).toBe(new Date(2026, 9, 26).getTime());
  });
});

describe('usageSince', () => {
  const run = mk('r', at(10, 28), {
    usage: {
      input: 100,
      output: 50,
      cacheRead: 1000,
      byDay: {
        [key(10, 27)]: { input: 30, output: 20, cacheRead: 400 },
        [key(10, 28)]: { input: 60, output: 30, cacheRead: 600 },
      },
    },
  });

  it('is undefined when the run reported no usage (never zeros)', () => {
    expect(usageSince(mk('x', NOW), 0)).toBeUndefined();
    expect(usageSince(mk('x', NOW, { usage: { byDay: {} } }), rangeStart('today', NOW))).toBeUndefined();
  });

  it('gives the totals for all time, without the day buckets', () => {
    expect(usageSince(run, 0)).toEqual({ input: 100, output: 50, cacheRead: 1000 });
  });

  it('adds the days in range plus the undated remainder on the day the run was last updated', () => {
    // input has 10 tokens with no recorded day: they count on 28 Oct (updatedAt).
    expect(usageSince(run, rangeStart('today', NOW))).toEqual({ input: 70, output: 30, cacheRead: 600 });
    expect(usageSince(run, rangeStart('week', NOW))).toEqual({ input: 100, output: 50, cacheRead: 1000 });
  });

  it('leaves out the undated remainder when the run was last updated before the range', () => {
    const old = mk('o', at(10, 20), { usage: { output: 40, byDay: { [key(10, 20)]: { output: 25 } } } });
    expect(usageSince(old, rangeStart('today', NOW))).toEqual({ output: 0 });
    expect(usageSince(old, rangeStart('month', NOW))).toEqual({ output: 40 });
  });

  it('keeps unreported fields undefined, and reported ones at a real 0 when none fall in range', () => {
    const u = usageSince(mk('c', at(10, 28), { usage: { output: 5, byDay: { [key(10, 2)]: { output: 5 } } } }), rangeStart('week', NOW));
    expect(u).toEqual({ output: 0 });
    expect(u && 'cacheWrite' in u).toBe(false);
  });
});

describe('usageRows and agentUsage', () => {
  const runs = [
    mk('cc1', at(10, 28), { usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 } }),
    mk('cc2', at(10, 27), { usage: { input: 5, output: 5, cacheRead: 100 } }),
    mk('cc3', at(10, 28)), // a Claude Code run with no model reply yet: not reported
    mk('cu1', at(10, 28), { agent: 'cursor' }),
    mk('cx1', at(10, 26), { agent: 'codex', usage: { input: 1000, output: 100 } }),
    mk('old', at(9, 1), { agent: 'codex', usage: { input: 9, output: 9 } }),
  ];

  it('keeps the runs last updated in the range', () => {
    expect(usageRows(runs, 'today', NOW).map((r) => r.run.id)).toEqual(['cc1', 'cc3', 'cu1']);
    expect(usageRows(runs, 'week', NOW).map((r) => r.run.id)).toEqual(['cc1', 'cc2', 'cc3', 'cu1', 'cx1']);
    expect(usageRows(runs, 'all', NOW)).toHaveLength(6);
  });

  it('sums each agent, counting runs that did not report and leaving fields nobody reported undefined', () => {
    const agents = agentUsage(usageRows(runs, 'week', NOW));
    expect(agents.map((a) => a.agent)).toEqual(['codex', 'claude-code', 'cursor']);
    expect(agents[0]).toEqual({ agent: 'codex', runs: 1, reported: 1, usage: { input: 1000, output: 100 }, total: 1100 });
    expect(agents[1]).toEqual({
      agent: 'claude-code',
      runs: 3,
      reported: 2,
      usage: { input: 15, output: 25, cacheRead: 400, cacheWrite: 40 },
      total: 480,
    });
    // Cursor recorded nothing: not reported, not zero.
    expect(agents[2]).toEqual({ agent: 'cursor', runs: 1, reported: 0, usage: undefined, total: undefined });
  });

  it('totals every agent', () => {
    expect(sumRows(usageRows(runs, 'week', NOW))).toEqual({
      runs: 5,
      reported: 3,
      usage: { input: 1015, output: 125, cacheRead: 400, cacheWrite: 40 },
      total: 1580,
    });
    expect(sumRows([])).toEqual({ runs: 0, reported: 0, usage: undefined, total: undefined });
  });

  it('sorts runs by any column, with runs that did not report it last in either direction', () => {
    const rows = usageRows(runs, 'week', NOW);
    const ids = (k: Parameters<typeof sortRows>[1], d: 1 | -1) => sortRows(rows, k, d).map((r) => r.run.id);
    expect(ids('total', -1)).toEqual(['cx1', 'cc1', 'cc2', 'cc3', 'cu1']);
    expect(ids('total', 1)).toEqual(['cc2', 'cc1', 'cx1', 'cc3', 'cu1']);
    expect(ids('cacheWrite', -1)).toEqual(['cc1', 'cc3', 'cu1', 'cc2', 'cx1']);
    expect(ids('cacheRead', 1)).toEqual(['cc2', 'cc1', 'cc3', 'cu1', 'cx1']);
  });
});
