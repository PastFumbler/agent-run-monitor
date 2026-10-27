// Electron main process: one sandboxed window, the RunStore, settings, and OS integration.
//
// Test and demo switches (environment):
//   ARM_USER_DATA    use this folder for settings and window state instead of the OS default
//   ARM_HOME         look for agent sessions under this home folder (see core/env.ts)
//   ARM_OPEN_LAYOUT  the renderer opens this saved layout on start (appInfo().startup.openLayout)
//   ARM_E2E=1        end-to-end tests: no OS notifications, no login-item changes

import { app, BrowserWindow, dialog, Menu, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, type AppInfo, type RunFinishedNotice } from '@shared/ipc';
import { applyFolderOp, type FolderResult } from '@shared/folders';
import type { Settings, ThemeId } from '@shared/settings';
import { ALL_ADAPTERS } from '@core/all-adapters';
import { makeEnv } from '@core/env';
import { createRegistry } from '@core/registry';
import { RunStore } from '@core/store';
import { DEFAULT_WINDOW, loadWindowState, saveWindowState, SettingsFile, type WindowState } from './files';
import { mergeSettings, registerIpc } from './ipc';
import { blockedRequests, contentSecurityPolicy, hardenSession, installGlobalGuards, serveAppFiles } from './security';
import { applyAutostart, checkForUpdate, powerState, shouldNotify, showNotice, watchPower } from './system';

const log = (msg: string) => process.stderr.write(`[arm] ${msg}\n`);

// ---- before ready ------------------------------------------------------------------------------

const userDataOverride = process.env.ARM_USER_DATA?.trim();
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

const E2E = process.env.ARM_E2E === '1';
const OPEN_LAYOUT = process.env.ARM_OPEN_LAYOUT?.trim().slice(0, 80) || undefined;
const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : undefined;
const HERE = import.meta.dirname;
const RENDERER_DIR = path.join(HERE, '../renderer');

app.enableSandbox();
// No proxy auto-discovery (WPAD over DHCP/DNS) anywhere: the window only loads local files. The
// opt-in update check uses its own session, which turns system proxy settings back on.
app.commandLine.appendSwitch('no-proxy-server');
if (process.platform === 'win32') app.setAppUserModelId('io.github.agentrunmonitor');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  installGlobalGuards({ devOrigin: DEV_ORIGIN, log });
  app.on('second-instance', () => focusWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!win && ready) void createWindow();
  });
  app.whenReady().then(main, (e) => {
    log(`failed to start: ${String(e)}`);
    app.exit(1);
  });
}

