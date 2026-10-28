// Timeline: tool calls as bars on lanes by kind, and turns as markers, over the run's duration.
// Plain positioned divs: no canvas, no animation, cheap for hundreds of calls.
// Zoom: the lanes get wider (zoom × the visible width) inside a horizontal scroller, so panning is
// native scrolling (scrollbar, trackpad, Shift+wheel, arrow keys) plus mouse drag. Zoom changes are
// instant (nothing animates). The moment under the pointer (Ctrl+wheel) or the centre (buttons,
// + / - keys) stays put; on a live run scrolled to the end, the view keeps following "now".

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ZoomInIcon, ZoomOutIcon } from '@hugeicons/core-free-icons';
import type { ToolKind } from '@shared/schema';
import { formatDuration, formatTime } from '../../../lib/time';
import { useNow } from '../../../store/clock';
import { useStore } from '../../../store/store';
import { Icon } from '../../../components/Icon';
import { isTyping } from '../../shortcuts/useShortcuts';
import { shortcutText } from '../../shortcuts/shortcuts';
import type { RunViewProps } from './ActivityView';
import { TOOL_KIND_LABELS } from './ToolsView';
import { clampZoom, maxZoom, MIN_TICK_GAP_24H_PX, MIN_TICK_GAP_PX, scrollFor, tickLabel, tickStep, ticks as tickTimes, timeAt, wheelZoom, ZOOM_STEP, zoomLabel } from './timelineZoom';

const MAX_BARS = 800;
/** Lane label column (label + gap) in px; the CSS reads it through --tl-label. */
const LABEL_W = 110;

/** Where to keep the view after the next layout: a moment at an offset into the track, or the live end. */
type Anchor = { t: number; offset: number } | { follow: true };

/** Zoom keys: + (or =) in, - out, 0 fits the whole run. Returns the new zoom request, or null. */
function zoomKey(e: KeyboardEvent | ReactKeyboardEvent): 'in' | 'out' | 'fit' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === '+' || e.key === '=') return 'in';
  if (e.key === '-') return 'out';
  if (e.key === '0') return 'fit';
  return null;
}

