import { describe, expect, it } from 'vitest';
import type { PowerState } from '@shared/ipc';
import type { TriState } from '@shared/settings';
import { computeMotionPolicy, DURATION_LOW_GPU, DURATION_NORMAL, type MotionInputs } from './policy';

const AC: PowerState = { onBattery: false, powerSaver: false, known: true };
const BATTERY: PowerState = { onBattery: true, powerSaver: false, known: true };
const SAVER: PowerState = { onBattery: false, powerSaver: true, known: true };
const UNKNOWN: PowerState = { onBattery: true, powerSaver: true, known: false };

const p = (o: Partial<MotionInputs>) =>
  computeMotionPolicy({ reduceMotion: 'auto', lowGpu: 'auto', osReducedMotion: false, power: AC, hidden: false, ...o });

describe('motion policy', () => {
  it('normal: full motion, 150-250 ms, 250 ms updates', () => {
    const r = p({});
    expect(r).toMatchObject({ reduce: false, lowGpu: false, hidden: false, animate: true, allowInfinite: true, allowLayered: true, updateIntervalMs: 250 });
    expect(r.duration).toBe(DURATION_NORMAL);
    expect(r.duration).toBeGreaterThanOrEqual(150);
    expect(r.duration).toBeLessThanOrEqual(250);
  });

  it('reduce motion (OS, Auto): nothing animates, duration 0, layers still fine', () => {
    const r = p({ osReducedMotion: true });
    expect(r).toMatchObject({ reduce: true, animate: false, duration: 0, allowInfinite: false, allowLayered: true, updateIntervalMs: 250 });
  });

  it('the setting overrides the OS both ways', () => {
    expect(p({ reduceMotion: 'on', osReducedMotion: false }).reduce).toBe(true);
    expect(p({ reduceMotion: 'off', osReducedMotion: true }).reduce).toBe(false);
  });

  it('low GPU (Auto) follows battery or energy saver, only when the platform knows', () => {
    expect(p({ power: BATTERY }).lowGpu).toBe(true);
    expect(p({ power: SAVER }).lowGpu).toBe(true);
    expect(p({ power: AC }).lowGpu).toBe(false);
    expect(p({ power: UNKNOWN }).lowGpu).toBe(false);
    expect(p({ power: null }).lowGpu).toBe(false);
  });

  it('low GPU: short, finite, no layers, 1 s updates', () => {
    const r = p({ lowGpu: 'on' });
    expect(r).toMatchObject({ lowGpu: true, animate: true, duration: DURATION_LOW_GPU, allowInfinite: false, allowLayered: false, updateIntervalMs: 1000 });
    expect(r.duration).toBeGreaterThanOrEqual(100);
    expect(r.duration).toBeLessThanOrEqual(140);
    expect(p({ lowGpu: 'off', power: BATTERY }).lowGpu).toBe(false);
  });

  it('hidden: everything stops and updates batch every 5 s, whatever else is set', () => {
    for (const reduceMotion of ['auto', 'on', 'off'] as TriState[])
      for (const lowGpu of ['auto', 'on', 'off'] as TriState[]) {
        const r = p({ reduceMotion, lowGpu, hidden: true, power: BATTERY });
        expect(r).toMatchObject({ hidden: true, animate: false, duration: 0, allowInfinite: false, allowLayered: false, updateIntervalMs: 5000 });
      }
  });

  it('reduce + low GPU: no animation and 1 s updates', () => {
    const r = p({ osReducedMotion: true, power: BATTERY });
    expect(r).toMatchObject({ reduce: true, lowGpu: true, animate: false, duration: 0, allowInfinite: false, allowLayered: false, updateIntervalMs: 1000 });
  });
});
