// Finish-notification rules: which outcomes follow which setting, sub-runs skipped, the per-run
// cooldown, and notice text that never carries the run's title (the user's prompt).

import { describe, expect, it } from 'vitest';
import type { RunFinishedNotice } from '@shared/ipc';
import type { RunSummary } from '@shared/schema';
import { defaultSettings, type Settings } from '@shared/settings';
import { NOTICE_COOLDOWN_MS, NoticeGate, noticeText } from './notify';

function notice(outcome: RunFinishedNotice['outcome'], patch: Partial<RunSummary> = {}): RunFinishedNotice {
  const run: RunSummary = {
    id: 'claude-code:abc',
    agent: 'claude-code',
    title: 'Rotate the staging password hunter2',
    projectName: 'demo-shop',
    startedAt: 0,
    updatedAt: 0,
    status: outcome === 'done' ? 'done' : outcome === 'failed' ? 'failed' : outcome === 'stuck' ? 'stuck' : 'waiting',
    counts: { events: 1, messages: 1, toolCalls: 0, errors: 0, filesChanged: 0 },
    sourcePath: '/home/demo/.claude/projects/demo-shop/abc.jsonl',
    ...patch,
  };
  return { run, outcome };
}

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...patch });
const NOW = 1_800_000_000_000;

describe('NoticeGate.shouldNotify', () => {
  it('notifies for every outcome with the default settings', () => {
    for (const o of ['done', 'waiting', 'failed', 'stuck'] as const) {
      expect(new NoticeGate().shouldNotify(notice(o), settings(), NOW)).toBe(true);
    }
  });

  it('done and waiting follow "on finish"; failed and stuck follow "on failure"', () => {
    const noFinish = settings({ notifyOnFinish: false });
    const noFailure = settings({ notifyOnFailure: false });
    const g = () => new NoticeGate();
    expect(g().shouldNotify(notice('done'), noFinish, NOW)).toBe(false);
    expect(g().shouldNotify(notice('waiting'), noFinish, NOW)).toBe(false);
    expect(g().shouldNotify(notice('failed'), noFinish, NOW)).toBe(true);
    expect(g().shouldNotify(notice('stuck'), noFinish, NOW)).toBe(true);

    expect(g().shouldNotify(notice('done'), noFailure, NOW)).toBe(true);
    expect(g().shouldNotify(notice('waiting'), noFailure, NOW)).toBe(true);
    expect(g().shouldNotify(notice('failed'), noFailure, NOW)).toBe(false);
    expect(g().shouldNotify(notice('stuck'), noFailure, NOW)).toBe(false);

    const neither = settings({ notifyOnFinish: false, notifyOnFailure: false });
    for (const o of ['done', 'waiting', 'failed', 'stuck'] as const) expect(g().shouldNotify(notice(o), neither, NOW)).toBe(false);
  });

  it('never notifies for a sub-run (one with a parentId)', () => {
    const gate = new NoticeGate();
    for (const o of ['done', 'waiting', 'failed', 'stuck'] as const) {
      expect(gate.shouldNotify(notice(o, { parentId: 'claude-code:parent' }), settings(), NOW)).toBe(false);
    }
  });

  it('holds the same run back for 20 s after a notice, but not other runs', () => {
    expect(NOTICE_COOLDOWN_MS).toBe(20_000);
    const gate = new NoticeGate();
    const n = notice('done');
    expect(gate.shouldNotify(n, settings(), NOW)).toBe(true);
    gate.markShown(n.run.id, NOW);
    expect(gate.shouldNotify(n, settings(), NOW + 1)).toBe(false);
    expect(gate.shouldNotify(notice('failed'), settings(), NOW + 19_999)).toBe(false);
    expect(gate.shouldNotify(notice('done', { id: 'codex:other' }), settings(), NOW + 1)).toBe(true);
    expect(gate.shouldNotify(n, settings(), NOW + 20_000)).toBe(true);
  });

  it('asking does not start the cooldown; only a shown notice does', () => {
    const gate = new NoticeGate();
    const n = notice('done');
    expect(gate.shouldNotify(n, settings(), NOW)).toBe(true);
    expect(gate.shouldNotify(n, settings(), NOW + 1)).toBe(true);
  });
});

describe('noticeText', () => {
  it('names the agent, the project and the outcome in plain words', () => {
    expect(noticeText(notice('done'))).toEqual({ title: 'Agent Run Monitor', body: 'Claude Code: demo-shop — finished' });
    expect(noticeText(notice('waiting')).body).toBe('Claude Code: demo-shop — needs you');
    expect(noticeText(notice('failed')).body).toBe('Claude Code: demo-shop — failed');
    expect(noticeText(notice('stuck')).body).toBe('Claude Code: demo-shop — looks stuck');
    expect(noticeText(notice('done', { agent: 'codex' })).body).toBe('Codex: demo-shop — finished');
    expect(noticeText(notice('waiting', { agent: 'codex', statusInferred: true })).body).toBe('Codex: demo-shop — may need you');
  });

  it("leaves out the run's title (the user's prompt), which may show on a lock screen", () => {
    for (const o of ['done', 'waiting', 'failed', 'stuck'] as const) {
      const t = noticeText(notice(o));
      expect(`${t.title} ${t.body}`).not.toContain('Rotate');
      expect(`${t.title} ${t.body}`).not.toContain('hunter2');
    }
  });
});
