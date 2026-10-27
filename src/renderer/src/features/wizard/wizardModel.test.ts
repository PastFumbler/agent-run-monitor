import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { defaultSettings } from '@shared/settings';
import { computeMotionPolicy, type MotionInputs } from '../../motion/policy';
import { doneCount, pickLatestRun, stepMotion, WIZARD_STEPS } from './wizardModel';

const policy = (o: Partial<MotionInputs>) =>
  computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'off', osReducedMotion: false, power: null, hidden: false, ...o });

describe('wizard steps', () => {
  it('has the four steps in order', () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(['welcome', 'detect', 'look', 'done']);
  });
});

describe('step motion follows the motion policy', () => {
  it('normal: fade and a small slide, 150-250 ms', () => {
    const m = stepMotion(policy({}), 1);
    expect(m.initial).toEqual({ opacity: 0, x: 14 });
    expect(m.transition.duration * 1000).toBeGreaterThanOrEqual(150);
    expect(m.transition.duration * 1000).toBeLessThanOrEqual(250);
    expect(stepMotion(policy({}), -1).initial).toEqual({ opacity: 0, x: -14 });
  });

  it('reduce motion: nothing moves', () => {
    const m = stepMotion(policy({ reduceMotion: 'on' }), 1);
    expect(m.initial).toBe(false);
    expect(m.transition.duration).toBe(0);
  });

  it('hidden window: nothing moves', () => {
    const m = stepMotion(policy({ hidden: true }), 1);
    expect(m.initial).toBe(false);
    expect(m.transition.duration).toBe(0);
  });

  it('low GPU: opacity only, short', () => {
    const m = stepMotion(policy({ lowGpu: 'on' }), 1);
    expect(m.initial).toEqual({ opacity: 0 });
    expect(m.animate).toEqual({ opacity: 1 });
    expect(m.transition.duration * 1000).toBeLessThan(150);
  });
});

describe('pickLatestRun', () => {
  const run = (id: string, agent: RunSummary['agent']) => ({ id, agent }) as RunSummary;
  it('takes the newest run from a switched-on source', () => {
    const sources = defaultSettings().sources;
    sources.codex.enabled = false;
    const runs = { a: run('a', 'codex'), b: run('b', 'claude-code') };
    expect(pickLatestRun(['a', 'b'], runs, sources)).toBe('b');
    expect(pickLatestRun(['a'], runs, sources)).toBeNull();
    expect(pickLatestRun([], runs, sources)).toBeNull();
    expect(pickLatestRun(['missing', 'b'], runs, sources)).toBe('b');
  });
});

describe('done step count', () => {
  it('while reading: the detected total (or the backend total), marked as still reading', () => {
    expect(doneCount({ detected: 554, listed: 146, listLoaded: true, progress: { parsed: 146, total: 554 } })).toEqual({ runs: 554, reading: true, empty: false });
    expect(doneCount({ detected: null, listed: 0, listLoaded: true, progress: { parsed: 0, total: 30 } })).toEqual({ runs: 30, reading: true, empty: false });
    expect(doneCount({ detected: 12, listed: 0, listLoaded: false, progress: null })).toEqual({ runs: 12, reading: true, empty: false });
  });

  it('once read: the list is the truth, and an empty list is the "no runs yet" screen', () => {
    expect(doneCount({ detected: 554, listed: 553, listLoaded: true, progress: null })).toEqual({ runs: 553, reading: false, empty: false });
    expect(doneCount({ detected: 0, listed: 0, listLoaded: true, progress: null })).toEqual({ runs: 0, reading: false, empty: true });
  });
});
