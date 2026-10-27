// One multiviewer tile: header (drag handle, title, status mark + word, agent and project, its own
// view switcher, maximise/restore and remove) and the chosen run view in compact mode.
//
// Performance (docs/PLAN.md 5.3): the tile reads its run and detail through useThrottledStore, so it
// re-renders at most once per tile interval (policy rate; 3 s for unfocused tiles in low-GPU mode)
// and not at all while paused (off-screen, behind a maximised tile, window hidden). A paused tile
// carries data-paused, which pauses its CSS animations; behind a maximised tile its body is also
// wrapped in a hidden <Activity>, so React keeps it mounted but stops its effects. The tile's contents
// also get their own motion policy (useTilePolicy): paused tiles look hidden to them, so the live timers
// in call chips stop; unfocused low-GPU tiles refresh those timers every 3 s instead of every second.

import { Activity as ReactActivity, memo, useCallback, useEffect, useId, useMemo, useState, type CSSProperties, type RefCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Cancel01Icon, DragDropVerticalIcon, ArrowExpand01Icon, ArrowShrink01Icon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, STATUS_LABELS, type RunDetail, type RunSummary } from '@shared/schema';
import type { RunView } from '@shared/settings';
import { getBackend } from '../../backend';
import { Icon } from '../../components/Icon';
import { MotionConfig } from 'motion/react';
import { MotionPolicyContext, useMotionPolicy } from '../../motion/context';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { plainStatus } from '../runview/StatusLabel';
import { VIEWS, VIEW_BY_ID } from '../runview/views';
import { pauseReason, tileRate, useThrottledStore, useTilePolicy } from './throttle';
import { TileViewSwitcher } from './TileViewSwitcher';

export interface TileProps {
  id: string;
  /** 1-based position in the whole selection, and its size (for labels). */
  position: number;
  total: number;
  inView: boolean;
  /** Registers the tile element with the grid's IntersectionObserver. */
  observe: RefCallback<HTMLElement>;
  onRemove(id: string): void;
}

