// Settings > Sources: one card per agent (switch, confidence badge with plain words, default places
// with found/not-there marks, custom folders, run count, adapter note), the Aider project folders and
// a Rescan button.

import { useState } from 'react';
import { Alert02Icon, CheckmarkBadge01Icon, RefreshIcon, SourceCodeIcon, TestTubeIcon } from '@hugeicons/core-free-icons';
import type { SourceStatus } from '@shared/schema';
import { Icon } from '../../components/Icon';
import { useStore } from '../../store/store';
import { FolderList, PathMark, SwitchRow } from './controls';
import { CONFIDENCE, plural, type Confidence } from './describe';
import { addCustomRoot, addProjectRoot, removeCustomRoot, removeProjectRoot, setSourceEnabled, useSources } from './sourceActions';

const CONFIDENCE_ICON = { verified: CheckmarkBadge01Icon, source: SourceCodeIcon, 'best-effort': TestTubeIcon } as const;

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const c = CONFIDENCE[confidence];
  return (
    <span className="confidence" data-confidence={confidence} title={c.explain}>
      <Icon icon={CONFIDENCE_ICON[confidence]} size={13} />
      {c.label}
    </span>
  );
}

function SourceCard({ s }: { s: SourceStatus }) {
  const settings = useStore((st) => st.settings.sources[s.agent]);
  const enabled = settings?.enabled ?? s.enabled;
  const custom = settings?.customRoots ?? s.customRoots.map((r) => r.path);
  const customExists = (p: string) => s.customRoots.find((r) => r.path === p)?.exists;
  return (
    <li className="source card" data-agent={s.agent} data-enabled={enabled ? 'yes' : 'no'}>
      <SwitchRow
        label={`Watch ${s.displayName}`}
        checked={enabled}
        onChange={(v) => void setSourceEnabled(s.agent, v)}
        description={
          <>
            <ConfidenceBadge confidence={s.confidence} /> <span>{CONFIDENCE[s.confidence].explain}.</span>{' '}
            <span className="source__count">{enabled ? plural(s.runCount, 'run') : `${plural(s.runCount, 'run')} (hidden while off)`}</span>
          </>
        }
      />
      <div className="source__body">
        <p className="source__note">{s.note}</p>
        {s.error ? (
          <p className="source__error" role="note">
            <Icon icon={Alert02Icon} size={13} /> {s.error}
          </p>
        ) : null}
        <div className="source__paths">
          <span className="source__label">Where it looks</span>
          <ul className="folders__list" aria-label={`Default places for ${s.displayName}`}>
            {s.defaultRoots.map((r) => (
              <li key={r.path} className="folders__item">
                <span className="path mono" title={r.path}>
                  {r.path}
                </span>
                <PathMark exists={r.exists} />
              </li>
            ))}
          </ul>
        </div>
        <div className="source__paths">
          <span className="source__label">Your extra folders</span>
          <FolderList
            folders={custom}
            listLabel={`Extra folders for ${s.displayName}`}
            exists={customExists}
            onAdd={() => void addCustomRoot(s.agent)}
            onRemove={(p) => void removeCustomRoot(s.agent, p)}
            addLabel="Add folder"
            addName={`Add folder for ${s.displayName}`}
            empty="None. Add one if this agent keeps its sessions somewhere unusual."
          />
        </div>
      </div>
    </li>
  );
}

export function SourcesSection() {
  const { list, scanning, error, rescan } = useSources(false);
  const projectRoots = useStore((s) => s.settings.projectRoots);
  const [scanned, setScanned] = useState(false);
  return (
    <>
      <div className="settings__toolbar">
        <p className="setting-row__desc">
          Each agent writes its sessions to its own folder. Switch off the ones you don't want to see. Nothing in these folders is
          ever changed.
        </p>
        <button
          type="button"
          className="btn"
          disabled={scanning}
          onClick={() => {
            setScanned(false);
            void rescan().then(() => setScanned(true));
          }}
        >
          <Icon icon={RefreshIcon} size={14} />
          {scanning ? 'Looking…' : 'Rescan'}
        </button>
      </div>
      <p className="sr-only" role="status">
        {scanning ? 'Looking for agents…' : scanned ? 'Rescan finished.' : ''}
      </p>
      {scanned && !scanning ? <p className="settings__note">Rescan finished: the list below is up to date.</p> : null}
      {error ? <p className="source__error">{error}</p> : null}
      {!list ? (
        <p className="muted">Looking for agents…</p>
      ) : (
        <ul className="sources" aria-label="Agents">
          {list.map((s) => (
            <SourceCard key={s.agent} s={s} />
          ))}
        </ul>
      )}
      <div className="card setting-group" data-testid="project-folders">
        <h3 className="setting-row__label">Project folders</h3>
        <p className="setting-row__desc">
          Aider keeps its history inside each project (a <code>.aider.chat.history.md</code> file) instead of one central folder.
          Add the folders that hold your projects and they are searched a few levels deep.
        </p>
        <FolderList
          folders={projectRoots}
          listLabel="Project folders"
          onAdd={() => void addProjectRoot()}
          onRemove={(p) => void removeProjectRoot(p)}
          addLabel="Add project folder"
          empty="No project folders yet."
        />
      </div>
    </>
  );
}
