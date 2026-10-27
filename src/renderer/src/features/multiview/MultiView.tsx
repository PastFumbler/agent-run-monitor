// The multiviewer (docs/PLAN.md 5.3): the picked runs (store.multi, in order) as a grid of tiles.
//
// - Grid by tile count (grid.ts): 1, 2x1, 2x2, 3x2, 3x3, 4x3; pages of min(12, gridTileLimit) with
//   page buttons and PageUp / PageDown. data-grid="CxR" and data-tile-count are on the grid.
// - Tiles reorder with dnd-kit (pointer, or Space + arrow keys on the drag handle, announced).
// - f / double-click / the tile button maximise the focused tile; the others stay mounted, hidden and
//   paused; Esc restores (useShortcuts). 1-5 switch the focused tile's view; ← / → move between tiles.
// - Only the tiles that can be seen are watched (backend.watchRuns): this page, minus tiles behind a
//   maximised one and tiles scrolled out of view (one IntersectionObserver on the grid). In low-GPU mode
//   main also pushes detail for the unfocused tiles at most every 3 s (backend.setWatchPriority).
// - Selections can be saved as named layouts and reopened (settings.layouts).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefCallback, type RefObject } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Add01Icon, ArrowLeft01Icon, ArrowRight01Icon, FloppyDiskIcon, Layout01Icon } from '@hugeicons/core-free-icons';
import { RUN_VIEWS } from '@shared/settings';
import { getBackend } from '../../backend';
import { Icon } from '../../components/Icon';
import { useMotionPolicy } from '../../motion/context';
import { useStore } from '../../store/store';
import { useWatchRuns } from '../runview/useRunDetail';
import { LayoutList, LayoutsDialog, RunPicker, SaveLayoutDialog } from './dialogs';
import { gridFor, gridLabel, paginate } from './grid';
import { LOW_GPU_UNFOCUSED_MS } from './throttle';
import { Tile } from './Tile';
import './multiview.css';

type Dialog = 'none' | 'picker' | 'save' | 'layouts';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

const tileTitle = (id: string | number) => {
  const r = useStore.getState().runs[String(id)];
  return r ? r.title || 'Untitled run' : 'Unavailable run';
};
const position = (id: string | number) => useStore.getState().multi.indexOf(String(id)) + 1;
const total = () => useStore.getState().multi.length;

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) =>
    `Picked up tile ${tileTitle(active.id)}, position ${position(active.id)} of ${total()}. Use the arrow keys to move it, Space to drop it, Escape to cancel.`,
  onDragOver: ({ active, over }) =>
    over ? `Tile ${tileTitle(active.id)} is over position ${position(over.id)} of ${total()}.` : `Tile ${tileTitle(active.id)} is not over a position.`,
  onDragEnd: ({ active, over }) =>
    over ? `Tile ${tileTitle(active.id)} dropped at position ${position(active.id)} of ${total()}.` : `Tile ${tileTitle(active.id)} dropped.`,
  onDragCancel: ({ active }) => `Moving cancelled. Tile ${tileTitle(active.id)} stays at position ${position(active.id)}.`,
};

const INSTRUCTIONS = {
  draggable:
    'To move this tile, press Space or Enter, then use the arrow keys. Press Space or Enter again to drop it, or Escape to cancel.',
};

/** Off-screen tiles, from one IntersectionObserver rooted at the grid (no observer: all in view). */
function useOffscreenTiles(gridRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [offscreen, setOffscreen] = useState<ReadonlySet<string>>(() => new Set());
  const ioRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const root = gridRef.current;
    if (!enabled || typeof IntersectionObserver === 'undefined' || !root) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        setOffscreen((prev) => {
          let next: Set<string> | null = null;
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.tileId;
            if (!id) continue;
            const out = !e.isIntersecting;
            if (out !== prev.has(id)) {
              next ??= new Set(prev);
              if (out) next.add(id);
              else next.delete(id);
            }
          }
          return next ?? prev;
        });
      },
      { root, threshold: 0 },
    );
    ioRef.current = io;
    root.querySelectorAll<HTMLElement>('[data-tile-id]').forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      ioRef.current = null;
      setOffscreen(new Set());
    };
  }, [gridRef, enabled]);

  const observe = useCallback<RefCallback<HTMLElement>>((el) => {
    const io = ioRef.current;
    if (!el || !io) return undefined;
    io.observe(el);
    return () => io.unobserve(el);
  }, []);

  return { offscreen, observe };
}

