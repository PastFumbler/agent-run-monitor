// Reasoning: the run's readable reasoning, oldest first, in full (long entries collapse behind
// "Show more"). Only offered for runs whose source stored readable reasoning (see available.ts).
// Thinking stored without its text (placeholder events) is left out and counted in a note. The text
// is event text, so main has already masked it.

import { useCallback, useMemo, useState } from 'react';
import { useNow } from '../../../store/clock';
import { useStore } from '../../../store/store';
import { formatTime } from '../../../lib/time';
import ThoughtLine from '../../../vendor/react-bits/ThoughtLine/ThoughtLine';
import { buildEventItems } from '../eventItems';
import { CollapsibleText, type RunViewProps } from './ActivityView';

export function ReasoningView({ detail, compact }: RunViewProps) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const status = detail.summary.status;
  const runId = detail.summary.id;
  const { items, hidden } = useMemo(() => {
    const all = buildEventItems(detail.events, status).filter((i) => i.event.kind === 'reasoning');
    // Same rule as main's hasReasoning: a placeholder or blank text is not readable reasoning.
    const readable = all.filter((i) => !i.event.placeholder && i.event.text.trim() !== '');
    return { items: readable, hidden: all.length - readable.length };
  }, [detail.events, status]);
  // Keyed by run too: the run view reuses this component across runs.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );

  const windowed = detail.totalEvents > detail.events.length;

  return (
    <div className="reasoning" data-testid="view-reasoning">
      {windowed ? (
        <p className="changes__note muted" data-testid="reasoning-window">
          Showing reasoning from the newest {detail.events.length.toLocaleString()} of {detail.totalEvents.toLocaleString()} events.
        </p>
      ) : null}
      {hidden > 0 ? (
        <p className="changes__note muted" data-testid="reasoning-hidden">
          {hidden.toLocaleString()} thinking {hidden === 1 ? 'step was' : 'steps were'} stored without {hidden === 1 ? 'its' : 'their'} text and{' '}
          {hidden === 1 ? 'is' : 'are'} left out.
        </p>
      ) : null}
      {items.length ? (
        <ol className="reasoning__list" aria-label="Reasoning, oldest first">
          {items.map((item) => {
            const e = item.event;
            const key = `${runId}\n${item.key}`;
            return (
              <li key={key} className="reasoning__item">
                <div className="ev__head">
                  <ThoughtLine label="Thinking…" doneLabel="Reasoning" working={item.working} fontSize={compact ? 13 : 14} />
                  {e.ts ? <span className="ev__time">{formatTime(e.ts, timeFormat === 'relative' ? '24h' : timeFormat, now)}</span> : null}
                </div>
                <CollapsibleText text={e.text} expanded={expanded.has(key)} onToggle={() => toggle(key)} />
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty-note">No readable reasoning in the events loaded for this run.</p>
      )}
    </div>
  );
}
