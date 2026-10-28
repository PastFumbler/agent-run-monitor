// The Simple display tier: replaces the whole app (no sidebar, no status bar) with the running runs
// only, one large plain line each saying what the run is doing, readable from across the room.
// The line is the first sentence of the Overview's local summary (doingSentence), so it names the file
// or command behind the open tool when the run's detail is loaded. Settings stays one key away:
// Esc or Ctrl/Cmd+, opens it, and two small buttons sit in the corner. No motion of its own; the
// running marks follow the motion policy.

import { memo, useMemo } from 'react';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, type RunSummary } from '@shared/schema';
import { doingSentence } from '@shared/summary';
import { Icon } from '../../components/Icon';
import { updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { useRunDetail, useWatchRuns } from '../runview/useRunDetail';
import { MOD } from '../shortcuts/shortcuts';
import { SIMPLE_WATCHED, simpleRuns } from './simple';
import './simple.css';

const SimpleLine = memo(function SimpleLine({ run, watched }: { run: RunSummary; watched: boolean }) {
  return watched ? <WatchedLine run={run} /> : <Line run={run} text={doingSentence(run)} />;
});

function WatchedLine({ run }: { run: RunSummary }) {
  const { detail } = useRunDetail(run.id);
  return <Line run={run} text={doingSentence(run, detail?.events)} />;
}

function Line({ run, text }: { run: RunSummary; text: string }) {
  return (
    <li className="simple__run" data-run-id={run.id}>
      <span className="simple__where">
        <StatusMark status="running" size={22} decorative />
        {AGENT_NAMES[run.agent]}
        <span className="dot-sep" aria-hidden="true" />
        {run.projectName}
      </span>
      <span className="simple__line" data-testid="simple-line">
        {text}
      </span>
    </li>
  );
}

export function SimpleBoard() {
  const runs = useStore((s) => s.runs);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const setRoute = useStore((s) => s.setRoute);
  const running = useMemo(() => simpleRuns(Object.values(runs)), [runs]);
  const watched = running.slice(0, SIMPLE_WATCHED).map((r) => r.id);
  useWatchRuns('simple', watched);

  return (
    <div className="simple" data-testid="simple-board">
      <header className="simple__bar">
        <h1 className="simple__title">
          Running now
          <span className="muted" data-testid="simple-count">
            {running.length}
          </span>
        </h1>
        <span className="simple__hint muted">
          <span className="kbd">Esc</span> settings
        </span>
        <button type="button" className="btn btn--ghost" onClick={() => void updateSettings({ displayTier: 'default' })}>
          Show the full app
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setRoute('settings')} title={`Settings (Esc or ${MOD}+,)`}>
          <Icon icon={Settings02Icon} size={16} />
          Settings
        </button>
      </header>
      {!runsLoaded ? (
        <p className="simple__calm">Loading runs…</p>
      ) : running.length ? (
        <ul className="simple__list" aria-label="Running runs">
          {running.map((r, i) => (
            <SimpleLine key={r.id} run={r} watched={i < SIMPLE_WATCHED} />
          ))}
        </ul>
      ) : (
        <p className="simple__calm" data-testid="simple-empty">
          Nothing is running right now.
        </p>
      )}
    </div>
  );
}