export function MultiView() {
  const policy = useMotionPolicy();
  const multi = useStore((s) => s.multi);
  const page = useStore((s) => s.multiPage);
  const limit = useStore((s) => s.settings.gridTileLimit);
  const layouts = useStore((s) => s.settings.layouts);
  const maximized = useStore((s) => s.maximizedTile);
  const focusedTile = useStore((s) => s.focusedTile);
  const setMultiPage = useStore((s) => s.setMultiPage);
  const setFocusedTile = useStore((s) => s.setFocusedTile);
  const setMaximizedTile = useStore((s) => s.setMaximizedTile);
  const toggleMulti = useStore((s) => s.toggleMulti);
  const setMulti = useStore((s) => s.setMulti);
  const moveMulti = useStore((s) => s.moveMulti);
  const setRoute = useStore((s) => s.setRoute);
  const [dialog, setDialog] = useState<Dialog>('none');
  const gridRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const count = multi.length;
  const { offscreen, observe } = useOffscreenTiles(gridRef, count > 0);

  const pg = paginate(multi, limit, page);
  const items = pg.items;
  const itemsKey = items.join('|');
  const grid = gridFor(items.length);

  // Keep page, focus and maximise consistent with the selection.
  useEffect(() => {
    if (pg.page !== page) setMultiPage(pg.page);
  }, [pg.page, page, setMultiPage]);
  useEffect(() => {
    if (!focusedTile || !items.includes(focusedTile)) setFocusedTile(items[0] ?? null);
    if (maximized && !items.includes(maximized)) setMaximizedTile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, focusedTile, maximized]);

  // Live detail only for tiles that can be seen.
  const watched = useMemo(
    () => items.filter((id) => (!maximized || id === maximized) && !offscreen.has(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemsKey, maximized, offscreen],
  );
  useWatchRuns('multiview', watched);

  // Low-GPU mode: the unfocused tiles only render every 3 s, so main need not push their detail more
  // often either. Cleared when low-GPU mode ends and when the multiviewer closes.
  const lowGpu = policy.lowGpu;
  useEffect(() => {
    const focus = lowGpu ? [...new Set([focusedTile, maximized].filter((x): x is string => !!x))] : [];
    getBackend().setWatchPriority?.(focus, lowGpu ? LOW_GPU_UNFOCUSED_MS : 0);
  }, [lowGpu, focusedTile, maximized]);
  useEffect(() => () => getBackend().setWatchPriority?.([], 0), []);

  const goPage = useCallback((p: number) => {
    const st = useStore.getState();
    const next = paginate(st.multi, st.settings.gridTileLimit, p);
    if (next.page === st.multiPage) return;
    st.setMaximizedTile(null);
    st.setMultiPage(next.page);
    st.setFocusedTile(next.items[0] ?? null);
  }, []);

  const remove = useCallback(
    (id: string) => {
      const st = useStore.getState();
      if (st.maximizedTile === id) st.setMaximizedTile(null);
      // Keyboard focus was on the removed tile's button: hand it to the next tile (or the previous one,
      // or the empty state's "Add runs") instead of dropping it on the page.
      const page = paginate(st.multi, st.settings.gridTileLimit, st.multiPage).items;
      const i = page.indexOf(id);
      const nextId = page[i + 1] ?? page[i - 1] ?? null;
      const hadFocus = !!gridRef.current?.querySelector(`[data-tile-id="${CSS.escape(id)}"]`)?.contains(document.activeElement);
      toggleMulti(id);
      if (nextId) useStore.getState().setFocusedTile(nextId);
      if (hadFocus) {
        requestAnimationFrame(() => {
          const target = nextId
            ? gridRef.current?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(nextId)}"]`)
            : document.querySelector<HTMLElement>('[data-testid="mv-empty"] .btn--primary');
          target?.focus();
        });
      }
    },
    [toggleMulti],
  );

  // Keys that belong to the grid. Capture phase, so ← / → move between tiles instead of leaving the
  // multiviewer for the previous/next run; PageUp/PageDown page; 1-5 switch the focused tile's view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.route !== 'multiview' || st.overlay !== 'none' || draggingRef.current) return;
      if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      const ids = paginate(st.multi, st.settings.gridTileLimit, st.multiPage).items;
      const key = e.key;
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === '[' || key === ']') {
        // Controls that use arrows themselves (a tile's view switcher) keep them.
        if (target?.closest?.('[role="radiogroup"]')) return;
        e.stopPropagation();
        if (st.maximizedTile || !ids.length) return;
        const i = st.focusedTile ? ids.indexOf(st.focusedTile) : -1;
        const j = key === 'ArrowLeft' || key === '[' ? Math.max(0, i - 1) : Math.min(ids.length - 1, i + 1);
        if (ids[j] && ids[j] !== st.focusedTile) {
          st.setFocusedTile(ids[j]);
          gridRef.current?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(ids[j])}"]`)?.focus();
        }
        return;
      }
      if (key === 'PageDown' || key === 'PageUp') {
        // Inside a tile's scrolling content these keys scroll it.
        if (target?.closest?.('.mv-tile__body')) return;
        e.preventDefault();
        e.stopPropagation();
        goPage(st.multiPage + (key === 'PageDown' ? 1 : -1));
        return;
      }
      if (/^[1-5]$/.test(key) && st.focusedTile && ids.includes(st.focusedTile)) {
        e.preventDefault();
        e.stopPropagation();
        st.setTileView(st.focusedTile, RUN_VIEWS[Number(key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [goPage]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Under reduced motion or low GPU the grid jumps instead of smooth-scrolling while a tile is moved.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, scrollBehavior: policy.animate && !policy.lowGpu ? 'smooth' : 'auto' }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    draggingRef.current = false;
    if (!over || active.id === over.id) return;
    const st = useStore.getState();
    const to = st.multi.indexOf(String(over.id));
    if (to >= 0) moveMulti(String(active.id), to);
    st.setFocusedTile(String(active.id));
  };

  return (
    <div className="multiview" data-testid="multiview">
      <header className="mv-toolbar">
        <h1 className="mv-toolbar__title">
          Multiviewer
          <span className="muted mv-toolbar__count" data-testid="mv-count">
            {count} run{count === 1 ? '' : 's'}
          </span>
        </h1>
        {pg.pageCount > 1 ? (
          <nav className="mv-pager" aria-label="Multiviewer pages">
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Previous page"
              title="Previous page (Page Up)"
              disabled={pg.page === 0}
              onClick={() => goPage(pg.page - 1)}
            >
              <Icon icon={ArrowLeft01Icon} />
            </button>
            <span className="mv-pager__label" aria-live="polite" data-testid="mv-page-label">
              Page {pg.page + 1} of {pg.pageCount}
            </span>
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Next page"
              title="Next page (Page Down)"
              disabled={pg.page >= pg.pageCount - 1}
              onClick={() => goPage(pg.page + 1)}
            >
              <Icon icon={ArrowRight01Icon} />
            </button>
          </nav>
        ) : null}
        <span className="mv-toolbar__spacer" />
        <button type="button" className="btn" onClick={() => setDialog('picker')}>
          <Icon icon={Add01Icon} size={15} />
          Add runs
        </button>
        <button type="button" className="btn" disabled={!count} onClick={() => setDialog('save')}>
          <Icon icon={FloppyDiskIcon} size={15} />
          Save layout
        </button>
        <button type="button" className="btn" onClick={() => setDialog('layouts')}>
          <Icon icon={Layout01Icon} size={15} />
          Layouts{layouts.length ? ` (${layouts.length})` : ''}
        </button>
        <button type="button" className="btn btn--ghost" disabled={!count} onClick={() => setMulti([])}>
          Clear
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setRoute('run')}>
          Back to run
        </button>
      </header>

      {count ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: INSTRUCTIONS }}
          autoScroll={policy.animate}
          onDragStart={() => {
            draggingRef.current = true;
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            draggingRef.current = false;
          }}
        >
          <SortableContext items={items} strategy={rectSortingStrategy}>
            <div
              ref={gridRef}
              className="mv-grid"
              data-testid="mv-grid"
              data-grid={gridLabel(grid)}
              data-tile-count={items.length}
              data-maximized={maximized ? '' : undefined}
              style={{ '--mv-cols': grid.cols, '--mv-rows': grid.rows } as CSSProperties}
              role="group"
              aria-label={`${items.length} tile${items.length === 1 ? '' : 's'}${pg.pageCount > 1 ? `, page ${pg.page + 1} of ${pg.pageCount}` : ''}`}
            >
              {items.map((id, i) => (
                <Tile key={id} id={id} position={pg.offset + i + 1} total={count} inView={!offscreen.has(id)} observe={observe} onRemove={remove} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="mv-empty" data-testid="mv-empty">
          <h2>Watch several runs side by side</h2>
          <p className="muted">
            Pick runs in the list with <kbd className="kbd">m</kbd>, Ctrl-click or Shift-click, or add them here. Up to 12 tiles fit
            on a page; more runs go on further pages.
          </p>
          <p>
            <button type="button" className="btn btn--primary" onClick={() => setDialog('picker')}>
              <Icon icon={Add01Icon} size={15} />
              Add runs
            </button>
          </p>
          <section aria-labelledby="mv-empty-layouts" className="mv-empty__layouts">
            <h3 id="mv-empty-layouts">Saved layouts</h3>
            <LayoutList layouts={layouts} />
          </section>
        </div>
      )}

      {dialog === 'picker' ? <RunPicker onClose={() => setDialog('none')} /> : null}
      {dialog === 'save' ? <SaveLayoutDialog onClose={() => setDialog('none')} /> : null}
      {dialog === 'layouts' ? <LayoutsDialog onClose={() => setDialog('none')} /> : null}
    </div>
  );
}
