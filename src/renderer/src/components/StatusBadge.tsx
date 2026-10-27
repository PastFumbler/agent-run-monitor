import { STATUS_LABELS, type RunStatus } from '@shared/schema';
import StatusMark from '../vendor/react-bits/StatusMark/StatusMark';

/** Status mark plus the plain status word, so status is never colour alone. */
export function StatusBadge({ status, size = 14, short = false }: { status: RunStatus; size?: number; short?: boolean }) {
  return (
    <span className="status-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <StatusMark status={status} size={size} decorative />
      <span className="status-text" data-status={status}>
        {short ? SHORT_LABELS[status] : STATUS_LABELS[status]}
      </span>
    </span>
  );
}

export const SHORT_LABELS: Record<RunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stuck: 'Stuck',
  unreadable: 'Unreadable',
};
