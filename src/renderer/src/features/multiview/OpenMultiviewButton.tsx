// "Open multiviewer (n)": shown wherever the run list's selection should lead to the grid (the sidebar
// under the filters is the intended spot). Hidden while nothing is picked or the grid is already open.

import { GridViewIcon } from '@hugeicons/core-free-icons';
import { Icon } from '../../components/Icon';
import { useStore } from '../../store/store';
import { shortcutText } from '../shortcuts/shortcuts';
import { openMultiview } from './layouts';
import './multiview.css';

export function OpenMultiviewButton({ className = '' }: { className?: string }) {
  const count = useStore((s) => s.multi.length);
  const route = useStore((s) => s.route);
  const setMulti = useStore((s) => s.setMulti);
  if (!count || route === 'multiview' || route === 'wizard') return null;
  return (
    <div className={`mv-open ${className}`} role="group" aria-label="Multiviewer selection">
      <button
        type="button"
        className="btn btn--primary mv-open__btn"
        onClick={() => openMultiview()}
        title={`Open the multiviewer (${shortcutText('openMulti')})`}
        data-testid="open-multiview"
      >
        <Icon icon={GridViewIcon} size={15} />
        Open multiviewer ({count})
      </button>
      <button type="button" className="btn btn--ghost" onClick={() => setMulti([])}>
        Clear
      </button>
    </div>
  );
}
