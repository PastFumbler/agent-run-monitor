// Settings > Folders: create, rename and delete run folders. Folders are app-owned data in the
// settings file (src/shared/folders.ts); agent files are never touched. Deleting a folder returns its
// runs to Unfiled. Moving runs into folders happens in All runs (features/allruns).
// Rename and delete confirm inline; Esc in the rename field cancels instead of leaving settings.

import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Cancel01Icon, Delete02Icon, FolderAddIcon, PencilEdit01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { folderCounts, MAX_FOLDER_NAME, type RunFolder } from '@shared/folders';
import { Icon } from '../../components/Icon';
import { createFolder, deleteFolder, renameFolder } from '../../store/actions';
import { useStore } from '../../store/store';

const runsText = (n: number) => (n === 1 ? '1 run' : `${n} runs`);

/** Focus an element after React has re-rendered (the control that had focus may be gone). */
function focusSoon(find: () => HTMLElement | null) {
  requestAnimationFrame(() => find()?.focus());
}
const folderButton = (id: string, action: 'rename' | 'delete') => () =>
  document.querySelector<HTMLElement>(`[data-folder-id="${id}"] [data-action="${action}"]`);

export function FoldersSection() {
  const folders = useStore((s) => s.settings.folders);
  const runFolders = useStore((s) => s.settings.runFolders);
  const counts = useMemo(() => folderCounts({ runFolders }), [runFolders]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const uid = useId();
  const keep = (id: string) => {
    setConfirming(null);
    focusSoon(folderButton(id, 'delete'));
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await createFolder(name);
    if (r.error) {
      setMessage(r.error);
      return;
    }
    setMessage(`Created "${r.settings.folders.find((f) => f.id === r.folderId)?.name ?? name.trim()}".`);
    setName('');
  };

  return (
    <div className="card setting-group" data-testid="folders-settings">
      <p className="setting-row__desc">
        Group runs by project or client. Folders are kept in this app's own settings; agent files are never changed. Deleting a
        folder never deletes runs: they go back to Unfiled.
      </p>
      <div className="folders">
        {folders.length ? (
          <ul className="folders__list" aria-label="Run folders">
            {folders.map((f) =>
              editing === f.id ? (
                <RenameRow
                  key={f.id}
                  folder={f}
                  onDone={(msg) => {
                    setEditing(null);
                    setMessage(msg);
                    focusSoon(folderButton(f.id, 'rename'));
                  }}
                  onError={setMessage}
                />
              ) : (
                <li key={f.id} className="folders__item" data-folder-id={f.id}>
                  <span className="run-folder__name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="muted run-folder__count">{runsText(counts.get(f.id) ?? 0)}</span>
                  {confirming === f.id ? (
                    <span
                      className="run-folder__confirm"
                      role="group"
                      aria-label={`Delete ${f.name}?`}
                      onKeyDown={(e) => {
                        // Esc keeps the folder (and stays on the settings screen).
                        if (e.key !== 'Escape') return;
                        e.preventDefault();
                        keep(f.id);
                      }}
                    >
                      <span className="run-folder__question">
                        {counts.get(f.id) ? `Delete? Its ${runsText(counts.get(f.id) ?? 0)} go back to Unfiled.` : 'Delete?'}
                      </span>
                      <button
                        type="button"
                        className="btn btn--small"
                        autoFocus
                        onClick={async () => {
                          setConfirming(null);
                          const r = await deleteFolder(f.id);
                          setMessage(r.error ?? `Deleted "${f.name}". Its runs are unfiled.`);
                          focusSoon(() => document.getElementById(`${uid}-new`));
                        }}
                      >
                        <Icon icon={Delete02Icon} size={14} />
                        Delete folder
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => keep(f.id)}
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        data-action="rename"
                        aria-label={`Rename ${f.name}`}
                        onClick={() => {
                          setConfirming(null);
                          setEditing(f.id);
                        }}
                      >
                        <Icon icon={PencilEdit01Icon} size={14} />
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        data-action="delete"
                        aria-label={`Delete ${f.name}`}
                        onClick={() => {
                          setEditing(null);
                          setConfirming(f.id);
                        }}
                      >
                        <Icon icon={Delete02Icon} size={14} />
                        Delete
                      </button>
                    </>
                  )}
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="folders__empty">No folders yet.</p>
        )}
        <form className="run-folder__form" onSubmit={create}>
          <label className="sr-only" htmlFor={`${uid}-new`}>
            New folder name
          </label>
          <input
            id={`${uid}-new`}
            className="input"
            placeholder="New folder name"
            maxLength={MAX_FOLDER_NAME}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn--small" disabled={!name.trim()}>
            <Icon icon={FolderAddIcon} size={14} />
            Create folder
          </button>
        </form>
        <p className="folders__empty" role="status" data-testid="folders-message">
          {message}
        </p>
      </div>
    </div>
  );
}

function RenameRow({ folder, onDone, onError }: { folder: RunFolder; onDone(msg: string): void; onError(msg: string): void }) {
  const [value, setValue] = useState(folder.name);
  const id = useId();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (value.trim() === folder.name) return onDone('');
    const r = await renameFolder(folder.id, value);
    if (r.error) onError(r.error);
    else onDone(`Renamed to "${r.settings.folders.find((f) => f.id === folder.id)?.name ?? value}".`);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Handled here: the app's Esc would otherwise leave the settings screen.
    e.preventDefault();
    onDone('');
  };
  return (
    <li className="folders__item" data-folder-id={folder.id}>
      <form className="run-folder__form" onSubmit={save} onKeyDown={onKeyDown}>
        <label className="sr-only" htmlFor={id}>
          New name for {folder.name}
        </label>
        <input id={id} className="input" autoFocus maxLength={MAX_FOLDER_NAME} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="btn btn--small" disabled={!value.trim()}>
          <Icon icon={Tick02Icon} size={14} />
          Save
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => onDone('')}>
          <Icon icon={Cancel01Icon} size={14} />
          Cancel
        </button>
      </form>
    </li>
  );
}
