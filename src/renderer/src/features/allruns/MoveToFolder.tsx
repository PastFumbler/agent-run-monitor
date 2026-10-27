// "Move to folder" for the run list viewer: pick a folder (or Unfiled), or create one and move there.
// Only the app's own settings change (src/shared/folders.ts); agent files are never touched.

import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { cleanFolderName, MAX_FOLDER_NAME } from '@shared/folders';
import { Modal } from '../../components/Modal';
import { createFolder, moveRunsToFolder } from '../../store/actions';
import { useStore } from '../../store/store';
import { KeyFence } from '../multiview/dialogs';

const runsText = (n: number) => (n === 1 ? '1 run' : `${n} runs`);

export function MoveToFolderDialog({ runIds, onClose, onMoved }: { runIds: string[]; onClose(): void; onMoved(message: string): void }) {
  const folders = useStore((s) => s.settings.folders);
  const runFolders = useStore((s) => s.settings.runFolders);
  const runs = useStore((s) => s.runs);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const what = runsText(runIds.length);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const [id, f] of Object.entries(runFolders)) if (runs[id]) c[f] = (c[f] ?? 0) + 1;
    return c;
  }, [runFolders, runs]);
  // The folder every picked run is already in ('' = all unfiled), or null when they differ.
  const current = useMemo(() => {
    const set = new Set(runIds.map((id) => runFolders[id] ?? ''));
    return set.size === 1 ? [...set][0] : null;
  }, [runIds, runFolders]);

  const move = async (folderId: string | null, label: string) => {
    setBusy(true);
    setError('');
    const r = await moveRunsToFolder(runIds, folderId);
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    onMoved(folderId ? `Moved ${what} to ${label}.` : `Moved ${what} to Unfiled.`);
  };

  const createAndMove = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await createFolder(name);
    if (r.error || !r.folderId) {
      setBusy(false);
      setError(r.error ?? "Couldn't create that folder. Try again.");
      return;
    }
    await move(r.folderId, r.settings.folders.find((f) => f.id === r.folderId)?.name ?? cleanFolderName(name));
  };

  const options = [
    { id: null, name: 'Unfiled', desc: 'Not in any folder', isCurrent: current === '' },
    ...folders.map((f) => ({ id: f.id, name: f.name, desc: runsText(counts[f.id] ?? 0), isCurrent: current === f.id })),
  ];

  return (
    <Modal title={`Move ${what} to a folder`} onClose={onClose} className="mv-dialog" initialFocus={() => listRef.current?.querySelector<HTMLElement>('button:not([disabled])') ?? null}>
      <KeyFence>
        <div className="dialog__body allruns-move">
          <ul ref={listRef} className="mv-layouts" aria-label="Folders">
            {options.map((o) => (
              <li key={o.id ?? ''} className="mv-layouts__item" data-folder-id={o.id ?? 'unfiled'}>
                <div className="mv-layouts__text">
                  <span className="mv-layouts__name">{o.name}</span>
                  <span className="muted">
                    {o.desc}
                    {o.isCurrent ? ' · already here' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || o.isCurrent}
                  aria-label={`Move to ${o.name}`}
                  onClick={() => void move(o.id, o.name)}
                >
                  Move here
                </button>
              </li>
            ))}
          </ul>
          <form className="mv-form allruns-move__new" onSubmit={createAndMove}>
            <label htmlFor={inputId}>New folder</label>
            <div className="allruns-move__row">
              <input
                id={inputId}
                className="input"
                value={name}
                maxLength={MAX_FOLDER_NAME}
                onChange={(e) => {
                  setName(e.target.value);
                  setError('');
                }}
                placeholder="e.g. Client work"
                autoComplete="off"
              />
              <button type="submit" className="btn btn--primary" disabled={busy || !cleanFolderName(name)}>
                Create and move
              </button>
            </div>
          </form>
          {error ? (
            <p role="alert" className="mv-form__error">
              {error}
            </p>
          ) : null}
        </div>
      </KeyFence>
    </Modal>
  );
}
