// The dashboard ('dashboard' route): the home screen the app opens on. One section per run status (every
// status in the schema), each listing its 3 most recently updated runs, with "See all (n)" opening the
// run list viewer filtered to that status. The agent chips at the top filter every section; clicking a
// run opens it in the run view. Its agent filter is its own (the sidebar's filters don't apply here).

import { memo, useId, useMemo } from 'react';
import { AGENT_IDS, AGENT_NAMES, STATUS_LABELS, type RunSummary } from '@shared/schema';
import type { TimeFormat } from '@shared/settings';
import { ToggleChip } from '../../components/ToggleChip';
import { rowTime } from '../../lib/time';
import { useNow } from '../../store/clock';
import { openRunWithDefaultView, showAllRuns } from '../../store/actions';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { rowStatusWord } from '../runlist/RunRow';
import { agentCounts, dashboardSections, EMPTY_LINES, type DashboardSection } from './sections';
import '../multiview/multiview.css';
import './dashboard.css';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

const DashRun = memo(function DashRun({ run, timeFormat, now }: { run: RunSummary; timeFormat: TimeFormat; now: number }) {
  const title = run.title || 'Untitled run';
  const time = rowTime(run.updatedAt, timeFormat, now);
  // The section names the status; a row only adds a word when it says more ("Probably waiting").
  const word = run.statusInferred ? rowStatusWord(run) : null;
  const tool = run.status === 'running' && run.currentTool ? run.currentTool : null;
  return (
    <li>
      <button
        type="button"
        className="dashboard__run"
        data-run-id={run.id}
        aria-label={`${title}. ${word ?? STATUS_LABELS[run.status]}. ${AGENT_NAMES[run.agent]}, ${run.projectName}${tool ? `, using ${tool}` : ''}, updated ${time}`}
        onClick={() => openRunWithDefaultView(run.id)}
      >
        <span className="runrow__title" data-untitled={run.title ? undefined : ''}>
          {title}
        </span>
        <span className="runrow__time" title="Last updated">
          {time}
        </span>
        <span className="runrow__meta">
          {word ? (
            <>
              <span className="runrow__status status-text" data-status={run.status}>
                {word}
              </span>
              <span className="dot-sep" aria-hidden="true" />
            </>
          ) : null}
          <span>{AGENT_NAMES[run.agent]}</span>
          <span className="dot-sep" aria-hidden="true" />
          <span>{run.projectName}</span>
          {tool ? (
            <>
              <span className="dot-sep" aria-hidden="true" />
              <span>{tool}</span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
});

function Section({ section, filtered, timeFormat, now }: { section: DashboardSection; filtered: boolean; timeFormat: TimeFormat; now: number }) {
  const headId = useId();
  const { status, runs, matching, total } = section;
  const label = STATUS_LABELS[status];
  return (
    <section className="card dashboard__section" aria-labelledby={headId} data-status={status} data-empty={matching ? undefined : ''}>
      <div className="dashboard__head">
        {/* Only the Running mark may spin (and only when the motion policy allows loops). */}
        <StatusMark status={status} size={16} decorative still={status !== 'running' || !matching} />
        <h2 id={headId} className="dashboard__title">
          {label}
          <span className="muted runlist__section-count" data-testid="dashboard-count">
            {matching}
          </span>
        </h2>
      </div>
      {runs.length ? (
        <ul className="dashboard__runs" aria-labelledby={headId}>
          {runs.map((r) => (
            <DashRun key={r.id} run={r} timeFormat={timeFormat} now={now} />
          ))}
        </ul>
      ) : (
        <p className="dashboard__calm">{EMPTY_LINES[status]}</p>
      )}
      {total ? (
        <div className="dashboard__more">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => showAllRuns({ statuses: [status], folder: 'all' })}
            aria-label={`See all ${plural(total, `${label.toLowerCase()} run`)}${filtered ? ' from every agent' : ''} in All runs`}
            data-testid="dashboard-see-all"
          >
            See all ({total})
            {/* All runs filters by status only, so with agent chips on, say the count covers every agent. */}
            {filtered ? <span className="muted"> · every agent</span> : null}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function Dashboard() {
  const runs = useStore((s) => s.runs);
  const order = useStore((s) => s.order);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const agents = useStore((s) => s.homeAgents);
  const toggleAgent = useStore((s) => s.toggleHomeAgent);
  const clearAgents = useStore((s) => s.clearHomeAgents);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();

  const all = useMemo(() => order.map((id) => runs[id]).filter(Boolean), [runs, order]);
  const counts = useMemo(() => agentCounts(all), [all]);
  const sections = useMemo(() => dashboardSections(all, agents), [all, agents]);
  const chips = AGENT_IDS.filter((a) => (counts[a] ?? 0) > 0 || agents.includes(a));
  const filtered = agents.length > 0;
  const shown = filtered ? sections.reduce((n, s) => n + s.matching, 0) : all.length;

  return (
    <div className="dashboard" data-testid="dashboard">
      <header className="mv-toolbar">
        <h1 className="mv-toolbar__title">
          Dashboard
          <span className="muted mv-toolbar__count" data-testid="dashboard-total">
            {filtered ? `${shown} of ${plural(all.length, 'run')}` : plural(all.length, 'run')}
          </span>
        </h1>
      </header>

      {!runsLoaded ? (
        <p className="empty-note">Loading runs…</p>
      ) : !all.length ? (
        <div className="runview__empty">
          <h2 style={{ fontSize: '1.2rem', color: 'var(--text)' }}>No runs yet</h2>
          <p>
            Start a coding agent (Claude Code, Codex, Gemini CLI, Copilot, Aider, Cursor…) and its session appears here live.
            Agent Run Monitor only reads; it never changes agent files.
          </p>
        </div>
      ) : (
        <>
          <div className="toolbar dashboard__filters">
            <span className="dashboard__filter-label" aria-hidden="true">
              Agent
            </span>
            <div className="filters__chips" role="group" aria-label="Filter the dashboard by agent">
              {chips.map((a) => (
                <ToggleChip key={a} pressed={agents.includes(a)} onToggle={() => toggleAgent(a)} label={AGENT_NAMES[a]} count={counts[a] ?? 0} />
              ))}
            </div>
            {filtered ? (
              <button type="button" className="filters__clear" onClick={clearAgents}>
                Show every agent
              </button>
            ) : null}
          </div>
          <div className="dashboard__body">
            {sections.map((s) => (
              <Section key={s.status} section={s} filtered={filtered} timeFormat={timeFormat} now={now} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
