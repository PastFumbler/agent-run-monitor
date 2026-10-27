// Activity: the event stream, newest at the bottom, virtualised (runs can have thousands of
// events). Follows new events while you are at the bottom; otherwise a "Jump to latest" button
// appears. Rows have an icon and a text label per kind; reasoning uses ThoughtLine and tool calls
// use CallChip; long text is collapsed with a "Show more" toggle.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Alert02Icon,
  ArrowDownDoubleIcon,
  BubbleChatIcon,
  FileEditIcon,
  InformationCircleIcon,
  SparklesIcon,
  UserIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import { AGENT_NAMES, type RunDetail, type RunEvent } from '@shared/schema';
import { Icon } from '../../../components/Icon';
import { useStore } from '../../../store/store';
import { formatTime } from '../../../lib/time';
import { useNow } from '../../../store/clock';
import CallChip from '../../../vendor/react-bits/CallChip/CallChip';
import ThoughtLine from '../../../vendor/react-bits/ThoughtLine/ThoughtLine';
import { buildEventItems, KIND_LABELS, reasoningSteps, type EventItem } from '../eventItems';

export interface RunViewProps {
  detail: RunDetail;
  compact?: boolean;
}

const ICONS: Record<RunEvent['kind'], IconSvgElement> = {
  user: UserIcon,
  assistant: BubbleChatIcon,
  reasoning: SparklesIcon,
  tool_call: Wrench01Icon,
  tool_result: Wrench01Icon,
  file_change: FileEditIcon,
  error: Alert02Icon,
  system: InformationCircleIcon,
};

const LONG_CHARS = 320;
const LONG_LINES = 4;
const isLong = (t: string) => t.length > LONG_CHARS || t.split('\n').length > LONG_LINES;
const BOTTOM_SLACK = 48;

