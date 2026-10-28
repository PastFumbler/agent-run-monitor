// The Simple display tier (Settings > Customisation): only running runs, one large plain line each.
// Pure helpers for the board (SimpleBoard.tsx) and the shell.

import type { RunSummary } from '@shared/schema';
import type { Route } from '../../store/store';
import type { Settings } from '@shared/settings';

/** Runs whose detail is pushed live for the board; any further running runs read from their summary alone. */
export const SIMPLE_WATCHED = 12;

/**
 * Running runs only, oldest start first (ties by id), so lines keep their places as runs update and a
 * new run appears at the bottom: nothing jumps around on a screen read from across the room.
 */
export function simpleRuns(runs: Iterable<RunSummary>): RunSummary[] {
  return [...runs].filter((r) => r.status === 'running').sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True when the Simple board replaces the app: the tier is on, and the screen isn't Settings or the first-run guide. */
export function simpleShown(tier: Settings['displayTier'], route: Route): boolean {
  return tier === 'simple' && route !== 'settings' && route !== 'wizard';
}
