// Ctrl/Cmd+K: find a run by title, project, agent, status and time words, or run a command.
// Filtering is ours (search.ts), so cmdk runs with shouldFilter={false}.

import { useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { AGENT_NAMES } from '@shared/schema';
import { Modal } from '../../components/Modal';
import { SHORT_LABELS } from '../../components/StatusBadge';
import { relativeTime } from '../../lib/time';
import { nowMs } from '../../backend/clock';
import { openRunWithDefaultView } from '../../store/actions';
import { useNow } from '../../store/clock';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { filterCommands, getCommands } from './commands';
import { describeQuery, isEmptyQuery, parseQuery, searchRuns } from './search';

const MAX_RUNS = 30;

export function CommandPalette() {
  const setOverlay = useStore((s) => s.setOverlay);
  const runs = useStore((s) => s.runs);
  const now = useNow();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => setOverlay('none');

  const parsed = useMemo(() => parseQuery(query), [query]);
  const runResults = useMemo(() => searchRuns(Object.values(runs), query, nowMs(), MAX_RUNS), [runs, query, now]);
  const commands = useMemo(() => filterCommands(getCommands(), query), [query]);
  const understood = !isEmptyQuery(parsed) && (parsed.agents.length || parsed.statuses.length || parsed.times.length) ? describeQuery(parsed) : '';

  return (
    <Modal title="Command palette" hideTitle onClose={close} className="palette" initialFocus={() => inputRef.current}>
      <Command shouldFilter={false} label="Search runs and commands" loop>
        <Command.Input
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          placeholder="Find a run (e.g. “codex failed yesterday”) or type a command…"
          aria-label="Search runs and commands"
        />
        {understood ? (
          <div className="palette__understood" aria-live="polite">
            Looking for: {understood}
          </div>
        ) : null}
        <Command.List>
          <Command.Empty>Nothing matches. Try an agent, a status, a project or “today”.</Command.Empty>
          {runResults.length ? (
            <Command.Group heading="Runs">
              {runResults.map((r) => (
                <Command.Item
                  key={r.id}
                  value={`run:${r.id}`}
                  onSelect={() => {
                    openRunWithDefaultView(r.id);
                    close();
                  }}
                >
                  <StatusMark status={r.status} size={15} decorative still />
                  <span className="palette__title">{r.title || 'Untitled run'}</span>
                  <span className="palette__meta">
                    {AGENT_NAMES[r.agent]} · {r.projectName} · {SHORT_LABELS[r.status]} · {relativeTime(r.updatedAt, now)}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {commands.length ? (
            <Command.Group heading="Commands">
              {commands.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`cmd:${c.id}`}
                  onSelect={() => {
                    close();
                    c.run();
                  }}
                >
                  <span className="palette__title">{c.label}</span>
                  {c.shortcut ? <span className="palette__meta">{c.shortcut}</span> : null}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command>
    </Modal>
  );
}