process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.stack ?? e}`));

// ---- state ---------------------------------------------------------------------------------------

let win: BrowserWindow | null = null;
let ready = false;
let settings: Settings;
// Settings changes run one at a time, so a folder change and a settings patch never read the same
// old settings and overwrite each other.
let settingsChain: Promise<unknown> = Promise.resolve();
function serialSettings<T>(fn: () => Promise<T>): Promise<T> {
  const run = settingsChain.then(fn, fn);
  settingsChain = run.catch(() => undefined);
  return run;
}
let settingsFile: SettingsFile;
let store: RunStore;
let tempDir = '';
let rendererInterval = 250;
let visible = true;
const env = makeEnv();

const BACKGROUNDS: Record<ThemeId, string> = {
  paper: '#f6f4ef',
  sage: '#eef2ec',
  dawn: '#f8f1ec',
  dusk: '#1f2230',
  moss: '#1c231f',
  harbor: '#1a2129',
};

function send(channel: string, payload: unknown): void {
  const wc = win?.webContents;
  if (!wc || wc.isDestroyed() || wc.isLoading()) return;
  wc.send(channel, payload);
}

function focusWindow(): void {
  if (!win) {
    if (ready) void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- main ----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  settingsFile = new SettingsFile(userData);
  const loaded = await settingsFile.load();
  settings = loaded.settings;
  if (loaded.error) log(`settings file was damaged, using defaults: ${loaded.error}`);

  hardenSession(session.defaultSession, { devOrigin: DEV_ORIGIN, log });
  if (!DEV_URL) serveAppFiles(session.defaultSession, RENDERER_DIR, contentSecurityPolicy());
  buildMenu();

  tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-run-monitor-'));
  const registry = createRegistry(ALL_ADAPTERS, log);
  if (registry.all().length === 0) log('no source adapters are registered in this build');
  store = new RunStore({ adapters: registry.all(), env, tempDir, log: (_l, m) => log(m) });
  store.setUpdateInterval(rendererInterval);
  store.on('runsUpdate', (u) => send(IPC.evRunsUpdate, u));
  // One message per flush however many watched runs changed (the preload fans it out).
  store.on('runDetails', (ds) => send(IPC.evRunDetails, ds));
  store.on('runFinished', (n) => onRunFinished(n));

  registerIpc(
    {
      appInfo: (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
        settingsPath: settingsFile.path,
        startup: { openLayout: OPEN_LAYOUT, e2e: E2E },
      }),
      getSettings: () => settings,
      setSettings: (patch) =>
        serialSettings(async () => {
          const prev = settings;
          const next = mergeSettings(prev, patch);
          await settingsFile.save(next);
          settings = next;
          await store.updateSettings(next);
          if (prev.startWithOs !== next.startWithOs && !E2E) {
            await applyAutostart(next.startWithOs, env, log).catch((e) => log(`autostart: ${String(e)}`));
          }
          return next;
        }),
      // Folders are app-owned data in the settings file; agent files are never touched. Nothing the
      // store watches changes, so the store is not told.
      editFolders: (op) =>
        serialSettings(async (): Promise<FolderResult> => {
          const r = applyFolderOp(settings, op);
          if (r.error) return r;
          await settingsFile.save(r.settings);
          settings = r.settings;
          return r;
        }),
      listRuns: () => store.listRuns(),
      getRun: (id, limit) => store.getDetail(id, limit),
      getSources: (rescan) => store.getSources(rescan),
      pickFolder: async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Choose a folder with agent sessions',
          properties: ['openDirectory', 'showHiddenFiles', 'dontAddToRecent'],
        };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
      },
      revealSource: async (id) => {
        const ref = store.getRef(id);
        if (ref) shell.showItemInFolder(ref.path);
      },
      getPower: () => powerState(),
      checkForUpdate: () => checkForUpdate(app.getVersion(), settings.checkForUpdates),
      watchRuns: (ids) => store.watchRuns(ids),
      setUpdateInterval: (ms) => {
        rendererInterval = ms;
        store.setUpdateInterval(ms);
      },
      setWatchPriority: (focused, slowMs) => store.setWatchPriority(focused, slowMs),
    },
    { window: () => win?.webContents, devOrigin: DEV_ORIGIN, log },
  );

  watchPower((p) => send(IPC.evPower, p));

  ready = true;
  await createWindow();
  // Discovery starts after the window exists so the first paint is not held up.
  void store.start(settings).catch((e) => log(`store failed to start: ${String(e)}`));
  if (settings.startWithOs && !E2E) void applyAutostart(true, env, log).catch(() => {});
}

function onRunFinished(n: RunFinishedNotice): void {
  send(IPC.evRunFinished, n);
  if (E2E) return;
  if (win?.isFocused()) return; // the user is looking at the app already
  if (!shouldNotify(n, settings, Date.now())) return;
  showNotice(n, (id) => {
    focusWindow();
    send(IPC.evOpenRun, id);
  });
}

// ---- window --------------------------------------------------------------------------------------

function onScreen(s: WindowState): WindowState {
  if (s.x === undefined || s.y === undefined) return { ...s, x: undefined, y: undefined };
  const visibleArea = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x! + 80 > a.x && s.x! < a.x + a.width - 80 && s.y! >= a.y - 10 && s.y! < a.y + a.height - 60;
  });
  return visibleArea ? s : { ...s, x: undefined, y: undefined };
}

async function createWindow(): Promise<void> {
  const userData = app.getPath('userData');
  const state = onScreen(await loadWindowState(userData).catch(() => ({ ...DEFAULT_WINDOW })));
  const w = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Agent Run Monitor',
    backgroundColor: BACKGROUNDS[settings.theme] ?? BACKGROUNDS.paper,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: true,
      devTools: !app.isPackaged,
    },
  });
  win = w;
  w.webContents.setBackgroundThrottling(true);
  if (state.maximized) w.maximize();
  w.once('ready-to-show', () => w.show());

  // Visibility: the renderer pauses animation, the store batches every 5 s while hidden.
  const setVisible = (v: boolean) => {
    if (v === visible) return;
    visible = v;
    store.setHidden(!v);
    send(IPC.evVisibility, v);
  };
  w.on('minimize', () => setVisible(false));
  w.on('hide', () => setVisible(false));
  w.on('restore', () => setVisible(true));
  w.on('show', () => setVisible(!w.isMinimized()));
  w.on('focus', () => setVisible(true));

  // A renderer that (re)loads gets the whole list again.
  w.webContents.on('did-finish-load', () => {
    store?.requestFull();
    send(IPC.evVisibility, visible);
  });
  w.webContents.on('render-process-gone', (_e, d) => log(`renderer exited: ${d.reason}`));

  let saveTimer: NodeJS.Timeout | undefined;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized()) return;
      const b = w.getNormalBounds();
      void saveWindowState(userData, { ...b, maximized: w.isMaximized() }).catch(() => {});
    }, 500);
  };
  w.on('resize', rememberBounds);
  w.on('move', rememberBounds);
  w.on('maximize', rememberBounds);
  w.on('unmaximize', rememberBounds);
  w.on('close', () => {
    clearTimeout(saveTimer);
    if (!w.isMinimized()) {
      const b = w.getNormalBounds();
      void saveWindowState(userData, { ...b, maximized: w.isMaximized() }).catch(() => {});
    }
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });

  if (DEV_URL) await w.loadURL(DEV_URL);
  else await w.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

function buildMenu(): void {
  const dev = !app.isPackaged;
  if (process.platform === 'darwin') {
    const template: MenuItemConstructorOptions[] = [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
    if (dev) template.push({ role: 'viewMenu' });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }
  // No menu in production: nothing to reload the page or open developer tools.
  Menu.setApplicationMenu(dev ? Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }]) : null);
}

// ---- shutdown ------------------------------------------------------------------------------------

app.on('will-quit', () => {
  void store?.stop();
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* the OS cleans its temp folder eventually */
    }
  }
  const blocked = blockedRequests();
  if (blocked) log(`network guard blocked ${blocked} request(s) this session`);
});
