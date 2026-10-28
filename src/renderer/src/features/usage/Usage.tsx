// The Usage screen ('usage' route): tokens per agent for a time range (today, this week, this month, all
// time), split into input, output, cache read and cache write, plus every run in the range, sortable by
// any of them. Data a source didn't record says "Not reported", never 0. No costs: prices change and
// would go stale. Everything comes from RunSummary.usage, so no run detail is loaded here.

import { useId, useMemo, useState } from 'react';
import { ArrowDown01Icon, ArrowUp01Icon } from '@hugeicons/core-free-icons';
import { AGENT_NAMES, type TokenUsage } from '@shared/schema';
import { Icon } from '../../components/Icon';
import { rowTime } from '../../lib/time';
import { useNow } from '../../store/clock';
import { openRunWithDefaultView } from '../../store/actions';
import { useStore } from '../../store/store';
import RubberSegment from '../../vendor/react-bits/RubberSegment/RubberSegment';
import { historyLabel } from '../settings/describe';
import { agentUsage, formatTokens, rangeStart, sortRows, sumRows, USAGE_RANGES, usageRows, type UsageSort } from './totals';
import '../multiview/multiview.css';
import './usage.css';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const DAY = 86_400_000;

const COLUMNS: { key: UsageSort; label: string }[] = [
  { key: 'total', label: 'Total' },
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
];

const NotReported = () => <span className="usage__none">Not reported</span>;

/** The five token cells; one "Not reported" cell across them (read from the Total column) when nothing was reported. */
function TokenCells({ usage, total }: { usage?: TokenUsage; total?: number }) {
  if (!usage) {
    return (
      <td className="usage__nonecell" colSpan={COLUMNS.length}>
        <NotReported />
      </td>
    );
  }
  return (
    <>
      {COLUMNS.map(({ key }) => {
        const n = key === 'total' ? total : usage[key];
        return (
          <td key={key} className="num">
            {n === undefined ? <NotReported /> : formatTokens(n)}
          </td>
        );
      })}
    </>
  );
}

export function Usage() {
  const runs = useStore((s) => s.runs);
  const order = useStore((s) => s.order);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const range = useStore((s) => s.usageRange);
  const setRange = useStore((s) => s.setUsageRange);
  const historyDays = useStore((s) => s.settings.historyDays);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const now = useNow();
  const [sort, setSort] = useState<UsageSort>('total');
  const [dir, setDir] = useState<1 | -1>(-1);
  const agentsHead = useId();
  const runsHead = useId();

  const all = useMemo(() => order.map((id) => runs[id]).filter(Boolean), [runs, order]);
  const rows = useMemo(() => usageRows(all, range, now), [all, range, now]);
  const agents = useMemo(() => agentUsage(rows), [rows]);
  const totals = useMemo(() => sumRows(rows), [rows]);
  const sorted = useMemo(() => sortRows(rows, sort, dir), [rows, sort, dir]);

  const rangeLabel = USAGE_RANGES.find((r) => r.id === range)!.label;
  const start = rangeStart(range, now);
  // Runs older than the history window are never loaded, so their tokens can't be counted.
  const clipped = historyDays > 0 && (range === 'all' || start < now - historyDays * DAY);

  const header = (key: UsageSort, label: string) => {
    const active = sort === key;
    return (
      <th key={key} className="num" scope="col" aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className="sortbtn"
          onClick={() => {
            if (active) setDir(dir === 1 ? -1 : 1);
            else {
              setSort(key);
              setDir(-1);
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

  return (
    <div className="usage" data-testid="usage">
      <header className="mv-toolbar">
        <h1 className="mv-toolbar__title">
          Usage
          <span className="muted mv-toolbar__count" data-testid="usage-count">
            {range === 'all' ? plural(rows.length, 'run') : `${plural(rows.length, 'run')} ${rangeLabel.toLowerCase()}`}
          </span>
        </h1>
        <span className="mv-toolbar__spacer" />
        <RubberSegment
          items={USAGE_RANGES.map((r) => ({ value: r.id, label: r.label }))}
          value={range}
          onChange={(v) => setRange(v as typeof range)}
          size="sm"
          equalSlots={false}
          aria-label="Time range"
        />
      </header>

      {!runsLoaded ? (
        <p className="empty-note">Loading runs…</p>
      ) : (
        <div className="usage__body">
          <section aria-labelledby={agentsHead}>
            <h2 id={agentsHead} className="usage__heading">
              Tokens by agent
            </h2>
            {!agents.length ? (
              <p className="empty-note" data-testid="usage-empty">
                {range === 'all' ? 'No runs yet.' : `No runs were active ${rangeLabel.toLowerCase()}.`}
              </p>
            ) : (
              <div className="usage__table" role="region" aria-label="Tokens by agent table" tabIndex={0}>
                <table className="table" data-testid="usage-agents">
                  <caption className="sr-only">Tokens by agent, {rangeLabel.toLowerCase()}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col" className="num">
                        Runs
                      </th>
                      {COLUMNS.map((c) => (
                        <th key={c.key} scope="col" className="num">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => (
                      <tr key={a.agent} data-agent={a.agent}>
                        <th scope="row">{AGENT_NAMES[a.agent]}</th>
                        <td className="num">
                          {a.runs}
                          {a.reported && a.reported < a.runs ? <span className="usage__sub">{a.runs - a.reported} not reported</span> : null}
                        </td>
                        <TokenCells usage={a.usage} total={a.total} />
                      </tr>
                    ))}
                  </tbody>
                  {agents.length > 1 ? (
                    <tfoot>
                      <tr>
                        <th scope="row">All agents</th>
                        <td className="num">{totals.runs}</td>
                        <TokenCells usage={totals.usage} total={totals.total} />
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
            )}
          </section>

          {rows.length ? (
            <section aria-labelledby={runsHead}>
              <h2 id={runsHead} className="usage__heading">
                Tokens by run
              </h2>
              <div className="usage__table" role="region" aria-label="Tokens by run table" tabIndex={0}>
                <table className="table" data-testid="usage-runs">
                  <caption className="sr-only">Tokens by run, {rangeLabel.toLowerCase()}. Runs that didn't report a column sort last.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">Updated</th>
                      {COLUMNS.map((c) => header(c.key, c.label))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(({ run, usage, total }) => (
                      <tr key={run.id} data-run-id={run.id}>
                        <td className="usage__runcell">
                          <button type="button" className="usage__run" onClick={() => openRunWithDefaultView(run.id)}>
                            <span className="runrow__title" data-untitled={run.title ? undefined : ''}>
                              {run.title || 'Untitled run'}
                            </span>
                            <span className="runrow__meta">
                              <span>{AGENT_NAMES[run.agent]}</span>
                              <span className="dot-sep" aria-hidden="true" />
                              <span>{run.projectName}</span>
                            </span>
                          </button>
                        </td>
                        <td className="usage__time">{rowTime(run.updatedAt, timeFormat, now)}</td>
                        <TokenCells usage={usage} total={total} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <div className="usage__notes muted" data-testid="usage-notes">
            <p>
              Counts are exactly what each agent recorded; nothing is estimated. Where an agent records the prompt cache separately,
              Input leaves it out and Cache read and Cache write show it.
            </p>
            {range !== 'all' ? (
              <p>Tokens count on the day their message was recorded, or on the day the run was last updated when the agent doesn't record that.</p>
            ) : null}
            {clipped ? (
              <p data-testid="usage-history-note">
                Only runs from the last {historyLabel(historyDays)} are loaded (Settings, How far back to show runs), so older usage isn't
                counted.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
