// The sidebar run list: search, filter chips, and the sections Pinned / Recent / Today / Yesterday /
// Earlier, virtualised with @tanstack/react-virtual so 300+ runs scroll smoothly.
//
// AnimatedList and virtualisation: upstream AnimatedList measures and animates every item itself,
// which conflicts with a virtualiser that mounts only visible rows. We keep the virtualiser in charge
// and use AnimatedList's tile look plus its entrance animation per row (AnimatedListItem), played
// only for runs that appear after the list first loaded. Rows scrolled into view never animate.
//
// Selection: click opens a run; Ctrl/Cmd-click toggles it in the multiviewer selection; Shift-click
// adds the range from the last clicked run. j/k move the keyboard cursor, Enter opens (see shortcuts).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown01Icon, ArrowRight01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { AGENT_IDS, AGENT_NAMES, RUN_STATUSES, type RunSummary } from '@shared/schema';
import { Icon } from '../../components/Icon';
import { SHORT_LABELS } from '../../components/StatusBadge';
import { ToggleChip } from '../../components/ToggleChip';
import { useNow } from '../../store/clock';
import { SECTION_LABELS, type RunListModel, type SectionId } from '../../store/selectors';
import { useStore } from '../../store/store';
import { openRunWithDefaultView } from '../../store/actions';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { RunRow } from './RunRow';

type Row = { type: 'header'; id: SectionId; count: number } | { type: 'run'; run: RunSummary; section: SectionId };

const HEADER_H = 30;

function readOpen(key: string, d: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? d : v === '1';
  } catch {
    return d;
  }
}

/** The last "focus the search box" request (store.searchFocusTick) the search box acted on. */
let handledSearchTick = 0;

