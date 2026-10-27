// Timeline: tool calls as bars on lanes by kind, and turns as markers, over the run's duration.
// Plain positioned divs: no canvas, no animation, cheap for hundreds of calls.

import { useMemo } from 'react';
import type { ToolKind } from '@shared/schema';
import { formatDuration, formatTime } from '../../../lib/time';
import { nowMs } from '../../../backend/clock';
import { useNow } from '../../../store/clock';
import { useStore } from '../../../store/store';
import type { RunViewProps } from './ActivityView';
import { TOOL_KIND_LABELS } from './ToolsView';

const MAX_BARS = 800;

export function TimelineView({ detail }: RunViewProps) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const s = detail.summary;
  const live = s.status === 'running' || s.status === 'waiting' || s.status === 'stuck';
  const start = Math.min(s.startedAt, ...detail.events.filter((e) => e.ts).map((e) => e.ts as number));
  const end = Math.max(live ? Math.max(s.updatedAt, nowMs()) : s.updatedAt, start + 1000);
  const span = end - start;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / span) * 100)).toFixed(3)}%`;

  const lanes = useMemo(() => {
    const m = new Map<ToolKind, typeof detail.tools>();
    for (const t of detail.tools.slice(-MAX_BARS)) {
      if (t.startedAt === undefined) continue;
      const list = m.get(t.toolKind) ?? [];
      list.push(t);
      m.set(t.toolKind, list);
    }
    return [...m.entries()];
  }, [detail.tools]);

  const turns = detail.events.filter((e) => e.ts && (e.kind === 'user' || e.kind === 'error'));

  if (!detail.events.length) {
    return (
      <div className="timeline" data-testid="view-timeline">
        <p className="empty-note">Nothing to draw: this run has no timed events.</p>
      </div>
    );
  }

  return (
    <div className="timeline" data-testid="view-timeline">
      <div className="timeline__axis" aria-hidden="true">
        <span>{formatTime(start, timeFormat === 'relative' ? '24h' : timeFormat, now)}</span>
        <span>{formatDuration(span)}</span>
        <span>{live ? 'now' : formatTime(end, timeFormat === 'relative' ? '24h' : timeFormat, now)}</span>
      </div>
      <div role="list" aria-label="Timeline lanes">
        <div className="timeline__lane" role="listitem">
          <span className="timeline__label">Turns</span>
          <div className="timeline__track" role="img" aria-label={`${turns.length} prompts and errors`}>
            {turns.map((e) => (
              <span
                key={e.seq}
                className="timeline__marker"
                data-kind={e.kind}
                style={{ left: pct(e.ts as number) }}
                title={`${e.kind === 'user' ? 'Prompt' : 'Error'} at ${formatTime(e.ts as number, '24h', now)}`}
              />
            ))}
          </div>
        </div>
        {lanes.map(([kind, tools]) => (
          <div className="timeline__lane" role="listitem" key={kind}>
            <span className="timeline__label">{TOOL_KIND_LABELS[kind]}</span>
            <div className="timeline__track" role="img" aria-label={`${tools.length} ${TOOL_KIND_LABELS[kind]} calls`}>
              {tools.map((t, i) => {
                const st = t.startedAt as number;
                const dur = t.durationMs ?? (t.open ? end - st : 0);
                return (
                  <span
                    key={t.toolCallId ?? i}
                    className="timeline__bar"
                    data-error={t.isError ? '' : undefined}
                    data-open={t.open ? '' : undefined}
                    style={{ left: pct(st), width: `max(3px, ${((dur / span) * 100).toFixed(3)}%)` }}
                    title={`${t.toolName}: ${t.input.slice(0, 80)} (${t.open ? 'open' : formatDuration(dur)}${t.isError ? ', failed' : ''})`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="timeline__legend">
        <span>
          <span className="swatch" style={{ background: 'var(--status-running)' }} />
          Tool call
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--status-failed)' }} />
          Failed call or error
        </span>
        <span>
          <span className="swatch" style={{ background: 'repeating-linear-gradient(-45deg, var(--status-running) 0 3px, transparent 3px 5px)' }} />
          Still open
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--accent)', width: 3 }} />
          Prompt
        </span>
      </div>
    </div>
  );
}
