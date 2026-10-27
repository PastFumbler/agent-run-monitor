import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { buildSections, filterRuns, navOrder } from './selectors';

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

  it('filters by agent, status and text', () => {
    expect(filterRuns(runs, { agents: ['aider'], statuses: [], text: '' }, NOW).map((r) => r.id)).toEqual(['d']);
    expect(filterRuns(runs, { agents: [], statuses: ['failed'], text: '' }, NOW).map((r) => r.id)).toEqual(['b']);
    expect(filterRuns(runs, { agents: [], statuses: [], text: 'yesterday' }, NOW).map((r) => r.id)).toEqual(['c']);
  });
});
