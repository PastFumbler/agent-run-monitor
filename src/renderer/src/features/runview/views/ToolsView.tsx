// Tools: every tool call with its input, duration and outcome, filterable by kind.

import { useMemo, useState } from 'react';
import type { ToolKind } from '@shared/schema';
import { ToggleChip } from '../../../components/ToggleChip';
import { formatDuration } from '../../../lib/time';
import type { RunViewProps } from './ActivityView';

export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  run: 'Shell',
  edit: 'Edit',
  read: 'Read',
  search: 'Search',
  web: 'Web',
  agent: 'Sub-agent',
  other: 'Other',
};

const MAX_ROWS = 1000;

export function ToolsView({ detail, compact }: RunViewProps) {
  const [kinds, setKinds] = useState<ToolKind[]>([]);
  const counts = useMemo(() => {
    const c = new Map<ToolKind, number>();
    for (const t of detail.tools) c.set(t.toolKind, (c.get(t.toolKind) ?? 0) + 1);
    return c;
  }, [detail.tools]);
  const rows = useMemo(() => {
    const list = kinds.length ? detail.tools.filter((t) => kinds.includes(t.toolKind)) : detail.tools;
    return list.slice(-MAX_ROWS).reverse();
  }, [detail.tools, kinds]);
  const status = detail.summary.status;
  const live = status === 'running' || status === 'waiting' || status === 'stuck';

  if (!detail.tools.length) {
    return (
      <div className="tablewrap" data-testid="view-tools">
        <p className="empty-note">No tool calls in this run.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }} data-testid="view-tools">
      <div className="toolbar" role="group" aria-label="Filter tool calls by kind">
        <ToggleChip pressed={kinds.length === 0} onToggle={() => setKinds([])} label="All" count={detail.tools.length} />
        {(Object.keys(TOOL_KIND_LABELS) as ToolKind[])
          .filter((k) => counts.get(k))
          .map((k) => (
            <ToggleChip
              key={k}
              pressed={kinds.includes(k)}
              onToggle={() => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))}
              label={TOOL_KIND_LABELS[k]}
              count={counts.get(k)}
            />
          ))}
      </div>
      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">Tool calls, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Input</th>
              <th scope="col" className="num">
                Duration
              </th>
              {compact ? null : <th scope="col">Result</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.toolCallId ?? `${i}-${t.startedAt}`}>
                <td>
                  <div style={{ fontWeight: 600 }}>{t.toolName}</div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    {TOOL_KIND_LABELS[t.toolKind]}
                  </div>
                </td>
                <td className="cell-mono">
                  <div className="cell-clip" title={t.input}>
                    {t.input}
                  </div>
                </td>
                <td className="num">{t.durationMs !== undefined ? formatDuration(t.durationMs) : t.open && live ? 'running' : '-'}</td>
                {compact ? null : (
                  <td>
                    {t.open ? (
                      <span className="status-text" data-status={live ? 'running' : 'idle'}>
                        {live ? 'Running' : 'No result recorded'}
                      </span>
                    ) : t.isError ? (
                      <span>
                        <span className="status-text" data-status="failed" style={{ fontWeight: 600 }}>
                          Error:{' '}
                        </span>
                        <span className="cell-mono">{(t.output ?? '').split('\n')[0].slice(0, 140)}</span>
                      </span>
                    ) : (
                      <span>
                        <span className="status-text" data-status="done" style={{ fontWeight: 600 }}>
                          OK{' '}
                        </span>
                        <span className="muted">{(t.output ?? '').split('\n')[0].slice(0, 120)}</span>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
