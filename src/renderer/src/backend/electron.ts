// The desktop backend: a thin wrapper over what the preload script exposes on window.armBackend
// (contextBridge, typed by the Backend interface in src/shared/ipc.ts). The renderer never touches
// ipcRenderer or Node itself.

import type { Backend } from '@shared/ipc';

declare global {
  interface Window {
    armBackend?: Backend;
  }
}

export class ElectronBackend implements Backend {
  constructor(private readonly bridge: Backend) {}

  appInfo = () => this.bridge.appInfo();
  getSettings = () => this.bridge.getSettings();
  setSettings: Backend['setSettings'] = (patch) => this.bridge.setSettings(patch);
  listRuns = () => this.bridge.listRuns();
  getRun: Backend['getRun'] = (id, limit) => this.bridge.getRun(id, limit);
  getSources: Backend['getSources'] = (rescan) => this.bridge.getSources(rescan);
  pickFolder = () => this.bridge.pickFolder();
  revealSource: Backend['revealSource'] = (id) => this.bridge.revealSource(id);
  getPower = () => this.bridge.getPower();
  checkForUpdate = () => this.bridge.checkForUpdate();
  onRunsUpdate: Backend['onRunsUpdate'] = (cb) => this.bridge.onRunsUpdate(cb);
  onRunDetail: Backend['onRunDetail'] = (cb) => this.bridge.onRunDetail(cb);
  onPower: Backend['onPower'] = (cb) => this.bridge.onPower(cb);
  onRunFinished: Backend['onRunFinished'] = (cb) => this.bridge.onRunFinished(cb);
  onWindowVisibility: Backend['onWindowVisibility'] = (cb) => this.bridge.onWindowVisibility(cb);
  /** Optional in the interface: older preloads may not have it. */
  onOpenRun: NonNullable<Backend['onOpenRun']> = (cb) => this.bridge.onOpenRun?.(cb) ?? (() => {});
  watchRuns: Backend['watchRuns'] = (ids) => this.bridge.watchRuns(ids);
  setUpdateInterval: Backend['setUpdateInterval'] = (ms) => this.bridge.setUpdateInterval(ms);
}
