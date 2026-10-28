// The summary at the top of Overview. Always available: one or two sentences built on this computer
// from the run's own data (localSummary). With AI summaries on (Settings > AI summary), the main run
// view asks the backend once each time Overview is shown for a run; main sends masked run text to
// the chosen provider or reuses a saved summary of the same content. Multiviewer tiles never ask.
// Any failure keeps the local summary and adds a short note.

import { useEffect, useMemo, useState } from 'react';
import { PROVIDER_NAMES, type AiSummaryResult } from '@shared/ai';
import type { RunDetail } from '@shared/schema';
import { localSummary } from '@shared/summary';
import { getBackend } from '../../../backend';
import { useStore } from '../../../store/store';

/** How long Overview must stay on a run before its content is sent. */
const ASK_AFTER_MS = 600;

export function OverviewSummary({ detail, compact, headingId }: { detail: RunDetail; compact?: boolean; headingId: string }) {
  const s = detail.summary;
  const enabled = useStore((st) => st.settings.aiSummaries);
  const provider = useStore((st) => st.settings.aiProvider);
  const model = useStore((st) => st.settings.aiModel);
  const local = useMemo(() => localSummary(detail), [detail]);
  // One request per run (and provider/model) while this Overview is shown; live updates don't ask again.
  const ask = enabled && !compact ? `${s.id}\n${provider}\n${model}` : '';
  const [ai, setAi] = useState<{ ask: string; result: AiSummaryResult }>();
  useEffect(() => {
    if (!ask) return;
    let live = true;
    const id = ask.split('\n')[0];
    // Only for a run the user stays on: stepping through runs (j/k) with Overview as the default view
    // must not send each run passed on the way.
    const timer = setTimeout(() => {
      getBackend()
        .summarizeRun(id)
        .then(
          (result) => live && setAi({ ask, result }),
          () => live && setAi({ ask, result: { error: "Couldn't ask for an AI summary." } }),
        );
    }, ASK_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ask]);

  const result = ask && ai?.ask === ask ? ai.result : undefined;
  const text = result?.text;
  const name = PROVIDER_NAMES[result?.provider ?? provider];
  let source = 'Built on this computer';
  if (text) source = `AI summary from ${name}${result?.model ? ` (${result.model})` : ''}${s.status === 'running' ? ', as of opening Overview' : ''}`;
  let note = '';
  if (ask && !result) note = `Asking ${name} for a summary…`;
  else if (result?.error) note = `No AI summary: ${result.error} Showing the summary built on this computer.`;

  return (
    <section className="card overview__summary" aria-labelledby={headingId} data-testid="overview-summary" data-source={text ? 'ai' : 'local'}>
      <div className="overview__summary-head">
        <h2 id={headingId}>Summary</h2>
        <span className="muted overview__summary-source" data-testid="overview-summary-source">
          {source}
        </span>
      </div>
      <p className="overview__summary-text" data-testid="overview-summary-text">
        {text ?? local}
      </p>
      {ask ? (
        <p className="muted overview__summary-note" role="status" data-testid="overview-summary-note">
          {note}
        </p>
      ) : null}
    </section>
  );
}
