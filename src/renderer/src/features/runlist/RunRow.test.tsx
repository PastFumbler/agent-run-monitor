// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { RunSummary } from '@shared/schema';
import { MotionPolicyContext } from '../../motion/context';
import { computeMotionPolicy } from '../../motion/policy';
import { RunRow, rowStatusWord } from './RunRow';

afterEach(cleanup);

const NOW = Date.parse('2026-10-27T15:30:00Z');
const full = computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'off', osReducedMotion: false, power: null, hidden: false });

const run = (o: Partial<RunSummary> = {}): RunSummary => ({
  id: 'codex:1',
  agent: 'codex',
  title: 'Add a flag',
  projectName: 'todo-cli',
  startedAt: NOW - 60_000,
  updatedAt: NOW - 1000,
  status: 'running',
  counts: { events: 3, messages: 1, toolCalls: 1, errors: 0, filesChanged: 0 },
  sourcePath: '/home/demo/x.jsonl',
  ...o,
});

function row(r: RunSummary, current: boolean) {
  return render(
    <MotionPolicyContext.Provider value={full}>
      <div role="listbox">
        <RunRow run={r} optionId="o1" current={current} cursor={false} inMulti={false} entering={false} now={NOW} timeFormat="relative" onClick={() => {}} />
      </div>
    </MotionPolicyContext.Provider>,
  );
}

describe('run list rows and motion', () => {
  it('a running row that is not the open run is drawn still (mark and lattice), with its shapes', () => {
    const { container } = row(run(), false);
    const mark = container.querySelector('.status-mark')!;
    expect(mark.hasAttribute('data-spin')).toBe(false);
    expect(mark.getAttribute('data-shape')).toBe('arc');
    const lattice = container.querySelector('.lattice-loader')!;
    expect(lattice.hasAttribute('data-animated')).toBe(false);
    // The static frame still lights some cells, so it reads as "in progress".
    expect(lattice.querySelectorAll('.lattice-loader__run .lattice-loader__cell[data-on]').length).toBeGreaterThan(0);
  });

  it('the open run keeps its spinner and lattice loop', () => {
    const { container } = row(run(), true);
    expect(container.querySelector('.status-mark')!.hasAttribute('data-spin')).toBe(true);
    expect(container.querySelector('.lattice-loader')!.hasAttribute('data-animated')).toBe(true);
  });

  it('an inferred wait reads "Probably waiting" in the row and its accessible name', () => {
    expect(rowStatusWord({ status: 'waiting', statusInferred: true })).toBe('Probably waiting');
    expect(rowStatusWord({ status: 'waiting' })).toBe('Waiting');
    expect(rowStatusWord({ status: 'running', statusInferred: true })).toBe('Running');
    const { container } = row(run({ status: 'waiting', statusInferred: true }), false);
    expect(container.querySelector('.runrow__status')!.textContent).toBe('Probably waiting');
    expect(container.querySelector('[role="option"]')!.getAttribute('aria-label')).toContain('Probably waiting');
  });
});
