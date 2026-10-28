// Code changed: every applied edit in time order (oldest first), with a total at the top. An edit
// whose source recorded its content expands to show the (already masked) diff. Line counts the
// source didn't record read "unknown", never 0.

import { useCallback, useId, useMemo, useState } from 'react';
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { CodeChange } from '@shared/schema';
import { Icon } from '../../../components/Icon';
import { formatTime } from '../../../lib/time';
import { useNow } from '../../../store/clock';
import { useStore } from '../../../store/store';
import type { RunViewProps } from './ActivityView';
import { changeKeys, changeTotals, diffLines } from './changes';

const OP_WORDS: Partial<Record<CodeChange['op'], string>> = { create: 'created', delete: 'deleted' };

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function Lines({ change }: { change: CodeChange }) {
  const { linesAdded: a, linesRemoved: r } = change;
  if (a === undefined && r === undefined) return <span className="change__lines muted">Lines unknown</span>;
  return (
    <span className="change__lines">
      {a === undefined ? <span className="muted">+unknown</span> : <span className="change__add">+{a.toLocaleString()}</span>}
      <span className="sr-only"> lines added, </span>{' '}
      {r === undefined ? <span className="muted">−unknown</span> : <span className="change__del">−{r.toLocaleString()}</span>}
      <span className="sr-only"> lines removed</span>
    </span>
  );
}

function Diff({ id, change }: { id: string; change: CodeChange }) {
  const lines = useMemo(() => diffLines(change.diff ?? ''), [change.diff]);
  return (
    <div id={id} className="change__body">
      {/* Focusable so a keyboard can scroll long lines sideways. */}
      <pre className="change__diff" role="region" aria-label={`Diff of ${change.filePath}`} tabIndex={0}>
        {lines.map((l, i) => (
          <span key={i} className="diff__line" data-kind={l.kind}>
            {l.text || ' '}
          </span>
        ))}
      </pre>
      {change.truncated ? <p className="change__note muted">The rest of this diff was cut to keep memory use bounded.</p> : null}
    </div>
  );
}

export function CodeChangesView({ detail, compact }: RunViewProps) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const uid = useId();
  const changes = detail.changes ?? [];
  const totals = useMemo(() => changeTotals(changes), [changes]);
  // The run view reuses this component across runs, so open diffs are keyed by run too.
  const runId = detail.summary.id;
  const keys = useMemo(() => changeKeys(changes).map((k) => `${runId}\n${k}`), [changes, runId]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );

  if (!changes.length) {
    return (
      <div className="changes" data-testid="view-changes">
        <p className="empty-note">This run hasn't changed any code.</p>
      </div>
    );
  }

  const total = detail.totalChanges ?? changes.length;
  const allUnknown = totals.unknown === totals.edits;

  return (
    <div className="changes" data-testid="view-changes">
      <p className="changes__total" data-testid="changes-total">
        <strong>{plural(totals.files, 'file')}</strong>{' '}
        {allUnknown ? (
          <span className="muted">Line counts not recorded</span>
        ) : (
          <>
            <span className="change__add">
              +{totals.added.toLocaleString()}
              <span className="sr-only"> lines added</span>
            </span>{' '}
            <span className="change__del">
              −{totals.removed.toLocaleString()}
              <span className="sr-only"> lines removed</span>
            </span>
          </>
        )}{' '}
        <span className="muted">in {plural(totals.edits, 'edit')}</span>{' '}
        {totals.unknown && !allUnknown ? <span className="muted">({totals.unknown.toLocaleString()} with unknown line counts)</span> : null}
      </p>
      {total > changes.length ? (
        <p className="changes__note muted" data-testid="changes-window">
          Showing the latest {changes.length.toLocaleString()} of {total.toLocaleString()} edits; the total covers the ones shown.
        </p>
      ) : null}
      <ol className="changes__list" aria-label="Code changes, oldest first">
        {changes.map((c, i) => {
          const key = keys[i];
          const expanded = open.has(key);
          const bodyId = `${uid}-change-${i}`;
          const op = OP_WORDS[c.op];
          const head = (
            <>
              <span className="change__time">{c.ts !== undefined ? formatTime(c.ts, timeFormat, now) : '-'}</span>
              <span className="change__file">
                <span className="cell-mono">{c.filePath}</span>
                {op && !compact ? <span className="muted"> {op}</span> : null}
                {c.diff === undefined ? <span className="change__nodiff muted">{c.truncated ? 'Diff dropped to keep memory use bounded' : 'No diff recorded'}</span> : null}
              </span>
              <Lines change={c} />
            </>
          );
          return (
            <li key={key} className="change" data-expanded={expanded ? '' : undefined}>
              {c.diff !== undefined ? (
                <button type="button" className="change__head" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={() => toggle(key)}>
                  <Icon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={13} />
                  {head}
                </button>
              ) : (
                <div className="change__head">
                  <span className="change__icon" aria-hidden="true" />
                  {head}
                </div>
              )}
              {expanded && c.diff !== undefined ? <Diff id={bodyId} change={c} /> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