export function SearchBox() {
  const text = useStore((s) => s.filters.text);
  const setFilters = useStore((s) => s.setFilters);
  const tick = useStore((s) => s.searchFocusTick);
  const ref = useRef<HTMLInputElement>(null);
  // Focus once per request: not again when the sidebar remounts (e.g. back from All runs).
  useEffect(() => {
    if (tick !== handledSearchTick) {
      handledSearchTick = tick;
      ref.current?.focus();
      ref.current?.select();
    }
  }, [tick]);
  return (
    <div className="search" role="search">
      <span className="search__icon">
        <Icon icon={Search01Icon} size={15} />
      </span>
      <input
        ref={ref}
        className="input"
        type="search"
        aria-label="Search runs"
        placeholder="Search: project, agent, status, today…"
        value={text}
        onChange={(e) => setFilters({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (text) setFilters({ text: '' });
            else (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }
        }}
        spellCheck={false}
      />
      {!text ? (
        <span className="search__hint" aria-hidden="true">
          <span className="kbd">/</span>
        </span>
      ) : null}
    </div>
  );
}

export function FilterChips({ model }: { model: RunListModel }) {
  const filters = useStore((s) => s.filters);
  const toggleAgent = useStore((s) => s.toggleAgentFilter);
  const toggleStatus = useStore((s) => s.toggleStatusFilter);
  const clear = useStore((s) => s.clearFilters);
  const [agentsOpen, setAgentsOpen] = useState(() => readOpen('arm.filters.agents', true));
  const active = filters.agents.length + filters.statuses.length + (filters.text ? 1 : 0);
  const agents = AGENT_IDS.filter((a) => (model.agentCounts[a] ?? 0) > 0 || filters.agents.includes(a));
  const statuses = RUN_STATUSES.filter((s) => (model.statusCounts[s] ?? 0) > 0 || filters.statuses.includes(s));
  const agentsId = useId();

  return (
    <div className="filters">
      <div className="filters__group" role="group" aria-label="Filter by status">
        <div className="filters__head">
          <span>Status</span>
          {active ? (
            <button type="button" className="filters__clear" onClick={clear}>
              Clear filters ({active})
            </button>
          ) : null}
        </div>
        <div className="filters__chips">
          {statuses.map((s) => (
            <ToggleChip
              key={s}
              pressed={filters.statuses.includes(s)}
              onToggle={() => toggleStatus(s)}
              label={SHORT_LABELS[s]}
              count={model.statusCounts[s] ?? 0}
              icon={<StatusMark status={s} size={12} decorative still />}
            />
          ))}
        </div>
      </div>
      <div className="filters__group" role="group" aria-label="Filter by agent">
        <div className="filters__head">
          <button
            type="button"
            className="filters__toggle"
            aria-expanded={agentsOpen}
            aria-controls={agentsId}
            onClick={() => {
              setAgentsOpen(!agentsOpen);
              try {
                localStorage.setItem('arm.filters.agents', agentsOpen ? '0' : '1');
              } catch {
                /* ignore */
              }
            }}
          >
            <Icon icon={agentsOpen ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
            Agent{filters.agents.length ? ` (${filters.agents.length})` : ''}
          </button>
        </div>
        <div className="filters__chips" id={agentsId} hidden={!agentsOpen}>
          {agents.map((a) => (
            <ToggleChip
              key={a}
              pressed={filters.agents.includes(a)}
              onToggle={() => toggleAgent(a)}
              label={AGENT_NAMES[a]}
              count={model.agentCounts[a] ?? 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RunList({ model }: { model: RunListModel }) {
  const now = useNow();
  const currentId = useStore((s) => s.currentId);
  const cursorId = useStore((s) => s.cursorId);
  const anchorId = useStore((s) => s.anchorId);
  const multi = useStore((s) => s.multi);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const density = useStore((s) => s.settings.density);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const listId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const multiSet = useMemo(() => new Set(multi), [multi]);

  // Runs present at first load never animate in; later arrivals do, once.
  const seen = useRef<Set<string> | null>(null);
  const entering = useRef<Set<string>>(new Set());
  if (runsLoaded && !seen.current) seen.current = new Set(model.all.map((r) => r.id));
  if (seen.current) {
    for (const r of model.all) {
      if (!seen.current.has(r.id)) {
        seen.current.add(r.id);
        entering.current.add(r.id);
        setTimeout(() => entering.current.delete(r.id), 1500);
      }
    }
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of model.sections) {
      out.push({ type: 'header', id: s.id, count: s.runs.length });
      for (const r of s.runs) out.push({ type: 'run', run: r, section: s.id });
    }
    return out;
  }, [model.sections]);

  const rowH = density === 'compact' ? 50 : 62;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'header' ? HEADER_H : rowH),
    overscan: 10,
    getItemKey: (i) => {
      const r = rows[i];
      return r ? (r.type === 'header' ? `h:${r.id}` : `${r.section}:${r.run.id}`) : i;
    },
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowH, virtualizer]);

  // Keep the cursor row in view (j/k, ←/→).
  useEffect(() => {
    if (!cursorId) return;
    const idx = rows.findIndex((r) => r.type === 'run' && r.run.id === cursorId && r.section !== 'recent');
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
  }, [cursorId, rows, virtualizer]);

  const onRowClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      const st = useStore.getState();
      if (e.ctrlKey || e.metaKey) {
        st.toggleMulti(id);
        st.setAnchor(id);
        st.setCursor(id);
        return;
      }
      if (e.shiftKey && anchorId) {
        const a = model.nav.indexOf(anchorId);
        const b = model.nav.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          st.setMulti([...st.multi, ...model.nav.slice(lo, hi + 1)]);
          st.setCursor(id);
          return;
        }
      }
      openRunWithDefaultView(id);
    },
    [anchorId, model.nav],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Arrow keys inside the focused list move the cursor like j/k.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    const nav = model.nav;
    if (!nav.length) return;
    const st = useStore.getState();
    const i = st.cursorId ? nav.indexOf(st.cursorId) : -1;
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? nav.length - 1 : e.key === 'ArrowDown' ? Math.min(nav.length - 1, i + 1) : Math.max(0, i - 1);
    st.setCursor(nav[next]);
  };

  const activeDescendant = cursorId && model.nav.includes(cursorId) ? `${listId}-${cursorId}` : undefined;

  if (runsLoaded && !model.all.length) {
    return (
      <div className="runlist">
        <p className="runlist__empty">No runs yet. When an agent writes a session file, it shows up here.</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="runlist"
      role="listbox"
      aria-label="Runs"
      aria-multiselectable="true"
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="run-list"
    >
      {runsLoaded && !rows.length ? <p className="runlist__empty">No runs match these filters.</p> : null}
      <div className="runlist__inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          return (
            <div
              key={v.key}
              className="runlist__vrow"
              style={{ height: v.size, transform: `translateY(${v.start}px)` }}
              role="presentation"
            >
              {row.type === 'header' ? (
                <div className="runlist__section" role="presentation">
                  {SECTION_LABELS[row.id]}
                  <span className="runlist__section-count">{row.count}</span>
                </div>
              ) : (
                <RunRow
                  run={row.run}
                  optionId={row.section === 'recent' ? `${listId}-recent-${row.run.id}` : `${listId}-${row.run.id}`}
                  current={row.run.id === currentId}
                  cursor={row.run.id === cursorId && row.section !== 'recent'}
                  animate={row.run.id === currentId && row.section !== 'recent'}
                  inMulti={multiSet.has(row.run.id)}
                  entering={entering.current.has(row.run.id)}
                  now={now}
                  timeFormat={timeFormat}
                  onClick={onRowClick}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
