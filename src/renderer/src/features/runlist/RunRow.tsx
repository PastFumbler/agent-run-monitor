import { memo } from 'react';
import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, type RunSummary } from '@shared/schema';
import type { TimeFormat } from '@shared/settings';
import { Icon } from '../../components/Icon';
import { SHORT_LABELS } from '../../components/StatusBadge';
import { rowTime } from '../../lib/time';
import { AnimatedListItem } from '../../vendor/react-bits/AnimatedList/AnimatedList';
import CallChip from '../../vendor/react-bits/CallChip/CallChip';
import LatticeLoader from '../../vendor/react-bits/LatticeLoader/LatticeLoader';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { guessToolKind } from '../runview/eventItems';

interface Props {
  run: RunSummary;
  optionId: string;
  current: boolean;
  cursor: boolean;
  inMulti: boolean;
  entering: boolean;
  now: number;
  timeFormat: TimeFormat;
  onClick(e: React.MouseEvent, id: string): void;
}

export const RunRow = memo(function RunRow({ run, optionId, current, cursor, inMulti, entering, now, timeFormat, onClick }: Props) {
  const title = run.title || 'Untitled run';
  const running = run.status === 'running';
  return (
    <AnimatedListItem
      id={optionId}
      role="option"
      aria-selected={current}
      aria-label={`${title}. ${SHORT_LABELS[run.status]}. ${AGENT_NAMES[run.agent]}, ${run.projectName}, ${rowTime(run.updatedAt, timeFormat, now)}${inMulti ? '. In multiviewer' : ''}`}
      className="runrow"
      data-run-id={run.id}
      data-status={run.status}
      data-cursor={cursor ? '' : undefined}
      selected={current}
      entering={entering}
      onClick={(e) => onClick(e, run.id)}
    >
      <span className="runrow__mark">
        <StatusMark status={run.status} size={16} decorative />
      </span>
      <span className="runrow__title" data-untitled={run.title ? undefined : ''}>
        {title}
      </span>
      <span className="runrow__time">{rowTime(run.updatedAt, timeFormat, now)}</span>
      <span className="runrow__meta">
        <span className="runrow__status status-text" data-status={run.status}>
          {SHORT_LABELS[run.status]}
        </span>
        <span className="dot-sep" aria-hidden="true" />
        <span>{AGENT_NAMES[run.agent]}</span>
        <span className="dot-sep" aria-hidden="true" />
        <span>{run.projectName}</span>
      </span>
      <span className="runrow__side">
        {inMulti ? (
          <span className="runrow__multi" title="In multiviewer">
            <Icon icon={CheckmarkCircle02Icon} size={14} />
          </span>
        ) : null}
        {running && run.currentTool ? (
          <CallChip kind={guessToolKind(run.currentTool)} name={run.currentTool} status="running" compact showTimer={false} />
        ) : running ? (
          <LatticeLoader showLabel={false} cellSize={3} gap={1.5} />
        ) : null}
      </span>
    </AnimatedListItem>
  );
});
