// The only bridge between the sandboxed renderer and main: window.armBackend, a typed Backend
// over IPC. Raw ipcRenderer is never exposed; each method maps to one fixed channel.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type Backend, type Unsubscribe } from '@shared/ipc';

function subscribe<T>(channel: string) {
  return (cb: (value: T) => void): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const backend: Backend = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  listRuns: () => ipcRenderer.invoke(IPC.listRuns),
  getRun: (id, limit) => ipcRenderer.invoke(IPC.getRun, id, limit),
  getSources: (rescan) => ipcRenderer.invoke(IPC.getSources, rescan === true),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  revealSource: (id) => ipcRenderer.invoke(IPC.revealSource, id),
  getPower: () => ipcRenderer.invoke(IPC.getPower),
  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),

  onRunsUpdate: subscribe(IPC.evRunsUpdate),
  onRunDetail: subscribe(IPC.evRunDetail),
  onPower: subscribe(IPC.evPower),
  onRunFinished: subscribe(IPC.evRunFinished),
  onWindowVisibility: subscribe(IPC.evVisibility),
  onOpenRun: subscribe(IPC.evOpenRun),

  watchRuns: (ids) => ipcRenderer.send(IPC.watchRuns, ids),
  setUpdateInterval: (ms) => ipcRenderer.send(IPC.setUpdateInterval, ms),
};

contextBridge.exposeInMainWorld('armBackend', backend);