/** The run's detail for a tile: throttled, frozen while paused, fetched once if the store has none. */
function useTileDetail(
  id: string,
  exists: boolean,
  intervalMs: number,
  paused: boolean,
  aligned: boolean,
): { detail: RunDetail | null; failed: boolean } {
  const detail = useThrottledStore((s) => s.details[id] ?? null, intervalMs, paused, [id], aligned);
  // Keep showing the last detail while a fresh one loads (e.g. after the watch set changed).
  const [held, setHeld] = useState<RunDetail | null>(detail);
  const [failed, setFailed] = useState(false);
  if (detail && detail !== held) setHeld(detail);
  const shown = detail ?? (held && held.summary.id === id ? held : null);

  const missing = detail === null;
  useEffect(() => {
    if (!exists || paused || !missing) return undefined;
    let alive = true;
    getBackend()
      .getRun(id)
      .then((d) => {
        if (!alive) return;
        if (d) {
          setFailed(false);
          // A live push may have landed meanwhile; keep the newer one.
          const have = useStore.getState().details[id];
          if (!have || have.summary.updatedAt <= d.summary.updatedAt) useStore.getState().setDetail(d);
        } else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id, exists, paused, missing]);

  return { detail: shown, failed };
}

const TileBody = memo(function TileBody({ view, detail }: { view: RunView; detail: RunDetail }) {
  const View = VIEW_BY_ID[view]?.Component ?? VIEWS[0].Component;
  return <View detail={detail} compact />;
});

export const Tile = memo(function Tile({ id, position, total, inView, observe, onRemove }: TileProps) {
  const policy = useMotionPolicy();
  const titleId = useId();
  const focused = useStore((s) => s.focusedTile === id);
  const maximizedId = useStore((s) => s.maximizedTile);
  const view = useStore((s) => s.tileViews[id] ?? s.settings.defaultView);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const exists = useStore((s) => !!s.runs[id]);
  const setTileView = useStore((s) => s.setTileView);
  const setFocusedTile = useStore((s) => s.setFocusedTile);
  const setMaximizedTile = useStore((s) => s.setMaximizedTile);

  const maximized = maximizedId === id;
  const behind = !!maximizedId && !maximized;
  const reason = pauseReason({ windowHidden: policy.hidden, inView, maximizedId, id });
  const paused = reason !== null;
  const rate = tileRate(policy, focused);
  const innerPolicy = useTilePolicy(policy, paused, rate);
  const innerTransition = useMemo(() => ({ duration: innerPolicy.duration / 1000 }), [innerPolicy.duration]);

  // Slow tiles (unfocused, low GPU) refresh on shared 3 s boundaries, timers included (useTilePolicy).
  const run = useThrottledStore((s) => s.runs[id], rate.intervalMs, paused, [id], rate.slow) as RunSummary | undefined;
  const { detail, failed } = useTileDetail(id, exists, rate.intervalMs, paused, rate.slow);
  const merged = useMemo(() => (detail && run ? { ...detail, summary: run } : null), [detail, run]);

  const sortable = useSortable({
    id,
    disabled: !!maximizedId,
    // Reordering slides tiles only when the policy animates; otherwise they jump into place.
    transition: policy.animate ? { duration: policy.duration, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' } : null,
  });
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = sortable;

  const ref = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      if (!el) return undefined;
      const cleanup = observe(el);
      return typeof cleanup === 'function' ? cleanup : undefined;
    },
    [setNodeRef, observe],
  );

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition ?? undefined,
  };

  const title = run ? run.title || 'Untitled run' : runsLoaded ? 'Run no longer available' : 'Loading…';
  const toggleMax = () => setMaximizedTile(maximized ? null : id);
  const missing = runsLoaded && !exists;

  return (
    <section
      ref={ref}
      className="mv-tile"
      style={style}
      aria-labelledby={titleId}
      aria-current={focused ? 'true' : undefined}
      tabIndex={-1}
      hidden={behind}
      data-tile-id={id}
      data-testid="mv-tile"
      data-focused={focused ? '' : undefined}
      data-maximized={maximized ? '' : undefined}
      data-paused={reason ?? undefined}
      data-dragging={isDragging ? '' : undefined}
      data-missing={missing ? '' : undefined}
      data-view={view}
      data-status={run?.status}
      onFocusCapture={() => !focused && setFocusedTile(id)}
      onPointerDown={() => !focused && setFocusedTile(id)}
    >
      <MotionPolicyContext.Provider value={innerPolicy}>
        <MotionConfig reducedMotion={innerPolicy.animate ? 'never' : 'always'} transition={innerTransition}>
          <header
            className="mv-tile__head"
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              toggleMax();
            }}
            title={maximized ? undefined : 'Double-click to maximise'}
          >
            <div className="mv-tile__row">
              <button
                type="button"
                ref={setActivatorNodeRef}
                className="btn btn--icon btn--ghost mv-tile__handle"
                {...attributes}
                {...listeners}
                aria-label={`Move tile: ${title}. Position ${position} of ${total}`}
                title={maximizedId ? 'Restore the grid to reorder tiles' : 'Drag, or press Space then arrow keys, to move this tile'}
              >
                <Icon icon={DragDropVerticalIcon} size={15} />
              </button>
              <h2 id={titleId} className="mv-tile__title" data-untitled={run && !run.title ? '' : undefined} data-testid="mv-tile-title">
                {title}
              </h2>
              <button
                type="button"
                className="btn btn--icon btn--ghost"
                aria-label={maximized ? `Restore grid` : `Maximise ${title}`}
                aria-pressed={maximized}
                title={maximized ? 'Restore (Esc, f or double-click the header)' : 'Maximise (f or double-click the header)'}
                onClick={toggleMax}
                data-testid="mv-tile-maximize"
              >
                <Icon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} size={15} />
              </button>
              <button
                type="button"
                className="btn btn--icon btn--ghost"
                aria-label={`Remove ${title} from the multiviewer`}
                title="Remove from the multiviewer"
                onClick={() => onRemove(id)}
                data-testid="mv-tile-remove"
              >
                <Icon icon={Cancel01Icon} size={15} />
              </button>
            </div>
            {run ? (
              <div className="mv-tile__row mv-tile__row--wrap">
                <span className="mv-tile__status">
                  <StatusMark status={run.status} size={14} decorative />
                  <span className="status-text" data-status={run.status} data-testid="mv-tile-status">
                    {run.status === 'stuck' || run.status === 'waiting' ? plainStatus(run.status, run.statusDetail, run.statusInferred) : STATUS_LABELS[run.status]}
                  </span>
                </span>
                <span className="mv-tile__meta">
                  {AGENT_NAMES[run.agent]} · {run.projectName}
                </span>
                {rate.slow && !paused ? (
                  <span className="mv-badge" data-testid="mv-slow-badge" title="Low-GPU mode: only the focused tile updates live">
                    updates every 3 s
                  </span>
                ) : null}
                {reason === 'offscreen' ? <span className="mv-badge">paused</span> : null}
                <span className="mv-tile__views">
                  <TileViewSwitcher value={view} onChange={(v) => setTileView(id, v)} label={`View for ${title}`} />
                </span>
              </div>
            ) : null}
          </header>
          <div className="mv-tile__body">
            <ReactActivity mode={behind ? 'hidden' : 'visible'}>
              {missing ? (
                <div className="mv-tile__note" data-testid="mv-tile-missing">
                  <p>
                    <b>Run no longer available.</b> Its file was removed or fell out of the history window. Remove the tile, or keep
                    it: it fills in again if the run comes back.
                  </p>
                  <p className="muted cell-mono">{id}</p>
                </div>
              ) : merged ? (
                <TileBody view={view} detail={merged} />
              ) : failed ? (
                <p className="mv-tile__note">Couldn't load this run's details.</p>
              ) : (
                <p className="mv-tile__note">Loading…</p>
              )}
            </ReactActivity>
          </div>
        </MotionConfig>
      </MotionPolicyContext.Provider>
    </section>
  );
});
