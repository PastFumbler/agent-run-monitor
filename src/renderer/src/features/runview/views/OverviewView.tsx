// Overview: plain-words status, counters, timing, where the run came from, sub-runs, and a calm
// "Couldn't read this run" card for unreadable runs (never a crash).

import { FolderOpenIcon, HelpCircleIcon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, STATUS_LABELS, type RunSummary } from '@shared/schema';
import { Icon } from '../../../components/Icon';
import { StatusBadge } from '../../../components/StatusBadge';
import { formatDuration, formatTime } from '../../../lib/time';
import { revealSource, openRunWithDefaultView } from '../../../store/actions';
import { useNow } from '../../../store/clock';
import { useStore } from '../../../store/store';
import Counter from '../../../vendor/react-bits/Counter/Counter';
import StatusMark from '../../../vendor/react-bits/StatusMark/StatusMark';
import { useId } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { RunViewProps } from './ActivityView';

export function OverviewView({ detail, compact }: RunViewProps) {
  const s = detail.summary;
  const timeFormat = useStore((st) => st.settings.timeFormat);
  // Select only this run's relatives, so an Overview (one per multiviewer tile) does not
  // re-render on every other run's update and defeat the tile throttle.
  const children = useStore(useShallow((st) => Object.values(st.runs).filter((r) => r.parentId === s.id)));
  const parent = useStore((st) => (s.parentId ? st.runs[s.parentId] : undefined));
  const now = useNow();
  // Ids must be unique when several tiles show an Overview at once.
  const uid = useId();
  const ids = { readerror: `${uid}-readerror`, status: `${uid}-status`, parent: `${uid}-parent`, subruns: `${uid}-subruns` };
  const tokens = (s.counts.inputTokens ?? 0) + (s.counts.outputTokens ?? 0);

  const stats: { label: string; value: number }[] = [
    { label: 'Events', value: s.counts.events },
    { label: 'Messages', value: s.counts.messages },
    { label: 'Tool calls', value: s.counts.toolCalls },
    { label: 'Errors', value: s.counts.errors },
    { label: 'Files changed', value: s.counts.filesChanged },
  ];
  if (s.counts.inputTokens !== undefined || s.counts.outputTokens !== undefined) stats.push({ label: 'Tokens', value: tokens });

  return (
    <div className="overview" data-testid="view-overview">
      {s.status === 'unreadable' ? (
        <section className="readerror" aria-labelledby={ids.readerror}>
          <h2 id={ids.readerror}>
            <StatusMark status="unreadable" size={20} decorative />
            Couldn't read this run
          </h2>
          <p style={{ margin: '0 0 6px' }}>{s.readError ?? s.statusDetail ?? 'The file could not be parsed.'}</p>
          <p className="muted" style={{ margin: '0 0 8px' }}>
            The app keeps watching this file. If the agent rewrites it in a readable form, the run appears here on its own.
            Nothing was changed on disk.
          </p>
          <p className="cell-mono" style={{ margin: 0 }}>
            {s.sourcePath}
          </p>
        </section>
      ) : (
        <section className="card overview__status" aria-labelledby={ids.status}>
          <StatusMark status={s.status} size={22} decorative still />
          <div>
            <h2 id={ids.status}>{STATUS_LABELS[s.status]}</h2>
            <p className="muted" style={{ margin: '2px 0 0' }}>
              {s.statusDetail ?? defaultDetail(s.status)}
            </p>
          </div>
        </section>
      )}

      {s.status !== 'unreadable' ? (
        <section aria-label="Counts" className="stats">
          {stats.map((st) => (
            <div key={st.label} className="card stat">
              <div className="stat__label">{st.label}</div>
              <div className="stat__value">
                <Counter value={st.value} fontSize="inherit" fade={0} />
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="card" aria-label="Details">
        <dl className="facts">
          <dt>Agent</dt>
          <dd>{AGENT_NAMES[s.agent]}</dd>
          <dt>Project</dt>
          <dd>
            {s.projectName}
            {s.projectPath ? <span className="muted cell-mono"> ({s.projectPath})</span> : null}
          </dd>
          {s.gitBranch ? (
            <>
              <dt>Branch</dt>
              <dd className="cell-mono">{s.gitBranch}</dd>
            </>
          ) : null}
          {s.model ? (
            <>
              <dt>Model</dt>
              <dd className="cell-mono">{s.model}</dd>
            </>
          ) : null}
          <dt>Started</dt>
          <dd>{formatTime(s.startedAt, timeFormat, now)}</dd>
          <dt>Last update</dt>
          <dd>{formatTime(s.updatedAt, timeFormat, now)}</dd>
          <dt>Duration</dt>
          <dd>{formatDuration(Math.max(0, s.updatedAt - s.startedAt))}</dd>
          {s.counts.inputTokens !== undefined ? (
            <>
              <dt>Tokens</dt>
              <dd>
                {(s.counts.inputTokens ?? 0).toLocaleString()} in · {(s.counts.outputTokens ?? 0).toLocaleString()} out
              </dd>
            </>
          ) : null}
          <dt>Source file</dt>
          <dd>
            <span className="cell-mono">{s.sourcePath}</span>{' '}
            <button type="button" className="btn btn--ghost" onClick={() => revealSource(s.id)} style={{ minHeight: 24, padding: '0 6px' }}>
              <Icon icon={FolderOpenIcon} size={14} />
              Reveal in folder
            </button>
          </dd>
        </dl>
      </section>

      {/* A middle run (a workflow inside a session) has both: show its parent and its sub-runs. */}
      {parent ? <RelatedRuns id={ids.parent} heading="Part of" runs={[parent]} /> : null}
      {children.length ? <RelatedRuns id={ids.subruns} heading="Sub-runs" runs={children} /> : null}

      {compact ? null : (
        <p className="muted" style={{ margin: 0, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon icon={HelpCircleIcon} size={14} />
          Read-only: Agent Run Monitor never changes agent files.
        </p>
      )}
    </div>
  );
}

function RelatedRuns({ id, heading, runs }: { id: string; heading: string; runs: RunSummary[] }) {
  return (
    <section className="card" aria-labelledby={id} style={{ padding: '12px 14px' }}>
      <h2 id={id} style={{ margin: '0 0 6px', fontSize: '1rem' }}>
        {heading}
      </h2>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
        {runs.map((r) => (
          <li key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusBadge status={r.status} short />
            <button type="button" className="btn btn--ghost" onClick={() => openRunWithDefaultView(r.id)}>
              {r.title || 'Untitled run'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function defaultDetail(status: string): string {
  switch (status) {
    case 'running':
      return 'Working right now.';
    case 'waiting':
      return 'Waiting for your input.';
    case 'idle':
      return 'The last turn finished; the session may continue.';
    case 'done':
      return 'Finished and quiet.';
    case 'failed':
      return 'The last turn ended with an error.';
    case 'stuck':
      return 'Looked busy, but nothing has happened for a long time.';
    default:
      return '';
  }
}