function CollapsibleText({ text, expanded, onToggle, mono }: { text: string; expanded: boolean; onToggle(): void; mono?: boolean }) {
  const long = isLong(text);
  return (
    <>
      <p className={`ev__text${mono ? ' mono' : ''}`} data-clamped={long && !expanded ? '' : undefined}>
        {text}
      </p>
      {long ? (
        <button type="button" className="ev__more" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

const EventRow = memo(function EventRow({
  item,
  agentName,
  expanded,
  onToggle,
  timeText,
  compact,
}: {
  item: EventItem;
  agentName: string;
  expanded: boolean;
  onToggle(key: string): void;
  timeText: string;
  compact?: boolean;
}) {
  const e = item.event;
  const toggle = () => onToggle(item.key);
  let body: React.ReactNode;
  let kindLabel = KIND_LABELS[e.kind];
  switch (e.kind) {
    case 'reasoning':
      body = (
        <ThoughtLine
          label="Thinking…"
          doneLabel="Reasoning"
          steps={reasoningSteps(e.text)}
          working={item.working}
          defaultOpen={item.working || expanded}
          toggleLabel={`Reasoning step ${e.seq + 1}`}
          fontSize={compact ? 13 : 14}
        />
      );
      break;
    case 'tool_call': {
      const r = item.result;
      kindLabel = item.callStatus === 'error' ? 'Tool call · failed' : item.callStatus === 'running' ? 'Tool call · running' : 'Tool call';
      body = (
        <>
          <CallChip
            kind={e.toolKind}
            name={e.toolName ?? 'tool'}
            argument={e.text.split('\n')[0].slice(0, 160)}
            status={item.callStatus}
            since={e.ts}
            durationMs={r?.durationMs}
            compact={compact}
          />
          {r?.text ? (
            <div className="ev__output" data-error={r.isError ? '' : undefined}>
              <CollapsibleText text={r.text} expanded={expanded} onToggle={toggle} mono />
            </div>
          ) : null}
        </>
      );
      break;
    }
    case 'file_change':
      body = (
        <p className="ev__text">
          {e.fileOp === 'create' ? 'Created ' : e.fileOp === 'delete' ? 'Deleted ' : 'Edited '}
          <span className="ev__file">{e.filePath ?? e.text}</span>
        </p>
      );
      break;
    case 'assistant':
      kindLabel = agentName;
      body = <CollapsibleText text={e.text} expanded={expanded} onToggle={toggle} />;
      break;
    case 'tool_result':
      body = (
        <div className="ev__output" data-error={e.isError ? '' : undefined}>
          <CollapsibleText text={e.text} expanded={expanded} onToggle={toggle} mono />
        </div>
      );
      break;
    default:
      body = <CollapsibleText text={e.text} expanded={expanded} onToggle={toggle} />;
  }
  return (
    <div className="ev__row">
      <span className="ev__icon">
        <Icon icon={ICONS[e.kind]} size={16} />
      </span>
      <div className="ev__main" style={{ minWidth: 0 }}>
        <div className="ev__head">
          <span className="ev__kind">{kindLabel}</span>
          {timeText ? <span className="ev__time">{timeText}</span> : null}
        </div>
        <div className="ev__body">{body}</div>
      </div>
    </div>
  );
});

export function ActivityView({ detail, compact }: RunViewProps) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const density = useStore((s) => s.settings.density);
  const now = useNow();
  const status = detail.summary.status;
  const items = useMemo(() => buildEventItems(detail.events, status), [detail.events, status]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const prevCount = useRef(items.length);
  const runId = detail.summary.id;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = items[i]?.event.kind;
      const base = density === 'compact' ? 0.85 : 1;
      return Math.round((k === 'tool_call' ? 74 : k === 'reasoning' ? 64 : k === 'file_change' ? 46 : 70) * base);
    },
    overscan: 8,
    getItemKey: (i) => items[i]?.key ?? i,
  });

  const toggle = useCallback((key: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }, []);

  const scrollToEnd = useCallback(() => {
    if (!items.length) return;
    virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    // Measurements may grow the last rows; settle at the true bottom on the next frame.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    setUnseen(0);
    atBottomRef.current = true;
    setAtBottom(true);
  }, [items.length, virtualizer]);

  // New run: start at the newest event.
  useLayoutEffect(() => {
    setExpanded(new Set());
    prevCount.current = items.length;
    scrollToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // New events: follow when at the bottom, else count them for the button.
  useEffect(() => {
    const added = items.length - prevCount.current;
    prevCount.current = items.length;
    if (added <= 0) return;
    if (atBottomRef.current) scrollToEnd();
    else setUnseen((u) => u + added);
  }, [items.length, scrollToEnd]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      if (bottom) setUnseen(0);
    }
  };

  const agentName = AGENT_NAMES[detail.summary.agent];
  const vitems = virtualizer.getVirtualItems();

  if (!items.length) {
    return (
      <div className="activity">
        <p className="empty-note">No activity recorded for this run.</p>
      </div>
    );
  }

  return (
    <div className="activity" data-testid="view-activity">
      {detail.totalEvents > detail.events.length ? (
        <p className="empty-note" style={{ padding: '6px var(--pad)' }}>
          Showing the newest {detail.events.length.toLocaleString()} of {detail.totalEvents.toLocaleString()} events.
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className="activity__scroller"
        onScroll={onScroll}
        role="log"
        aria-label="Run activity"
        aria-live="off"
        tabIndex={0}
      >
        <div className="activity__inner" style={{ height: virtualizer.getTotalSize() }}>
          {vitems.map((v) => {
            const item = items[v.index];
            return (
              <div
                key={v.key}
                ref={virtualizer.measureElement}
                data-index={v.index}
                className="ev"
                data-kind={item.event.kind}
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <EventRow
                  item={item}
                  agentName={agentName}
                  expanded={expanded.has(item.key)}
                  onToggle={toggle}
                  timeText={item.event.ts ? formatTime(item.event.ts, timeFormat === 'relative' ? '24h' : timeFormat, now) : ''}
                  compact={compact}
                />
              </div>
            );
          })}
        </div>
      </div>
      {!atBottom ? (
        <button type="button" className="btn jump-latest" onClick={scrollToEnd}>
          <Icon icon={ArrowDownDoubleIcon} size={15} />
          Jump to latest{unseen > 0 ? ` (${unseen} new)` : ''}
        </button>
      ) : null}
    </div>
  );
}
