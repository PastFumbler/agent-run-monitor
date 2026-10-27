// The run view: header (status, title, facts, navigation, pin, add to multiviewer), the fake
// progress bar for running runs, the view switcher and the selected view.

import { useMemo } from 'react';
import { ArrowLeft01Icon, ArrowRight01Icon, GridViewIcon, PinIcon, PinOffIcon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, type RunSummary } from '@shared/schema';
import type { RunView as RunViewId } from '@shared/settings';
import { Icon } from '../../components/Icon';
import { formatTime } from '../../lib/time';
import { openRunWithDefaultView, togglePin } from '../../store/actions';
import { useNow } from '../../store/clock';
import { useStore } from '../../store/store';
import RubberSegment from '../../vendor/react-bits/RubberSegment/RubberSegment';
import { shortcutText } from '../shortcuts/shortcuts';
import { FakeProgress } from './FakeProgress';
import { StatusLabel } from './StatusLabel';
import { useRunDetail, useWatchRuns } from './useRunDetail';
import { VIEWS, VIEW_BY_ID } from './views';

export function RunHeader({ run, nav }: { run: RunSummary; nav: string[] }) {
  const settings = useStore((s) => s.settings);
  const inMulti = useStore((s) => s.multi.includes(run.id));
  const toggleMulti = useStore((s) => s.toggleMulti);
  const now = useNow();
  const idx = nav.indexOf(run.id);
  const prev = idx > 0 ? nav[idx - 1] : null;
  const next = idx >= 0 && idx < nav.length - 1 ? nav[idx + 1] : null;
  const pinned = settings.pinned.includes(run.id);
  const tf = settings.timeFormat;

  return (
    <header className="runview__header">
      <div className="runview__titlebar">
        <div className="runview__titles">
          <StatusLabel runId={run.id} status={run.status} detail={run.statusDetail} inferred={run.statusInferred} synonyms={settings.synonyms} />
          <h1 className="runview__title" data-untitled={run.title ? undefined : ''} data-testid="run-title">
            {run.title || 'Untitled run'}
          </h1>
          <dl className="runview__meta">
            <div>
              <dt className="sr-only">Agent</dt>
              <dd>{AGENT_NAMES[run.agent]}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{run.projectName}</dd>
            </div>
            {run.gitBranch ? (
              <div>
                <dt>Branch</dt>
                <dd className="mono">{run.gitBranch}</dd>
              </div>
            ) : null}
            {run.model ? (
              <div>
                <dt>Model</dt>
                <dd className="mono">{run.model}</dd>
              </div>
            ) : null}
            <div>
              <dt>Started</dt>
              <dd>{formatTime(run.startedAt, tf, now)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatTime(run.updatedAt, tf, now)}</dd>
            </div>
          </dl>
        </div>
        <div className="runview__actions">
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Previous run"
            title={`Previous run (${shortcutText('prev')})`}
            disabled={!prev}
            onClick={() => prev && openRunWithDefaultView(prev)}
          >
            <Icon icon={ArrowLeft01Icon} />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Next run"
            title={`Next run (${shortcutText('next')})`}
            disabled={!next}
            onClick={() => next && openRunWithDefaultView(next)}
          >
            <Icon icon={ArrowRight01Icon} />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin run' : 'Pin run'}
            title={`${pinned ? 'Unpin' : 'Pin'} run (p)`}
            onClick={() => void togglePin(run.id)}
          >
            <Icon icon={pinned ? PinOffIcon : PinIcon} />
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={inMulti}
            title="Add to or remove from the multiviewer (m)"
            onClick={() => toggleMulti(run.id)}
          >
            <Icon icon={GridViewIcon} />
            {inMulti ? 'In multiviewer' : 'Add to multiviewer'}
          </button>
        </div>
      </div>
      <div className="runview__bar">
        <ViewSwitcher />
        <FakeProgress status={run.status} enabled={settings.fakeProgress} />
      </div>
    </header>
  );
}

export function ViewSwitcher({ value, onChange, label = 'Run view' }: { value?: RunViewId; onChange?(v: RunViewId): void; label?: string }) {
  const storeView = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const items = useMemo(() => VIEWS.map((v) => ({ value: v.id, label: v.label, title: `${v.label} (${v.key})` })), []);
  return (
    <RubberSegment
      items={items}
      value={value ?? storeView}
      onChange={(v) => (onChange ?? setView)(v as RunViewId)}
      size="sm"
      aria-label={label}
      equalSlots={false}
    />
  );
}

export function RunView({ runId, nav }: { runId: string; nav: string[] }) {
  const run = useStore((s) => s.runs[runId]);
  const view = useStore((s) => s.view);
  useWatchRuns('runview', [runId]);
  const { detail, loading, missing } = useRunDetail(runId);

  if (!run) {
    return (
      <div className="runview">
        <p className="runview__empty">This run is no longer available.</p>
      </div>
    );
  }

  const View = VIEW_BY_ID[view]?.Component ?? VIEWS[0].Component;
  // The header always uses the live summary; views use the detail (with the summary patched in).
  const merged = detail ? { ...detail, summary: run } : null;

  return (
    <div className="runview" data-run-id={runId}>
      <RunHeader run={run} nav={nav} />
      <section className="runview__body" aria-label={`${VIEW_BY_ID[view]?.label ?? 'Activity'} view`}>
        {merged ? (
          <View detail={merged} />
        ) : missing ? (
          <p className="runview__empty">Couldn't load this run's details.</p>
        ) : loading ? (
          <p className="runview__empty">Loading…</p>
        ) : null}
      </section>
    </div>
  );
}
