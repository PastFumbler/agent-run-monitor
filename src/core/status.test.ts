import { describe, expect, it } from 'vitest';
import { emptyRun, freshState, type ParsedRun, type SessionRef } from './adapter';
import { toSummary } from './build';
import { INFERRED_WAIT_AFTER, judgeStatus, SHELL_STUCK_AFTER } from './status';

const T0 = Date.parse('2026-10-27T12:00:00Z');

function run(over: Partial<ParsedRun>): ParsedRun {
  return { ...emptyRun('demo'), lastEventAt: T0, ...over };
}

describe('judgeStatus: inferred waiting', () => {
  const shell = { name: 'exec_command', kind: 'run' as const, since: T0 };

  it('an open tool from a format that records approvals stays running, not inferred', () => {
    const r = run({ turn: 'in_progress', openTool: shell });
    expect(judgeStatus(r, T0, T0 + 5 * 60_000)).toEqual({ status: 'running', detail: 'Running exec_command' });
  });

  it('with turnInferred, an open tool is running (inferred) until the file has been quiet a while', () => {
    const r = run({ turn: 'in_progress', openTool: shell, turnInferred: true });
    expect(judgeStatus(r, T0, T0 + 10_000)).toEqual({ status: 'running', detail: 'Running exec_command', inferred: true });
    expect(judgeStatus(r, T0, T0 + INFERRED_WAIT_AFTER)).toEqual({
      status: 'waiting',
      detail: 'exec_command may need your approval, or it is still running',
      inferred: true,
    });
  });

  it('stuck still wins over an inferred wait', () => {
    const r = run({ turn: 'in_progress', openTool: shell, turnInferred: true });
    expect(judgeStatus(r, T0, T0 + SHELL_STUCK_AFTER + 1000).status).toBe('stuck');
  });

  it('a waiting_input turn is inferred only when the adapter says it guessed', () => {
    expect(judgeStatus(run({ turn: 'waiting_input' }), T0, T0 + 1000)).toEqual({ status: 'waiting', detail: 'Waiting for your input' });
    expect(judgeStatus(run({ turn: 'waiting_input', turnInferred: true }), T0, T0 + 1000)).toMatchObject({ status: 'waiting', inferred: true });
  });

  it('finished, failed and unreadable runs are never marked inferred', () => {
    expect(judgeStatus(run({ turn: 'completed', turnInferred: true }), T0, T0 + 1000).inferred).toBeUndefined();
    expect(judgeStatus(run({ turn: 'error', turnInferred: true }), T0, T0 + 1000).inferred).toBeUndefined();
    expect(judgeStatus(run({ readError: 'bad', turnInferred: true }), T0, T0).inferred).toBeUndefined();
  });

  it('the run summary carries statusInferred', () => {
    const ref: SessionRef = { agent: 'codex', path: '/demo/rollout.jsonl', mtimeMs: T0, size: 10 };
    const st = freshState();
    st.run = run({ title: 'demo', turn: 'in_progress', openTool: shell, turnInferred: true });
    const s = toSummary(ref, st, T0 + 2 * INFERRED_WAIT_AFTER, false);
    expect(s.status).toBe('waiting');
    expect(s.statusInferred).toBe(true);
    st.run.turnInferred = undefined;
    expect(toSummary(ref, st, T0 + 2 * INFERRED_WAIT_AFTER, false).statusInferred).toBeUndefined();
  });
});
