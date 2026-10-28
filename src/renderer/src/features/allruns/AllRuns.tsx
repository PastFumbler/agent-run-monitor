// The run list viewer ('runs' route): every run, grouped by start time, built for organising.
// Click a row or its checkbox to select it, Shift-click to select a range, tick a group's box to select
// the whole group, then "Move to folder". "Open" on a row shows that run. Its status and folder filters
// are its own (the sidebar's filters don't apply here); the dashboard links here with a status filter.

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Folder01Icon, FolderExportIcon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, RUN_STATUSES, type RunSummary } from '@shared/schema';
import type { TimeFormat } from '@shared/settings';
import { Icon } from '../../components/Icon';
import { SHORT_LABELS } from '../../components/StatusBadge';
import { ToggleChip } from '../../components/ToggleChip';
import { formatTime } from '../../lib/time';
import { useNow } from '../../store/clock';
import { goBack, openRunWithDefaultView } from '../../store/actions';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { rowStatusWord } from '../runlist/RunRow';
import { effectiveFolder, filterViewer, groupByStart, setSelected, toggleSelection, type StartGroup } from './groups';
import { MoveToFolderDialog } from './MoveToFolder';
import '../multiview/multiview.css';
import './allruns.css';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface RowProps {
  run: RunSummary;
  checked: boolean;
  folder: string | undefined;
  timeFormat: TimeFormat;
  now: number;
  onToggle(e: React.MouseEvent, id: string): void;
}

