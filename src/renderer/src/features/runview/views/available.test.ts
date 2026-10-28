import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEWS, RUN_VIEWS, normalizeSettings } from '@shared/settings';
import { buildEventItems } from '../eventItems';
import { shownView, viewAvailable, viewForKey } from './available';

const withReasoning = { hasReasoning: true };
const without = { hasReasoning: false };

describe('run views a run has', () => {
  it('offers Reasoning only to runs with readable reasoning; every other view always', () => {
    for (const v of RUN_VIEWS) {
      expect(viewAvailable(v, withReasoning)).toBe(true);
      expect(viewAvailable(v, without)).toBe(v !== 'reasoning');
      expect(viewAvailable(v, {})).toBe(v !== 'reasoning');
      expect(viewAvailable(v, undefined)).toBe(v !== 'reasoning');
    }
  });

  it('shows Activity when the chosen view is Reasoning and the run has none', () => {
    expect(shownView('reasoning', withReasoning)).toBe('reasoning');
    expect(shownView('reasoning', without)).toBe('activity');
    expect(shownView('timeline', without)).toBe('timeline');
  });

  it('maps number keys 1-7 to views; 7 does nothing for a run without reasoning', () => {
    expect(RUN_VIEWS.map((_, i) => viewForKey(String(i + 1), withReasoning))).toEqual([...RUN_VIEWS]);
    expect(viewForKey('6', without)).toBe('changes');
    expect(viewForKey('7', withReasoning)).toBe('reasoning');
    expect(viewForKey('7', without)).toBeUndefined();
    expect(viewForKey('8', withReasoning)).toBeUndefined();
    expect(viewForKey('0', withReasoning)).toBeUndefined();
    expect(viewForKey('a', withReasoning)).toBeUndefined();
  });

  it('never makes Reasoning the default view (a saved one falls back to Activity)', () => {
    expect(DEFAULT_VIEWS).not.toContain('reasoning');
    expect(normalizeSettings({ defaultView: 'reasoning' }).defaultView).toBe('activity');
    expect(normalizeSettings({ defaultView: 'changes' }).defaultView).toBe('changes');
  });

  it('marks only the newest reasoning of a running run as working', () => {
    const events = [
      { seq: 0, kind: 'reasoning' as const, text: 'First.' },
      { seq: 1, kind: 'assistant' as const, text: 'Hi' },
      { seq: 2, kind: 'reasoning' as const, text: 'Second.' },
    ];
    expect(buildEventItems(events, 'running').map((i) => !!i.working)).toEqual([false, false, true]);
    expect(buildEventItems(events, 'done').some((i) => i.working)).toBe(false);
  });
});
