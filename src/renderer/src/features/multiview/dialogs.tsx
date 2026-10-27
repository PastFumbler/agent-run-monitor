// The multiviewer's small dialogs: the run picker (add/remove runs with the palette's search), "Save
// layout" (name prompt) and the saved layouts list (open / delete).

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { Add01Icon, Delete02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, type RunSummary } from '@shared/schema';
import type { SavedLayout } from '@shared/settings';
import { nowMs } from '../../backend/clock';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { SHORT_LABELS } from '../../components/StatusBadge';
import { relativeTime } from '../../lib/time';
import { useNow } from '../../store/clock';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { searchRuns } from '../palette/search';
import { cleanLayoutName, deleteLayout, LAYOUT_NAME_MAX, openLayout, saveLayout } from './layouts';

const MAX_RESULTS = 50;

/** Keeps the app's single-key shortcuts (f, m, PageDown…) from firing behind a dialog. */
function KeyFence({ children }: { children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
  };
  return (
    <div onKeyDown={onKeyDown} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

export function RunPicker({ onClose }: { onClose(): void }) {
  const runs = useStore((s) => s.runs);
  const multi = useStore((s) => s.multi);
  const toggleMulti = useStore((s) => s.toggleMulti);
  const now = useNow();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const picked = useMemo(() => new Set(multi), [multi]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => searchRuns(Object.values(runs), query, nowMs(), MAX_RESULTS), [runs, query, now]);
  // The highlighted result: the first one after every new query, so Enter always acts on what is shown.
  const [active, setActive] = useState(() => (results[0] ? `run:${results[0].id}` : ''));
  const onQuery = (q: string) => {
    setQuery(q);
    const first = searchRuns(Object.values(useStore.getState().runs), q, nowMs(), 1)[0];
    setActive(first ? `run:${first.id}` : '');
  };

  return (
    <Modal title="Add or remove runs" onClose={onClose} className="palette mv-picker" initialFocus={() => inputRef.current}>
      <KeyFence>
        <Command shouldFilter={false} label="Find runs to add" loop value={active} onValueChange={setActive}>
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={onQuery}
            placeholder="Find runs: project, agent, status or time (e.g. “codex running today”)"
            aria-label="Find runs to add"
          />
          <Command.List>
            <Command.Empty>No runs match. Try an agent, a status, a project or “today”.</Command.Empty>
            {results.map((r: RunSummary) => {
              const inMulti = picked.has(r.id);
              return (
                <Command.Item key={r.id} value={`run:${r.id}`} onSelect={() => toggleMulti(r.id)} data-picked={inMulti ? '' : undefined}>
                  <span className="mv-picker__mark" aria-hidden="true">
                    <Icon icon={inMulti ? Tick02Icon : Add01Icon} size={15} />
                  </span>
                  <StatusMark status={r.status} size={15} decorative still />
                  <span className="palette__title">{r.title || 'Untitled run'}</span>
                  <span className="palette__meta">
                    {AGENT_NAMES[r.agent]} · {r.projectName} · {SHORT_LABELS[r.status]} · {relativeTime(r.updatedAt, now)}
                  </span>
                  <span className="mv-picker__state">{inMulti ? 'In multiviewer' : 'Add'}</span>
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
        <div className="mv-dialog__foot">
          <span className="muted" aria-live="polite">
            {multi.length} run{multi.length === 1 ? '' : 's'} picked. Enter adds or removes the highlighted run.
          </span>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </KeyFence>
    </Modal>
  );
}

export function SaveLayoutDialog({ onClose }: { onClose(): void }) {
  const multi = useStore((s) => s.multi);
  const layouts = useStore((s) => s.settings.layouts);
  const [name, setName] = useState(() => `Layout ${layouts.length + 1}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const clean = cleanLayoutName(name);
  const replaces = layouts.some((l) => l.name.toLowerCase() === clean.toLowerCase());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clean || busy) return;
    setBusy(true);
    saveLayout(clean, multi)
      .then(onClose)
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'Could not save the layout.');
      });
  };

  return (
    <Modal
      title="Save layout"
      onClose={onClose}
      className="mv-dialog"
      initialFocus={() => {
        inputRef.current?.select();
        return inputRef.current;
      }}
    >
      <KeyFence>
        <form className="dialog__body mv-form" onSubmit={submit}>
          <label htmlFor="mv-layout-name">Layout name</label>
          <input
            id="mv-layout-name"
            ref={inputRef}
            className="input"
            value={name}
            maxLength={LAYOUT_NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            aria-describedby="mv-layout-hint"
            autoComplete="off"
          />
          <p id="mv-layout-hint" className="muted mv-form__hint">
            Saves the {multi.length} picked run{multi.length === 1 ? '' : 's'} in their current order.
            {replaces ? ' A layout with this name exists and will be replaced.' : ''}
          </p>
          {error ? (
            <p role="alert" className="mv-form__error">
              {error}
            </p>
          ) : null}
          <div className="mv-dialog__foot">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={!clean || busy || !multi.length}>
              {replaces ? 'Replace layout' : 'Save layout'}
            </button>
          </div>
        </form>
      </KeyFence>
    </Modal>
  );
}

export function LayoutList({ layouts, onOpened }: { layouts: SavedLayout[]; onOpened?(): void }) {
  const runs = useStore((s) => s.runs);
  if (!layouts.length) return <p className="muted">No saved layouts yet. Pick some runs, then use “Save layout”.</p>;
  return (
    <ul className="mv-layouts" aria-label="Saved layouts">
      {layouts.map((l) => {
        const gone = l.runIds.filter((id) => !runs[id]).length;
        return (
          <li key={l.name} className="mv-layouts__item" data-testid="mv-layout">
            <div className="mv-layouts__text">
              <span className="mv-layouts__name">{l.name}</span>
              <span className="muted">
                {l.runIds.length} run{l.runIds.length === 1 ? '' : 's'}
                {gone ? ` · ${gone} no longer available` : ''}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              aria-label={`Open layout ${l.name}`}
              onClick={() => {
                openLayout(l);
                onOpened?.();
              }}
            >
              Open
            </button>
            <button
              type="button"
              className="btn btn--icon"
              aria-label={`Delete layout ${l.name}`}
              title="Delete this layout"
              onClick={() => void deleteLayout(l.name)}
            >
              <Icon icon={Delete02Icon} size={15} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function LayoutsDialog({ onClose }: { onClose(): void }) {
  const layouts = useStore((s) => s.settings.layouts);
  return (
    <Modal title="Saved layouts" onClose={onClose} className="mv-dialog">
      <KeyFence>
        <div className="dialog__body">
          <LayoutList layouts={layouts} onOpened={onClose} />
        </div>
      </KeyFence>
    </Modal>
  );
}
