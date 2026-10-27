// The rules for finish notifications, kept free of Electron so they can be unit-tested
// (notify.test.ts). system.ts shows the notices; this file decides whether and what.

import { AGENT_NAMES } from '@shared/schema';
import type { RunFinishedNotice } from '@shared/ipc';
import type { Settings } from '@shared/settings';

const WORDS: Record<RunFinishedNotice['outcome'], string> = {
  done: 'finished',
  waiting: 'needs you',
  failed: 'failed',
  stuck: 'looks stuck',
};

/** The same run notifies at most once in this window. */
export const NOTICE_COOLDOWN_MS = 20_000;

/** Plain words for a notice. Deliberately leaves out the run's title: it is the user's prompt and may show on a lock screen. */
export function noticeText(n: RunFinishedNotice): { title: string; body: string } {
  const agent = AGENT_NAMES[n.run.agent] ?? n.run.agent;
  // An inferred wait (a quiet open tool call in a format that cannot record approval prompts) is a guess.
  const words = n.outcome === 'waiting' && n.run.statusInferred ? 'may need you' : WORDS[n.outcome];
  return { title: 'Agent Run Monitor', body: `${agent}: ${n.run.projectName} — ${words}` };
}

/** Remembers when each run last notified, for the cooldown. */
export class NoticeGate {
  private readonly lastShown = new Map<string, number>();

  constructor(private readonly cooldownMs = NOTICE_COOLDOWN_MS) {}

  /**
   * Whether a notice should show: never for sub-runs, only when the matching setting is on
   * (failed and stuck follow "on failure", done and waiting follow "on finish"), and not again
   * for the same run within the cooldown.
   */
  shouldNotify(n: RunFinishedNotice, s: Settings, now: number): boolean {
    if (n.run.parentId) return false; // sub-agents: a workflow can finish hundreds; the parent says enough
    const failure = n.outcome === 'failed' || n.outcome === 'stuck';
    if (failure ? !s.notifyOnFailure : !s.notifyOnFinish) return false;
    const prev = this.lastShown.get(n.run.id);
    if (prev !== undefined && now - prev < this.cooldownMs) return false;
    return true;
  }

  /** Records that a notice for this run was shown now. */
  markShown(runId: string, now: number): void {
    for (const [id, at] of this.lastShown) if (now - at >= this.cooldownMs) this.lastShown.delete(id);
    this.lastShown.set(runId, now);
  }
}
