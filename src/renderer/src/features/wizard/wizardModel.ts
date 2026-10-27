// Pure parts of the first-run wizard: the steps, the step-change animation chosen from the motion
// policy, and which run "Open my latest run" lands on.

import type { AgentId, RunSummary } from '@shared/schema';
import type { SourceSettings } from '@shared/settings';
import type { Transition } from 'motion/react';
import type { MotionPolicy } from '../../motion/policy';

export const WIZARD_STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'detect', label: 'Find your agents' },
  { id: 'look', label: 'Look & feel' },
  { id: 'done', label: 'Done' },
] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

export interface StepMotion {
  initial: false | { opacity: number; x?: number };
  animate: { opacity: number; x?: number };
  transition: Transition & { duration: number };
}

/**
 * The step change. Reduced motion or a hidden window: nothing moves (instant). Low GPU: a short
 * opacity fade only. Otherwise a fade with a small slide in the direction of travel. Durations come
 * from the policy (150-250 ms normally, about 120 ms in low-GPU mode).
 */
export function stepMotion(p: MotionPolicy, direction: 1 | -1): StepMotion {
  if (!p.animate || p.duration <= 0) return { initial: false, animate: { opacity: 1, x: 0 }, transition: { duration: 0 } };
  const duration = p.duration / 1000;
  if (p.lowGpu) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration, ease: 'easeOut' } };
  return { initial: { opacity: 0, x: 14 * direction }, animate: { opacity: 1, x: 0 }, transition: { duration, ease: [0.23, 1, 0.32, 1] } };
}

/** The newest run from a switched-on source (order is newest first). */
export function pickLatestRun(
  order: string[],
  runs: Record<string, RunSummary>,
  sources: Record<AgentId, SourceSettings>,
): string | null {
  for (const id of order) {
    const r = runs[id];
    if (r && sources[r.agent]?.enabled !== false) return id;
  }
  return null;
}

export interface DoneCountInput {
  /** Runs the switched-on sources found in the detection step (null until it is known). */
  detected: number | null;
  /** Runs in the list so far. */
  listed: number;
  /** The first run list has arrived. */
  listLoaded: boolean;
  /** Initial-load progress from the backend (null once everything is read). */
  progress: { parsed: number; total: number } | null;
}

/**
 * The Done step's "Watching N runs". While the app is still reading runs, the list holds only part
 * of them, so N is the larger of what detection found and what the backend says it is reading, with
 * "(still reading…)" after it. Once reading is over, the list is the truth. `empty` picks the
 * "no runs yet" screen, never while reading.
 */
export function doneCount(i: DoneCountInput): { runs: number; reading: boolean; empty: boolean } {
  const reading = !i.listLoaded || (!!i.progress && i.progress.parsed < i.progress.total);
  if (reading) return { runs: Math.max(i.detected ?? 0, i.progress?.total ?? 0, i.listed), reading, empty: false };
  return { runs: i.listed, reading, empty: i.listed === 0 };
}