export function TimelineView({ detail, compact }: RunViewProps) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const s = detail.summary;
  const live = s.status === 'running' || s.status === 'waiting' || s.status === 'stuck';
  const start = Math.min(s.startedAt, ...detail.events.filter((e) => e.ts).map((e) => e.ts as number));
  // The live end follows the app clock (not Date.now() per render), so the span, and with it the
  // zoomed scroll position, only moves when the run updates or the clock ticks.
  const end = Math.max(live ? Math.max(s.updatedAt, now) : s.updatedAt, start + 1000);
  const span = end - start;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / span) * 100))}%`;
  const clock = timeFormat === 'relative' ? '24h' : timeFormat;

  // Zoom belongs to the run being shown: another run starts fitted.
  const [zoomState, setZoomState] = useState({ id: s.id, zoom: 1 });
  const zoom = zoomState.id === s.id ? clampZoom(zoomState.zoom, span) : 1;
  const zoomMax = maxZoom(span);
  const zoomed = zoom > 1;

  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const [port, setPort] = useState({ left: 0, width: 0 });
  // Latest values for the native listeners (wheel, scroll, resize, window keys).
  const geo = useRef({ start, span, zoom, live, id: s.id });
  geo.current = { start, span, zoom, live, id: s.id };
  const target = useRef(zoom); // the zoom asked for, which may be ahead of the one on screen
  /** The scrollLeft we last set ourselves, so onScroll can tell our scrolls from the user's. */
  const programmatic = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPort((p) => {
      const next = { left: el.scrollLeft, width: Math.max(0, el.clientWidth - LABEL_W) };
      return p.left === next.left && p.width === next.width ? p : next;
    });
  }, []);

  /** Re-applies the anchor (after a zoom, a resize or a live run growing). */
  const applyAnchor = useCallback(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    const { start: st, span: sp, zoom: z } = geo.current;
    const vw = el.clientWidth - LABEL_W;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const left = 'follow' in a ? max : Math.min(max, Math.max(0, scrollFor(a.t, a.offset, st, sp, vw * z)));
    if (Math.abs(el.scrollLeft - left) >= 1) {
      el.scrollLeft = left;
      programmatic.current = el.scrollLeft;
    }
  }, []);

  useLayoutEffect(() => {
    target.current = zoom;
    applyAnchor();
    measure();
  }, [zoom, start, span, applyAnchor, measure]);

  /** Zoom to `next`, keeping the moment at `offset` px into the visible track still (default: the centre). */
  const zoomTo = useCallback((next: number, offset?: number) => {
    const el = scrollRef.current;
    const { start: st, span: sp, zoom: shown, id } = geo.current;
    const z = clampZoom(next, sp);
    if (z === target.current) return;
    if (el) {
      const vw = el.clientWidth - LABEL_W;
      const off = Math.min(Math.max(offset ?? vw / 2, 0), Math.max(vw, 0));
      // The DOM still shows `shown`, so read the moment under the pointer from that layout.
      anchor.current = z <= 1 ? { t: st, offset: 0 } : { t: timeAt(el.scrollLeft, off, st, sp, vw * shown), offset: off };
    }
    target.current = z;
    setZoomState({ id, zoom: z });
  }, []);

  const runZoomKey = useCallback(
    (k: 'in' | 'out' | 'fit') => zoomTo(k === 'fit' ? 1 : k === 'in' ? target.current * ZOOM_STEP : target.current / ZOOM_STEP),
    [zoomTo],
  );

  // Scrolling (user or ours): remember the left edge, or "follow the live end" when scrolled to it.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ours = programmatic.current !== null && Math.abs(el.scrollLeft - programmatic.current) < 1;
    programmatic.current = null;
    if (!ours) {
      const { start: st, span: sp, zoom: z, live: lv } = geo.current;
      const vw = el.clientWidth - LABEL_W;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      anchor.current = lv && z > 1 && atEnd ? { follow: true } : { t: timeAt(el.scrollLeft, 0, st, sp, vw * z), offset: 0 };
    }
    measure();
  }, [measure]);

  // Ctrl/Cmd + wheel zooms at the pointer (a non-passive listener, so the page itself doesn't zoom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left - LABEL_W;
      zoomTo(wheelZoom(target.current, e.deltaY, e.deltaMode), x);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      applyAnchor();
      measure();
    });
    ro?.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
    };
  }, [zoomTo, applyAnchor, measure, detail.events.length > 0]);

  // In the run view (not a multiviewer tile) + / - / 0 work without focusing the timeline first.
  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.defaultPrevented || st.route !== 'run' || st.overlay !== 'none' || isTyping(e.target)) return;
      const k = zoomKey(e);
      if (!k) return;
      e.preventDefault();
      runZoomKey(k);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, runZoomKey]);

  // Drag to pan when zoomed in (mouse and pen; touch scrolls natively).
  const drag = useRef<{ x: number; left: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || !zoomed || e.button !== 0 || e.pointerType === 'touch') return;
    // Leave the native scrollbar alone (Chromium sends pointerdown for it too).
    if (e.clientY - el.getBoundingClientRect().top >= el.clientHeight) return;
    drag.current = { x: e.clientX, left: el.scrollLeft, id: e.pointerId };
    el.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    const d = drag.current;
    if (!el || !d || d.id !== e.pointerId) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    scrollRef.current?.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

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

  // Axis ticks for the visible window only, at a round step that keeps the labels apart.
  const vw = port.width || 600;
  const track = vw * zoom;
  const from = timeAt(zoomed ? port.left : 0, 0, start, span, track);
  const to = timeAt(zoomed ? port.left : 0, vw, start, span, track);
  const step = tickStep(to - from, vw, clock === '12h' ? MIN_TICK_GAP_PX : MIN_TICK_GAP_24H_PX);
  const axisTicks = tickTimes(Math.max(start, from - step), Math.min(end, to + step), step);

  const zoomText = zoomed ? `Zoom ${zoomLabel(zoom)}` : 'Whole run';

  return (
    <div
      className="timeline"
      data-testid="view-timeline"
      style={{ '--tl-label': `${LABEL_W}px` } as CSSProperties}
      onKeyDown={(e) => {
        if (e.defaultPrevented || isTyping(e.target)) return;
        const k = zoomKey(e);
        if (!k) return;
        e.preventDefault();
        runZoomKey(k);
      }}
    >
      <div className="timeline__controls" role="group" aria-label="Timeline zoom">
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Zoom out"
          title="Zoom out (-)"
          aria-disabled={!zoomed}
          data-testid="timeline-zoom-out"
          onClick={() => zoomed && runZoomKey('out')}
        >
          <Icon icon={ZoomOutIcon} />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Zoom in"
          title="Zoom in (+)"
          aria-disabled={zoom >= zoomMax}
          data-testid="timeline-zoom-in"
          onClick={() => zoom < zoomMax && runZoomKey('in')}
        >
          <Icon icon={ZoomInIcon} />
        </button>
        <button
          type="button"
          className="btn"
          title="Fit to run (0)"
          aria-disabled={!zoomed}
          data-testid="timeline-fit"
          onClick={() => zoomed && runZoomKey('fit')}
        >
          Fit to run
        </button>
        <span className="muted timeline__zoom" aria-live="polite" data-testid="timeline-zoom">
          {zoomText}
        </span>
        <span className="muted timeline__hint">{zoomed ? 'Drag or scroll sideways to pan' : `${shortcutText('timelineWheel')} to zoom at the pointer`}</span>
      </div>
      <div className="timeline__axis" aria-hidden="true">
        <span>{formatTime(start, clock, now)}</span>
        <span>{zoomed ? `Showing ${formatDuration(to - from)} of ${formatDuration(span)}` : formatDuration(span)}</span>
        <span>{live ? 'now' : formatTime(end, clock, now)}</span>
      </div>
      <div
        ref={scrollRef}
        className="timeline__scroll"
        role="region"
        aria-label={zoomed ? `Timeline chart, ${zoomText.toLowerCase()}: scroll sideways to pan` : 'Timeline chart'}
        tabIndex={0}
        data-testid="timeline-scroll"
        data-zoomed={zoomed ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="timeline__lanes" style={{ width: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${zoom})` }}>
          <div className="timeline__lane timeline__ticks" aria-hidden="true" data-testid="timeline-ticks">
            <span className="timeline__label" />
            <div className="timeline__track">
              {axisTicks.map((t) => (
                <span key={t} className="timeline__tick" style={{ left: pct(t) }}>
                  {tickLabel(t, step, clock)}
                </span>
              ))}
            </div>
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
                        style={{ left: pct(st), width: `max(3px, ${(dur / span) * 100}%)` }}
                        title={`${t.toolName}: ${t.input.slice(0, 80)} (${t.open ? 'open' : formatDuration(dur)}${t.isError ? ', failed' : ''})`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
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
