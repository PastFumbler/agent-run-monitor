import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { effectiveFolder, filterViewer, groupByStart, setSelected, startGroupOf, toggleSelection } from './groups';

// Local dates, so the tests hold in any time zone. 2026-10-27 is a Tuesday.
const at = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h).getTime();
const NOW = at(10, 27, 15);

const mk = (id: string, startedAt: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  id,
  agent: 'codex',
  title: id,
  projectName: 'todo-cli',
  startedAt,
  updatedAt: startedAt + 60_000,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: `/home/demo/${id}`,
  ...extra,
});

describe('start-time groups', () => {
  it('puts each start time in Today, Yesterday, This week, Earlier this month or its month', () => {
    expect(startGroupOf(at(10, 27, 0), NOW).id).toBe('today');
    expect(startGroupOf(NOW + 60_000, NOW).id).toBe('today'); // clock skew: still today
    expect(startGroupOf(at(10, 26, 23), NOW).id).toBe('yesterday');
    expect(startGroupOf(at(10, 26, 0), NOW).id).toBe('yesterday');
    // Tuesday: the week (from Monday) is already covered by Today and Yesterday.
    expect(startGroupOf(at(10, 25, 23), NOW).id).toBe('month');
    expect(startGroupOf(at(10, 1, 0), NOW).id).toBe('month');
    const sep = startGroupOf(at(9, 30, 23), NOW);
    expect(sep.id).toBe('m:2026-09');
    expect(sep.label).toBe(new Date(2026, 8, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect(startGroupOf(at(12, 31), NOW).id).toBe('today');
    expect(startGroupOf(at(12, 31, 12) - 400 * 86_400_000, NOW).id).toBe('m:2025-11');
  });

  it('has a This week group later in the week, which can reach back into last month', () => {
    const sat = at(10, 31, 9);
    expect(startGroupOf(at(10, 29), sat).id).toBe('week');
    expect(startGroupOf(at(10, 26, 0), sat).id).toBe('week');
    expect(startGroupOf(at(10, 25, 23), sat).id).toBe('month');
    // Thursday 1 October: Monday 28 September is this week, not September.
    const thu = at(10, 1, 9);
    expect(startGroupOf(at(9, 29), thu).id).toBe('week');
    expect(startGroupOf(at(9, 27), thu).id).toBe('m:2026-09');
  });

  it('keeps runs without a start time apart', () => {
    expect(startGroupOf(0, NOW).id).toBe('unknown');
    expect(startGroupOf(Number.NaN, NOW).id).toBe('unknown');
  });

  it('groups newest start first and leaves out empty groups', () => {
    const runs = [mk('old', at(8, 3)), mk('a', at(10, 27, 9)), mk('b', at(10, 27, 11)), mk('y', at(10, 26)), mk('s', at(9, 10)), mk('x', 0)];
    const g = groupByStart(runs, NOW);
    expect(g.map((x) => [x.id, x.runs.map((r) => r.id)])).toEqual([
      ['today', ['b', 'a']],
      ['yesterday', ['y']],
      ['m:2026-09', ['s']],
      ['m:2026-08', ['old']],
      ['unknown', ['x']],
    ]);
  });
});

describe('viewer filters', () => {
  const runs = [mk('a', NOW, { status: 'failed' }), mk('b', NOW), mk('c', NOW, { status: 'running' })];
  const runFolders = { a: 'f_work', b: 'f_side' };

  it('filters by status and folder', () => {
    const ids = (f: Parameters<typeof filterViewer>[1]) => filterViewer(runs, f, runFolders).map((r) => r.id);
    expect(ids({ statuses: [], folder: 'all' })).toEqual(['a', 'b', 'c']);
    expect(ids({ statuses: ['failed', 'running'], folder: 'all' })).toEqual(['a', 'c']);
    expect(ids({ statuses: [], folder: 'unfiled' })).toEqual(['c']);
    expect(ids({ statuses: [], folder: 'f_side' })).toEqual(['b']);
    expect(ids({ statuses: ['done'], folder: 'f_work' })).toEqual([]);
  });

  it('falls back to all folders when the chosen folder was deleted', () => {
    const ids = new Set(['f_work']);
    expect(effectiveFolder('f_work', ids)).toBe('f_work');
    expect(effectiveFolder('f_gone', ids)).toBe('all');
    expect(effectiveFolder('unfiled', ids)).toBe('unfiled');
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('toggles one run on a plain click', () => {
    let s = toggleSelection(new Set(), order, 'b', null, false);
    expect([...s]).toEqual(['b']);
    s = toggleSelection(s, order, 'b', 'b', false);
    expect([...s]).toEqual([]);
  });

  it('sets the range from the anchor on Shift-click, in either direction', () => {
    const s = toggleSelection(new Set(['b']), order, 'd', 'b', true);
    expect([...s].sort()).toEqual(['b', 'c', 'd']);
    // Shift-click on a selected run clears the range back to the anchor.
    const t = toggleSelection(new Set(order), order, 'b', 'e', true);
    expect([...t].sort()).toEqual(['a']);
  });

  it('falls back to a single toggle when the anchor is not shown', () => {
    expect([...toggleSelection(new Set(), order, 'c', 'zz', true)]).toEqual(['c']);
  });

  it('selects or clears a whole group', () => {
    expect([...setSelected(new Set(['a']), ['b', 'c'], true)].sort()).toEqual(['a', 'b', 'c']);
    expect([...setSelected(new Set(['a', 'b']), ['b', 'c'], false)]).toEqual(['a']);
  });
});
