// A compact segmented control for a tile's view (Activity, Overview, Files, Tools, Timeline).
// RubberSegment is too wide for a quarter-width tile, so tiles use a plain radio group: one tab stop,
// arrow keys / Home / End move and select, the checked option is bold and underlined (not colour only).
// Narrow tiles show short labels; the accessible name is always the full view name.

import { useRef, type KeyboardEvent } from 'react';
import type { RunView } from '@shared/settings';
import { VIEWS } from '../runview/views';

const SHORT: Record<RunView, string> = {
  activity: 'Act',
  overview: 'Over',
  files: 'Files',
  tools: 'Tools',
  timeline: 'Time',
};

export function TileViewSwitcher({ value, onChange, label }: { value: RunView; onChange(v: RunView): void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    VIEWS.findIndex((v) => v.id === value),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % VIEWS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = VIEWS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(VIEWS[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className="mv-seg" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {VIEWS.map((v, i) => {
        const checked = v.id === value;
        return (
          <button
            key={v.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={v.label}
            tabIndex={checked ? 0 : -1}
            className="mv-seg__opt"
            data-value={v.id}
            title={`${v.label} (${v.key} when this tile is focused)`}
            onClick={() => onChange(v.id)}
          >
            <span className="mv-seg__long" aria-hidden="true">
              {v.label}
            </span>
            <span className="mv-seg__short" aria-hidden="true">
              {SHORT[v.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
