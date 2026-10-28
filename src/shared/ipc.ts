// The one interface between the renderer and whatever supplies runs. In the desktop app it is
// implemented over Electron IPC (preload exposes window.armBackend); in tests, the browser demo
// and screenshot scripts it is the FixtureBackend. The renderer must not depend on anything else.

import type { AiProvider, AiStatus, AiSummaryResult } from './ai';
import type { AgentId, RunDetail, RunSummary, SourceStatus } from './schema';
import type { FolderOp, FolderResult } from './folders';
import type { Settings } from './settings';

export interface PowerState {
  onBattery: boolean;
  /** OS energy/battery-saver mode, when the platform reports it. */
  powerSaver: boolean;
  /** False when the platform could not tell us (Auto then stays off). */
  known: boolean;
}

/** Pushed by the backend. Batched: one message carries every change since the last. */
export interface RunsUpdate {
  /** Runs added or changed since the last update. */
  upserts: RunSummary[];
  /** Runs that disappeared (file deleted, or fell out of the history window). */
  removed: string[];
  /** True for the first, complete list. */
  full: boolean;
  /**
   * Initial-load progress: runs summarised so far out of runs found. The first (full) update may
   * arrive before everything is parsed; later updates fill in the rest until parsed === total.
   */
  progress?: { parsed: number; total: number };
}

export interface RunFinishedNotice {
  run: RunSummary;
  outcome: 'done' | 'failed' | 'waiting' | 'stuck';
}

export interface UpdateInfo {
  current: string;
  latest?: string;
  url?: string;
  error?: string;
}

export interface AppInfo {
  version: string;
  platform: 'win32' | 'darwin' | 'linux' | 'web';
  /** Where settings are stored, for the Settings > About section. */
  settingsPath: string;
  /** How the app was launched (test and demo switches). Absent in the browser demo. */
  startup?: StartupOptions;
}

export interface StartupOptions {
  /** ARM_OPEN_LAYOUT: the saved layout (by name) the renderer should open on start. */
  openLayout?: string;
  /** ARM_E2E=1: running under the end-to-end tests. */
  e2e?: boolean;
}

export type Unsubscribe = () => void;

export interface Backend {
  appInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  /** Saves and returns the normalised result. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /**
   * Creates, renames or deletes a run folder, or moves runs into one (or back to Unfiled). Applied
   * in the backend so changes never race; the result carries the saved settings and, when the
   * change was refused, a plain-words error.
   */
  editFolders(op: FolderOp): Promise<FolderResult>;
  listRuns(): Promise<RunSummary[]>;
  /** The newest `limit` events (default 2000) plus files and tools. */
  getRun(id: string, limit?: number): Promise<RunDetail | null>;
  /** Detected sources, for the wizard and settings. Re-scans when `rescan`. */
  getSources(rescan?: boolean): Promise<SourceStatus[]>;
  /** Native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Opens the folder holding a run's source file in the OS file manager. */
  revealSource(id: string): Promise<void>;
  getPower(): Promise<PowerState>;
  checkForUpdate(): Promise<UpdateInfo>;
  /** Which providers have an API key saved (never the key itself), and whether storage is encrypted. */
  aiStatus(): Promise<AiStatus>;
  /** Saves the API key for a provider in main (null removes it). The key never comes back. */
  setAiKey(provider: AiProvider, key: string | null): Promise<AiStatus>;
  /**
   * The AI summary of a run, asked of the chosen provider from main with masked run text, or a saved
   * one for the same run content. Only when AI summaries are on; failures come back as `error`.
   */
  summarizeRun(id: string): Promise<AiSummaryResult>;

  onRunsUpdate(cb: (u: RunsUpdate) => void): Unsubscribe;
  /** Detail for a run the renderer has subscribed to changed. */
  onRunDetail(cb: (d: RunDetail) => void): Unsubscribe;
  onPower(cb: (p: PowerState) => void): Unsubscribe;
  onRunFinished(cb: (n: RunFinishedNotice) => void): Unsubscribe;
  /** Main tells the renderer when the window is hidden/minimised (in addition to visibilitychange). */
  onWindowVisibility(cb: (visible: boolean) => void): Unsubscribe;
  /** The user clicked a finish notification: show this run. Optional (the fixture backend has none). */
  onOpenRun?(cb: (id: string) => void): Unsubscribe;

  /** Runs whose detail should be pushed live (the open run and visible tiles). */
  watchRuns(ids: string[]): void;
  /** Throttle hint from the renderer's motion/perf policy: minimum ms between pushes. */
  setUpdateInterval(ms: number): void;
  /**
   * Optional priority among the watched runs (multiviewer in low GPU mode): runs in `focused`
   * get detail pushes at the normal interval; other watched runs at most every `slowMs`.
   * Calling it with an empty `focused` and slowMs 0 clears the priority. Optional so the
   * fixture backend and older builds need not implement it.
   */
  setWatchPriority?(focused: string[], slowMs: number): void;
}

export const IPC = {
  appInfo: 'arm:appInfo',
  getSettings: 'arm:getSettings',
  setSettings: 'arm:setSettings',
  editFolders: 'arm:editFolders',
  listRuns: 'arm:listRuns',
  getRun: 'arm:getRun',
  getSources: 'arm:getSources',
  pickFolder: 'arm:pickFolder',
  revealSource: 'arm:revealSource',
  getPower: 'arm:getPower',
  checkForUpdate: 'arm:checkForUpdate',
  aiStatus: 'arm:aiStatus',
  setAiKey: 'arm:setAiKey',
  summarizeRun: 'arm:summarizeRun',
  watchRuns: 'arm:watchRuns',
  setUpdateInterval: 'arm:setUpdateInterval',
  setWatchPriority: 'arm:setWatchPriority',
  evRunsUpdate: 'arm:ev:runsUpdate',
  evRunDetail: 'arm:ev:runDetail',
  /** Every run detail of one store flush as one message (RunDetail[]); preload fans it out to onRunDetail. */
  evRunDetails: 'arm:ev:runDetails',
  evPower: 'arm:ev:power',
  evRunFinished: 'arm:ev:runFinished',
  evVisibility: 'arm:ev:visibility',
  evOpenRun: 'arm:ev:openRun',
} as const;

export type { AgentId };
