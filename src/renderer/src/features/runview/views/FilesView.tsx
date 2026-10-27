// Files: the files a run changed, sortable by path, change count or last change.

import { useMemo, useState } from 'react';
import { ArrowDown01Icon, ArrowUp01Icon } from '@hugeicons/core-free-icons';
import type { FileChangeSummary } from '@shared/schema';
import { Icon } from '../../../components/Icon';
import { formatTime } from '../../../lib/time';
import { useNow } from '../../../store/clock';
import { useStore } from '../../../store/store';
import type { RunViewProps } from './ActivityView';

type SortKey = 'path' | 'count' | 'lastTs';

const OP_WORDS: Record<string, string> = { create: 'created', edit: 'edited', delete: 'deleted' };

export function sortFiles(files: FileChangeSummary[], key: SortKey, dir: 1 | -1): FileChangeSummary[] {
  return [...files].sort((a, b) => {
    const av = key === 'path' ? a.path : key === 'count' ? a.count : (a.lastTs ?? 0);
    const bv = key === 'path' ? b.path : key === 'count' ? b.count : (b.lastTs ?? 0);
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir || a.path.localeCompare(b.path);
  });
}

export function FilesView({ detail, compact }: RunViewProps) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const [key, setKey] = useState<SortKey>('lastTs');
  const [dir, setDir] = useState<1 | -1>(-1);
  const rows = useMemo(() => sortFiles(detail.files, key, dir), [detail.files, key, dir]);

  const header = (k: SortKey, label: string, cls?: string) => {
    const active = key === k;
    return (
      <th className={cls} aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : 'none'} scope="col">
        <button
          type="button"
          className="sortbtn"
          onClick={() => {
            if (active) setDir(dir === 1 ? -1 : 1);
            else {
              setKey(k);
              setDir(k === 'path' ? 1 : -1);
            }
          }}
        >
          {label}
          {active ? <Icon icon={dir === 1 ? ArrowUp01Icon : ArrowDown01Icon} size={13} /> : null}
          <span className="sr-only">{active ? `, sorted ${dir === 1 ? 'ascending' : 'descending'}` : ', sortable'}</span>
        </button>
      </th>
    );
  };

  if (!rows.length) {
    return (
      <div className="tablewrap" data-testid="view-files">
        <p className="empty-note">This run hasn't changed any files.</p>
      </div>
    );
  }

  return (
    <div className="tablewrap" data-testid="view-files">
      <table className="table">
        <caption className="sr-only">Files changed by this run</caption>
        <thead>
          <tr>
            {header('path', 'Path')}
            <th scope="col">Changes</th>
            {header('count', 'Count', 'num')}
            {compact ? null : header('lastTs', 'Last change')}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.path}>
              <td className="cell-mono">{f.path}</td>
              <td>{f.ops.map((o) => OP_WORDS[o] ?? o).join(', ')}</td>
              <td className="num">{f.count}</td>
              {compact ? null : <td>{f.lastTs ? formatTime(f.lastTs, timeFormat, now) : '-'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
