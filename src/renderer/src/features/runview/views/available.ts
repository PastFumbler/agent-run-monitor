// Which run views a run has. Most views exist for every run; Reasoning only for runs whose source
// stored readable reasoning (RunSummary.hasReasoning), so it is hidden elsewhere rather than empty.
// Pure, so the run view, the multiviewer tiles and the number keys agree.

import type { RunSummary } from '@shared/schema';
import { RUN_VIEWS, type RunView } from '@shared/settings';

export function viewAvailable(view: RunView, run: Pick<RunSummary, 'hasReasoning'> | undefined): boolean {
  return view !== 'reasoning' || !!run?.hasReasoning;
}

/** The view to show: the chosen one, or Activity when this run doesn't have it. */
export function shownView(view: RunView, run: Pick<RunSummary, 'hasReasoning'> | undefined): RunView {
  return viewAvailable(view, run) ? view : 'activity';
}

/** The view a number key opens for this run, or undefined when the key means nothing here. */
export function viewForKey(key: string, run: Pick<RunSummary, 'hasReasoning'> | undefined): RunView | undefined {
  if (!/^[1-9]$/.test(key)) return undefined;
  const view = RUN_VIEWS[Number(key) - 1];
  return view && viewAvailable(view, run) ? view : undefined;
}