const Row = memo(function Row({ run, checked, folder, timeFormat, now, onToggle }: RowProps) {
  const title = run.title || 'Untitled run';
  const started = run.startedAt > 0 ? formatTime(run.startedAt, timeFormat, now) : 'Unknown';
  return (
    // The checkbox is the keyboard path; a click anywhere else on the row does the same as clicking it.
    <li
      className="allruns__row"
      data-run-id={run.id}
      data-selected={checked ? '' : undefined}
      onClick={(e) => onToggle(e, run.id)}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on Shift-click
      }}
    >
      <input type="checkbox" className="allruns__check" checked={checked} onChange={() => {}} aria-label={`Select ${title}`} />
      <StatusMark status={run.status} size={16} decorative still />
      <span className="allruns__main">
        <span className="runrow__title" data-untitled={run.title ? undefined : ''}>
          {title}
        </span>
        <span className="runrow__meta">
          <span className="runrow__status status-text" data-status={run.status}>
            {rowStatusWord(run)}
          </span>
          <span className="dot-sep" aria-hidden="true" />
          <span>{AGENT_NAMES[run.agent]}</span>
          <span className="dot-sep" aria-hidden="true" />
          <span>{run.projectName}</span>
        </span>
      </span>
      <span className="allruns__folder" data-unfiled={folder ? undefined : ''} data-testid="run-folder">
        {folder ? <Icon icon={Folder01Icon} size={13} /> : null}
        <span>{folder ?? 'Unfiled'}</span>
      </span>
      <span className="runrow__time allruns__time" title="Started">
        {started}
      </span>
      <button
        type="button"
        className="btn btn--ghost allruns__open"
        aria-label={`Open ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          openRunWithDefaultView(run.id);
        }}
      >
        Open
      </button>
    </li>
  );
});

function GroupCheckbox({ label, state, onChange }: { label: string; state: 'all' | 'some' | 'none'; onChange(on: boolean): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="allruns__check"
      checked={state === 'all'}
      aria-checked={state === 'some' ? 'mixed' : state === 'all'}
      aria-label={`Select all runs in ${label}`}
      onChange={() => onChange(state !== 'all')}
    />
  );
}

function Group({
  group,
  selected,
  folderName,
  timeFormat,
  now,
  onToggle,
  onGroup,
}: {
  group: StartGroup;
  selected: ReadonlySet<string>;
  folderName(id: string): string | undefined;
  timeFormat: TimeFormat;
  now: number;
  onToggle(e: React.MouseEvent, id: string): void;
  onGroup(ids: string[], on: boolean): void;
}) {
  const headId = useId();
  const n = group.runs.reduce((k, r) => k + (selected.has(r.id) ? 1 : 0), 0);
  return (
    <section className="allruns__group" aria-labelledby={headId} data-group={group.id}>
      <div className="allruns__group-head">
        <GroupCheckbox
          label={group.label}
          state={n === 0 ? 'none' : n === group.runs.length ? 'all' : 'some'}
          onChange={(on) => onGroup(group.runs.map((r) => r.id), on)}
        />
        <h2 id={headId} className="allruns__group-title">
          {group.label}
          <span className="runlist__section-count">{group.runs.length}</span>
        </h2>
      </div>
      <ul className="allruns__rows" aria-labelledby={headId}>
        {group.runs.map((r) => (
          <Row
            key={r.id}
            run={r}
            checked={selected.has(r.id)}
            folder={folderName(r.id)}
            timeFormat={timeFormat}
            now={now}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

export function AllRuns() {
  const runs = useStore((s) => s.runs);
  const order = useStore((s) => s.order);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const filter = useStore((s) => s.runsView);
  const setRunsView = useStore((s) => s.setRunsView);
  const lastRoute = useStore((s) => s.lastRoute);
  const folders = useStore((s) => s.settings.folders);
  const runFolders = useStore((s) => s.settings.runFolders);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const folderSelectId = useId();

  const all = useMemo(() => order.map((id) => runs[id]).filter(Boolean), [runs, order]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const folder = effectiveFolder(filter.folder, new Set(folderById.keys()));
  const shown = useMemo(() => filterViewer(all, { statuses: filter.statuses, folder }, runFolders), [all, filter.statuses, folder, runFolders]);
  const groups = useMemo(() => groupByStart(shown, now), [shown, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.runs.map((r) => r.id)), [groups]);

  const counts = useMemo(() => {
    const status: Record<string, number> = {};
    const inFolder: Record<string, number> = {};
    let unfiled = 0;
    for (const r of all) {
      status[r.status] = (status[r.status] ?? 0) + 1;
      const f = runFolders[r.id];
      if (f && folderById.has(f)) inFolder[f] = (inFolder[f] ?? 0) + 1;
      else unfiled++;
    }
    return { status, inFolder, unfiled };
  }, [all, runFolders, folderById]);

  const [selected, setSel] = useState<Set<string>>(() => new Set());
  const [moving, setMoving] = useState(false);
  const [message, setMessage] = useState('');
  const anchor = useRef<string | null>(null);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  const onToggle = useCallback((e: React.MouseEvent, id: string) => {
    const from = anchor.current;
    const range = e.shiftKey;
    anchor.current = id;
    setSel((prev) => toggleSelection(prev, flatRef.current, id, from, range));
    setMessage('');
  }, []);
  const onGroup = useCallback((ids: string[], on: boolean) => {
    setSel((prev) => setSelected(prev, ids, on));
    setMessage('');
  }, []);

  // Only runs the filters show count as selected (and get moved).
  const picked = useMemo(() => flat.filter((id) => selected.has(id)), [flat, selected]);
  const folderName = useCallback((id: string) => folderById.get(runFolders[id] ?? '')?.name, [folderById, runFolders]);

  const statuses = RUN_STATUSES.filter((s) => (counts.status[s] ?? 0) > 0 || filter.statuses.includes(s));
  const filtered = filter.statuses.length > 0 || folder !== 'all';

  return (
    <div className="allruns" data-testid="all-runs">
      <header className="mv-toolbar">
        <h1 className="mv-toolbar__title">
          All runs
          <span className="muted mv-toolbar__count" data-testid="allruns-count">
            {filtered ? `${shown.length} of ${plural(all.length, 'run')}` : plural(all.length, 'run')}
          </span>
        </h1>
        <span className="mv-toolbar__spacer" />
        <button type="button" className="btn btn--ghost" onClick={goBack} title="Back (Esc)">
          {lastRoute === 'multiview' ? 'Back to multiviewer' : lastRoute === 'dashboard' ? 'Back to dashboard' : lastRoute === 'usage' ? 'Back to usage' : 'Back to run'}
        </button>
      </header>

      <div className="toolbar allruns__filters">
        <div className="filters__chips" role="group" aria-label="Filter by status">
          {statuses.map((s) => (
            <ToggleChip
              key={s}
              pressed={filter.statuses.includes(s)}
              onToggle={() =>
                setRunsView({ statuses: filter.statuses.includes(s) ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s] })
              }
              label={SHORT_LABELS[s]}
              count={counts.status[s] ?? 0}
              icon={<StatusMark status={s} size={12} decorative still />}
            />
          ))}
        </div>
        <span className="allruns__folder-filter">
          <label htmlFor={folderSelectId}>Folder</label>
          <select id={folderSelectId} className="input" value={folder} onChange={(e) => setRunsView({ folder: e.target.value })}>
            <option value="all">All folders ({all.length})</option>
            <option value="unfiled">Unfiled ({counts.unfiled})</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({counts.inFolder[f.id] ?? 0})
              </option>
            ))}
          </select>
        </span>
        {filtered ? (
          <button type="button" className="filters__clear" onClick={() => setRunsView({ statuses: [], folder: 'all' })}>
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="toolbar allruns__selbar" role="group" aria-label="Selected runs">
        <span className="allruns__selcount" data-testid="allruns-selected">
          {picked.length ? `${picked.length} selected` : 'No runs selected'}
        </span>
        <button type="button" className="btn btn--primary" disabled={!picked.length} onClick={() => setMoving(true)} data-testid="allruns-move">
          <Icon icon={FolderExportIcon} size={15} />
          Move to folder…
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!flat.length}
          onClick={() => {
            setSel(new Set(picked.length === flat.length ? [] : flat));
            setMessage('');
          }}
        >
          {picked.length && picked.length === flat.length ? 'Select none' : 'Select all'}
        </button>
        {picked.length && picked.length < flat.length ? (
          <button type="button" className="btn btn--ghost" onClick={() => setSel(new Set())}>
            Clear selection
          </button>
        ) : null}
        <span className="muted allruns__message" role="status" data-testid="allruns-message">
          {message}
        </span>
      </div>

      <div className="allruns__body">
        {!runsLoaded ? (
          <p className="empty-note">Loading runs…</p>
        ) : !all.length ? (
          <p className="empty-note">No runs yet. When an agent writes a session file, it shows up here.</p>
        ) : !shown.length ? (
          <p className="empty-note">No runs match these filters.</p>
        ) : (
          groups.map((g) => (
            <Group
              key={g.id}
              group={g}
              selected={selected}
              folderName={folderName}
              timeFormat={timeFormat}
              now={now}
              onToggle={onToggle}
              onGroup={onGroup}
            />
          ))
        )}
      </div>

      {moving ? (
        <MoveToFolderDialog
          runIds={picked}
          onClose={() => setMoving(false)}
          onMoved={(msg) => {
            setMoving(false);
            setSel(new Set());
            setMessage(msg);
          }}
        />
      ) : null}
    </div>
  );
}
