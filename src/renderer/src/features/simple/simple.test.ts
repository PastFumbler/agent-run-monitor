import { describe, expect, it } from 'vitest';
import type { RunStatus, RunSummary } from '@shared/schema';
import { simpleRuns, simpleShown } from './simple';

const run = (id: string, status: RunStatus, startedAt: number): RunSummary => ({
  id,
  agent: 'claude-code',
  title: id,
  projectName: 'p',
  startedAt,
  updatedAt: startedAt + 10,
  status,
  counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
  sourcePath: '/x',
});

describe('simple display tier', () => {
  it('keeps only running runs, oldest start first, ties by id', () => {
    const runs = [run('c', 'running', 30), run('w', 'waiting', 1), run('b', 'running', 10), run('a', 'running', 10), run('d', 'done', 5)];
    expect(simpleRuns(runs).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('replaces every screen but Settings and the first-run guide', () => {
    for (const r of ['dashboard', 'run', 'runs', 'usage', 'multiview'] as const) expect(simpleShown('simple', r)).toBe(true);
    expect(simpleShown('simple', 'settings')).toBe(false);
    expect(simpleShown('simple', 'wizard')).toBe(false);
    expect(simpleShown('default', 'dashboard')).toBe(false);
  });
});
