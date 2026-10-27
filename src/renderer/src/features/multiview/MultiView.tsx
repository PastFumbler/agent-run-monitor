// TODO(multiview): the multiviewer (docs/PLAN.md 5.3). This placeholder is routed already
// (route 'multiview', opened with "g then m" or the palette) and reads the selection from the store.
//
// What the real one needs, and where it plugs in:
// - Selection: useStore(s => s.multi) (ids in pick order); m / Ctrl-click / Shift-click fill it.
// - Tiles: reuse the run views unchanged: VIEWS from features/runview/views, each `<View detail compact />`,
//   with a per-tile <ViewSwitcher value onChange /> (features/runview/RunView.tsx).
// - Live data: useWatchRuns('multiview', visibleIds) + useRunDetail(id) per tile.
// - Focus/maximise: store.focusedTile / store.maximizedTile; `f` and Esc are wired in useShortcuts.
// - Grid by count (1, 2, 2x2, 3x2, 3x3, 4x3), pages of settings.gridTileLimit, dnd-kit reordering,
//   IntersectionObserver to pause hidden tiles, low-GPU: unfocused tiles refresh every 3 s.

import { AGENT_NAMES } from '@shared/schema';
import { StatusBadge } from '../../components/StatusBadge';
import { useStore } from '../../store/store';

export function MultiView() {
  const multi = useStore((s) => s.multi);
  const runs = useStore((s) => s.runs);
  const setRoute = useStore((s) => s.setRoute);
  const setMulti = useStore((s) => s.setMulti);
  return (
    <div className="placeholder" data-testid="multiview-placeholder">
      <h1>Multiviewer</h1>
      <p>Coming in the next build: watch several runs side by side.</p>
      {multi.length ? (
        <ul>
          {multi.map((id) =>
            runs[id] ? (
              <li key={id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusBadge status={runs[id].status} short />
                {runs[id].title || 'Untitled run'} <span className="muted">({AGENT_NAMES[runs[id].agent]})</span>
              </li>
            ) : null,
          )}
        </ul>
      ) : (
        <p>Pick runs with m, Ctrl-click or Shift-click in the list.</p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" onClick={() => setRoute('run')}>
          Back to the run
        </button>
        {multi.length ? (
          <button type="button" className="btn" onClick={() => setMulti([])}>
            Clear selection
          </button>
        ) : null}
      </div>
    </div>
  );
}
