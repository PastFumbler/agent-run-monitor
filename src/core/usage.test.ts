import { describe, expect, it } from 'vitest';
import { dayKey, totalTokens } from '@shared/usage';
import { emptyRun } from './adapter';
import { pushEvent } from './events';
import { addUsage, addUsageSince, cleanUsage, setUsageTotal } from './usage';

const DAY1 = new Date(2026, 9, 20, 10, 0).getTime();
const DAY2 = new Date(2026, 9, 21, 10, 0).getTime();

describe('token usage', () => {
  it('keeps unreported fields undefined, never 0', () => {
    const run = emptyRun();
    addUsage(run, { input: 10, output: 2 }, DAY1);
    expect(run.usage).toEqual({ input: 10, output: 2, byDay: { [dayKey(DAY1)]: { input: 10, output: 2 } } });
    expect(run.usage!.cacheRead).toBeUndefined();
    expect(cleanUsage({ input: undefined, output: Number.NaN })).toBeUndefined();
    expect(totalTokens(undefined)).toBeUndefined();
    expect(totalTokens({ input: 1, cacheRead: 4 })).toBe(5);
  });

  it('a run with no reported usage has no usage at all', () => {
    const run = emptyRun();
    addUsage(run, {});
    pushEvent(run, { kind: 'assistant', text: 'hi' });
    expect(run.usage).toBeUndefined();
  });

  it('buckets by the local day of each message; untimed tokens count in the totals only', () => {
    const run = emptyRun();
    addUsage(run, { input: 1, cacheRead: 100 }, DAY1);
    addUsage(run, { input: 2 }, DAY2);
    addUsage(run, { input: 4 });
    expect(run.usage).toMatchObject({ input: 7, cacheRead: 100 });
    expect(run.usage!.byDay).toEqual({ [dayKey(DAY1)]: { input: 1, cacheRead: 100 }, [dayKey(DAY2)]: { input: 2 } });
  });

  it('replaces run.usage instead of editing it (parse states share it)', () => {
    const run = emptyRun();
    addUsage(run, { input: 1 }, DAY1);
    const before = run.usage;
    addUsage(run, { input: 1 }, DAY1);
    expect(before).toMatchObject({ input: 1, byDay: { [dayKey(DAY1)]: { input: 1 } } });
    expect(run.usage!.input).toBe(2);
  });

  it('turns running totals into per-day growth, and takes a lower total as a reset', () => {
    const run = emptyRun();
    setUsageTotal(run, { input: 100, output: 10 }, DAY1);
    setUsageTotal(run, { input: 100, output: 10 }, DAY1); // repeated record: no growth
    setUsageTotal(run, { input: 150, output: 30 }, DAY2);
    expect(run.usage).toMatchObject({ input: 150, output: 30 });
    expect(run.usage!.byDay).toEqual({ [dayKey(DAY1)]: { input: 100, output: 10 }, [dayKey(DAY2)]: { input: 50, output: 20 } });
    setUsageTotal(run, { input: 20, output: 2 }, DAY2);
    expect(run.usage).toMatchObject({ input: 20, output: 2 });
    expect(run.usage!.byDay![dayKey(DAY2)]).toEqual({ input: 50, output: 20 });
  });

  it('counts an event\'s usage once, in pushEvent', () => {
    const run = emptyRun();
    pushEvent(run, { kind: 'assistant', text: 'a', ts: DAY1, usage: { output: 5, input: undefined } });
    expect(run.usage).toMatchObject({ output: 5 });
    expect(run.events[0].usage).toEqual({ output: 5 });
  });

  it('puts per-request usage on the first event after the prompt', () => {
    const run = emptyRun();
    const mark = run.tally.events;
    pushEvent(run, { kind: 'user', text: 'q' });
    pushEvent(run, { kind: 'assistant', text: 'a' });
    pushEvent(run, { kind: 'tool_call', text: 't' });
    const before = run.events[1];
    addUsageSince(run, mark, { input: 3, output: 1 }, DAY1);
    expect(run.events.map((e) => e.usage)).toEqual([undefined, { input: 3, output: 1 }, undefined]);
    expect(before.usage).toBeUndefined(); // replaced, not edited
    expect(run.usage).toMatchObject({ input: 3, output: 1 });
  });
});

describe('reasoning flag', () => {
  it('is set by readable reasoning only, not by placeholders', () => {
    const run = emptyRun();
    pushEvent(run, { kind: 'reasoning', text: 'Thinking (text not stored)', placeholder: true });
    expect(run.hasReasoning).toBeUndefined();
    pushEvent(run, { kind: 'reasoning', text: 'Check the parser first.' });
    expect(run.hasReasoning).toBe(true);
  });
});
