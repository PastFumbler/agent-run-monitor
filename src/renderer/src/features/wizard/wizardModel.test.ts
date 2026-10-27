import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@shared/schema';
import { defaultSettings } from '@shared/settings';
import { computeMotionPolicy, type MotionInputs } from '../../motion/policy';
import { pickLatestRun, stepMotion, WIZARD_STEPS } from './wizardModel';

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
