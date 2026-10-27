// The run's status line: StatusMark (shape + colour), the visible label and a polite live region.
// While running (and settings.synonyms is on) the visible label rotates through synonyms. Those words
// are aria-hidden decoration; the live region announces only the real status, and only on change.
// Waiting, failed, stuck and unreadable always show plain words, immediately.

import { memo, useMemo } from 'react';
import { STATUS_LABELS, type RunStatus } from '@shared/schema';
import { useMotionPolicy } from '../../motion/context';
import RotatingText from '../../vendor/react-bits/RotatingText/RotatingText';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import { synonymsFor } from './synonyms';

export const SYNONYM_INTERVAL_MS = 3000;

/** Whether synonyms may replace the status word. Only ever for a running run. */
export function showsSynonyms(status: RunStatus, enabled: boolean): boolean {
  return enabled && status === 'running';
}

/** Plain words for the status, with the detail where it matters ("Stuck: no activity for 23 min"). */
export function plainStatus(status: RunStatus, detail?: string): string {
  if (status === 'stuck' && detail) return `Stuck: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`;
  return STATUS_LABELS[status];
}

interface Props {
  runId: string;
  status: RunStatus;
  detail?: string;
  synonyms: boolean;
  /** Announce status changes (one live region per screen; tiles pass false). */
  announce?: boolean;
  size?: number;
}

export const StatusLabel = memo(function StatusLabel({ runId, status, detail, synonyms, announce = true, size = 18 }: Props) {
  const policy = useMotionPolicy();
  const words = useMemo(() => synonymsFor(runId), [runId]);
  const rotate = showsSynonyms(status, synonyms);
  const plain = plainStatus(status, detail);

  return (
    <span className="runview__status">
      <StatusMark status={status} size={size} label={plain} />
      {rotate ? (
        <span className="status-synonym status-text" data-status={status} data-testid="status-synonym" aria-hidden="true">
          {policy.animate ? (
            <RotatingText
              key={runId}
              texts={words.map((w) => `${w}…`)}
              rotationInterval={SYNONYM_INTERVAL_MS}
              effect="slide"
              splitBy="words"
              auto
            />
          ) : (
            // Reduce motion: one fixed word, no rotation.
            <span>{words[0]}…</span>
          )}
        </span>
      ) : (
        <span className="status-text" data-status={status} data-testid="status-word">
          {plain}
        </span>
      )}
      {detail && status !== 'stuck' && status !== 'unreadable' ? <span className="runview__status-detail">· {detail}</span> : null}
      {announce ? (
        <span className="sr-only" role="status" aria-live="polite" data-testid="run-status-live">
          {`Status: ${STATUS_LABELS[status]}`}
        </span>
      ) : null}
    </span>
  );
});
