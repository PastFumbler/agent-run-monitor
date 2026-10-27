// Judges a run's status at an instant, from what the adapter read and how long the file has
// been quiet. The thresholds come from the run monitor this project grew out of:
// - a busy run silent for 5 minutes is "quiet" (still running, but we say so),
// - silent for 20 minutes it is stuck,
// - a shell call open for 12 minutes is stuck (agents' shell tools time out at 10),
// - any tool call open for 65 minutes is stuck,
// - a finished turn reads "idle" for 3 minutes (the user may reply), then "done".
// Formats that cannot record approval prompts (ParsedRun.turnInferred) get one more rule: an open
// tool call with a file quiet for a minute is probably an approval prompt, so the run reads
// "waiting", marked inferred so the UI can say "Probably waiting for you".

import type { RunStatus } from '@shared/schema';
import type { ParsedRun } from './adapter';

export const QUIET_AFTER = 5 * 60_000;
export const STUCK_AFTER = 20 * 60_000;
export const SHELL_STUCK_AFTER = 12 * 60_000;
export const TOOL_STUCK_AFTER = 65 * 60_000;
export const IDLE_FOR = 3 * 60_000;
/** A mid-turn run silent this long was closed or crashed long ago: shown as done, not stuck. */
export const ABANDONED_AFTER = 24 * 60 * 60_000;
/** With no turn information at all, a file written this recently counts as running. */
export const UNKNOWN_LIVE_FOR = 2 * 60_000;
/** With turnInferred, an open tool call quiet this long is probably waiting for the user's approval. */
export const INFERRED_WAIT_AFTER = 60_000;

export interface Judgement {
  status: RunStatus;
  detail?: string;
  /**
   * Set when the status is a guess rather than something the file records: a 'waiting', or a
   * 'running' with an open tool, from an adapter that cannot see approval prompts.
   */
  inferred?: true;
}

function withInferred(j: Judgement, run: ParsedRun): Judgement {
  return run.turnInferred ? { ...j, inferred: true } : j;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} min`;
}

/**
 * @param run     what the adapter parsed
 * @param fileMtime the session file's last write (epoch ms)
 * @param now     the instant to judge at (epoch ms)
 */
export function judgeStatus(run: ParsedRun, fileMtime: number, now: number): Judgement {
  if (run.readError) return { status: 'unreadable', detail: run.readError };
  const last = Math.max(run.lastEventAt ?? 0, fileMtime || 0);
  const silent = Math.max(0, now - last);

  switch (run.turn) {
    case 'error':
      return { status: 'failed', detail: run.turnDetail || 'The last turn ended with an error' };
    case 'waiting_input':
      // A session closed while it waited is not still waiting a day later.
      if (silent >= ABANDONED_AFTER) return { status: 'done', detail: 'Ended while waiting for input' };
      return withInferred({ status: 'waiting', detail: run.turnDetail || 'Waiting for your input' }, run);
    case 'aborted':
      return silent < IDLE_FOR
        ? { status: 'idle', detail: run.turnDetail || 'Interrupted' }
        : { status: 'done', detail: run.turnDetail || 'Interrupted' };
    case 'completed':
      return silent < IDLE_FOR ? { status: 'idle', detail: 'Turn finished' } : { status: 'done' };
    case 'in_progress':
    case 'unknown':
    default:
      break;
  }

  // A session closed mid-turn days ago is history, not an emergency.
  if (silent >= ABANDONED_AFTER) return { status: 'done', detail: 'Ended without finishing its turn' };

  if (run.openTool) {
    const open = Math.max(0, now - run.openTool.since);
    if (run.openTool.kind === 'run' && open >= SHELL_STUCK_AFTER && silent >= SHELL_STUCK_AFTER)
      return { status: 'stuck', detail: `A shell command has been running for ${minutes(open)} with no output` };
    if (open >= TOOL_STUCK_AFTER && silent >= TOOL_STUCK_AFTER)
      return { status: 'stuck', detail: `${run.openTool.name} has been open for ${minutes(open)}` };
    if (run.turnInferred && silent >= INFERRED_WAIT_AFTER)
      return { status: 'waiting', detail: `${run.openTool.name} may need your approval, or it is still running`, inferred: true };
    return withInferred({ status: 'running', detail: `Running ${run.openTool.name}` }, run);
  }

  if (run.turn === 'unknown') {
    return silent < UNKNOWN_LIVE_FOR ? { status: 'running' } : { status: 'done' };
  }

  if (silent >= STUCK_AFTER) return { status: 'stuck', detail: `No activity for ${minutes(silent)}` };
  if (silent >= QUIET_AFTER) return { status: 'running', detail: `Quiet for ${minutes(silent)}` };
  return { status: 'running' };
}
