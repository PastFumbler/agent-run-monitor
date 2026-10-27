// The only bridge between the sandboxed renderer and main: window.armBackend, a typed Backend
// over IPC. Raw ipcRenderer is never exposed; each method maps to one fixed channel.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type Backend, type Unsubscribe } from '@shared/ipc';
import type { RunDetail } from '@shared/schema';

function subscribe<T>(channel: string) {
  return (cb: (value: T) => void): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

/**
 * Main sends every run detail of one flush as one message (fewer IPC hops with many live tiles);
 * the renderer's API stays one callback per detail.
 */
function subscribeDetails(cb: (d: RunDetail) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, batch: unknown) => {
    if (!Array.isArray(batch)) return;
    for (const d of batch as RunDetail[]) cb(d);
  };
  ipcRenderer.on(IPC.evRunDetails, listener);
  return () => {
    ipcRenderer.removeListener(IPC.evRunDetails, listener);
  };
}

const backend: Backend = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  editFolders: (op) => ipcRenderer.invoke(IPC.editFolders, op),
  listRuns: () => ipcRenderer.invoke(IPC.listRuns),
  getRun: (id, limit) => ipcRenderer.invoke(IPC.getRun, id, limit),
  getSources: (rescan) => ipcRenderer.invoke(IPC.getSources, rescan === true),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  revealSource: (id) => ipcRenderer.invoke(IPC.revealSource, id),
  getPower: () => ipcRenderer.invoke(IPC.getPower),
  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),

  onRunsUpdate: subscribe(IPC.evRunsUpdate),
  onRunDetail: subscribeDetails,
  onPower: subscribe(IPC.evPower),
  onRunFinished: subscribe(IPC.evRunFinished),
  onWindowVisibility: subscribe(IPC.evVisibility),
  onOpenRun: subscribe(IPC.evOpenRun),

  watchRuns: (ids) => ipcRenderer.send(IPC.watchRuns, ids),
  setUpdateInterval: (ms) => ipcRenderer.send(IPC.setUpdateInterval, ms),
  setWatchPriority: (focused, slowMs) => ipcRenderer.send(IPC.setWatchPriority, focused, slowMs),
};

contextBridge.exposeInMainWorld('armBackend', backend);
