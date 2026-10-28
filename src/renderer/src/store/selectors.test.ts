import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { buildSections, filterRuns, navOrder, RECENT_SHOWN } from './selectors';

const NOW = new Date(2026, 9, 27, 15, 30).getTime();
const H = 3_600_000;

const mk = (id: string, ago: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  id,
  agent: 'codex',
  title: id,
  projectName: 'todo-cli',
  startedAt: NOW - ago - H,
  updatedAt: NOW - ago,
  status: 'done',
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: `/home/demo/${id}`,
  ...extra,
});

const runs = [mk('a', 0.1 * H), mk('b', 2 * H, { status: 'failed' }), mk('c', 26 * H), mk('d', 5 * 24 * H, { agent: 'aider' })];

describe('run list sections', () => {
  it('groups into Pinned / Recent / Today / Yesterday / Earlier', () => {
    const s = buildSections(runs, ['c'], ['b', 'c'], NOW);
    expect(s.map((x) => [x.id, x.runs.map((r) => r.id)])).toEqual([
      ['pinned', ['c']],
      ['recent', ['b']],
      ['today', ['a', 'b']],
      ['earlier', ['d']],
    ]);
  });

  it('navigation skips the Recent repeats so opening a run never reshuffles it', () => {
    const before = navOrder(buildSections(runs, [], [], NOW));
    const after = navOrder(buildSections(runs, [], ['c', 'a'], NOW));
    expect(after).toEqual(before);
    expect(before).toEqual(['a', 'b', 'c', 'd']);
  });

  describe('Recent order', () => {
    // Stored newest addition first: c was opened last, then a, then d.
    const stored = ['c', 'a', 'd'];
    const recentIds = (on: boolean, list = runs, ids = stored) =>
      buildSections(list, [], ids, NOW, on).find((x) => x.id === 'recent')?.runs.map((r) => r.id);

    it('with "Move updated runs to top" on (default), is ordered by last update', () => {
      expect(recentIds(true)).toEqual(['a', 'c', 'd']);
      expect(buildSections(runs, [], stored, NOW).find((x) => x.id === 'recent')?.runs.map((r) => r.id)).toEqual(['a', 'c', 'd']);
      // d gets new activity: it moves to the top.
      const updated = runs.map((r) => (r.id === 'd' ? { ...r, updatedAt: NOW } : r));
      expect(recentIds(true, updated)).toEqual(['d', 'a', 'c']);
    });

    it('with it off, keeps the stored order however runs are updated', () => {
      expect(recentIds(false)).toEqual(['c', 'a', 'd']);
      const updated = runs.map((r) => (r.id === 'd' ? { ...r, updatedAt: NOW } : r));
      expect(recentIds(false, updated)).toEqual(['c', 'a', 'd']);
      // A newly opened run (added on top of the stored list) appears at the top.
      expect(recentIds(false, runs, ['b', ...stored])).toEqual(['b', 'c', 'a', 'd']);
    });

    it('shows the last RECENT_SHOWN opened runs, even when older runs were updated later', () => {
      const many = Array.from({ length: 8 }, (_, i) => mk(`r${i}`, i * H));
      // Opened r7 (oldest update) last; r0 (newest update) first, so it falls off.
      const ids = ['r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'r1', 'r0'];
      expect(recentIds(true, many, ids)).toEqual(['r3', 'r4', 'r5', 'r6', 'r7']);
      expect(recentIds(false, many, ids)).toEqual(['r7', 'r6', 'r5', 'r4', 'r3']);
      expect(RECENT_SHOWN).toBe(5);
    });
  });

  it('filters by agent, status and text', () => {
    expect(filterRuns(runs, { agents: ['aider'], statuses: [], text: '' }, NOW).map((r) => r.id)).toEqual(['d']);
    expect(filterRuns(runs, { agents: [], statuses: ['failed'], text: '' }, NOW).map((r) => r.id)).toEqual(['b']);
    expect(filterRuns(runs, { agents: [], statuses: [], text: 'yesterday' }, NOW).map((r) => r.id)).toEqual(['c']);
  });
});
