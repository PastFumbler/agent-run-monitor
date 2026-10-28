// RunStore: the live backend behind the run list. Pure Node (no Electron), so it runs the same in
// the app and in unit tests with fake adapters and a fake clock.
//
//   discover (stat only) ─▶ entries ─▶ parse queue (newest first, 4 at a time) ─▶ summaries
//        ▲                                    ▲                                       │
//   slow poll + chokidar events          dirty refs (incremental, prev state)        ▼
//                                     status clock (re-judges live runs)   batched RunsUpdate / RunDetail
//
// Read-only by construction: this module only stats, lists and (through adapters) reads files.

import path from 'node:path';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { AgentId, RunDetail, RunStatus, RunSummary, SourceStatus } from '@shared/schema';
import type { RunFinishedNotice, RunsUpdate } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { Env, ParseState, SessionRef, SourceAdapter } from './adapter';
import { freshState, emptyRun } from './adapter';
import { runId, safeParse, toDetail, toSummary } from './build';
import { baseName } from './events';

// ---------------------------------------------------------------------------------------------
// Injected dependencies

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

/** The slice of a chokidar FSWatcher the store uses. */
export interface WatcherLike {
  on(event: 'all', cb: (event: string, path: string) => void): unknown;
  on(event: 'error', cb: (err: unknown) => void): unknown;
  add(paths: string | string[]): unknown;
  close(): Promise<void> | void;
}

export interface WatchOptions {
  depth: number;
}

export type WatchFactory = (paths: string[], opts: WatchOptions) => WatcherLike;

export interface StoreDeps {
  adapters: readonly SourceAdapter[];
  env: Env;
  /** Scratch folder for adapters that copy files before reading (SQLite). Created by the caller. */
  tempDir: string;
  clock?: Clock;
  /** File watching. Omit for chokidar; pass null to turn watching off (tests drive pollNow()). */
  watch?: WatchFactory | null;
  /** Parses running at once. */
  concurrency?: number;
  /** Watch depth per adapter (default 6). */
  watchDepth?: Partial<Record<AgentId, number>>;
  log?: (level: 'info' | 'warn', msg: string) => void;
  /** Longest an adapter call may take before it is given up on (ms). */
  parseTimeoutMs?: number;
  discoverTimeoutMs?: number;
}

export interface StoreEvents {
  runsUpdate: (u: RunsUpdate) => void;
  runDetail: (d: RunDetail) => void;
  /** Every run detail of one flush in one call (main sends them as one IPC message). */
  runDetails: (ds: RunDetail[]) => void;
  runFinished: (n: RunFinishedNotice) => void;
}

// ---------------------------------------------------------------------------------------------
// Tuning

export const MIN_FLUSH_MS = 250;
export const HIDDEN_FLUSH_MS = 5000;
export const MIN_POLL_MS = 10_000;
const DEFAULT_DEPTH = 6;
const CHANGE_DEBOUNCE_MS = 100;
const REDISCOVER_MIN_GAP_MS = 2000;
const UNREADABLE_RETRY_MS = 60_000;
const DEFAULT_DETAIL_LIMIT = 2000;
const MAX_WATCHED = 64;

/** Statuses that can change with time alone, so the status clock re-judges them. */
/** Runs re-parsed when an adapter reports a live-state side file changed. */
const ACTIVE_FOR_SIGNAL: ReadonlySet<RunStatus> = new Set(['running', 'waiting', 'idle', 'stuck']);
const TIMED: ReadonlySet<RunStatus> = new Set(['running', 'idle', 'stuck']);

const OUTCOME: Partial<Record<RunStatus, RunFinishedNotice['outcome']>> = {
  idle: 'done',
  done: 'done',
  failed: 'failed',
  waiting: 'waiting',
  stuck: 'stuck',
};

// ---------------------------------------------------------------------------------------------
// Internal state

interface Entry {
  id: string;
  source: AgentId;
  ref: SessionRef;
  state?: ParseState;
  summary?: RunSummary;
  summaryKey?: string;
  queued: boolean;
  urgent: boolean;
  parsing: boolean;
  /** Changed while a parse was running: parse again when it ends. */
  again: boolean;
  /** Ignore the previous state on the next parse (file rewritten, or last read failed). */
  fresh: boolean;
  removed: boolean;
  lastParseAt: number;
  waiters: (() => void)[];
}

interface Source {
  adapter: SourceAdapter;
  id: AgentId;
  enabled: boolean;
  roots: string[];
  rootsKey: string;
  watcher?: WatcherLike;
  watched: Set<string>;
  ids: Set<string>;
  /** Bumped on restart; async work from an older generation is dropped. */
  gen: number;
  discovering: Promise<void> | null;
  discoverAgain: boolean;
  lastDiscoverAt: number;
  rediscoverTimer: unknown;
  changed: Set<string>;
  structural: boolean;
  changeTimer: unknown;
  lastError?: string;
}

const isWin = process.platform === 'win32';
const normPath = (p: string) => {
  const r = path.resolve(p);
  return isWin ? r.toLowerCase() : r;
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

/** Default chokidar factory, loaded lazily so tests that turn watching off never import it. */
async function chokidarFactory(): Promise<WatchFactory> {
  const { watch } = await import('chokidar');
  const IGNORED = /[\\/](?:node_modules|\.git)(?:[\\/]|$)/;
  return (paths, opts) =>
    watch(paths, {
      ignoreInitial: true,
      persistent: true,
      depth: opts.depth,
      followSymlinks: false,
      ignorePermissionErrors: true,
      awaitWriteFinish: false,
      ignored: (p: string) => IGNORED.test(p),
    }) as unknown as WatcherLike;
}

// ---------------------------------------------------------------------------------------------

export class RunStore {
  private readonly adapters: readonly SourceAdapter[];
  private readonly env: Env;
  private readonly tempDir: string;
  private readonly clock: Clock;
  private readonly concurrency: number;
  private readonly log: (level: 'info' | 'warn', msg: string) => void;
  private readonly parseTimeoutMs: number;
  private readonly discoverTimeoutMs: number;
  private readonly watchDepth: Partial<Record<AgentId, number>>;
  private watchFactory: WatchFactory | null | undefined;

  private settings?: Settings;
  private started = false;
  /** Initial discovery finished: the first full update may go out. */
  private discovered = false;
  private stopped = false;

  private readonly sources = new Map<AgentId, Source>();
  private readonly entries = new Map<string, Entry>();
  private readonly byPath = new Map<string, Set<string>>();

  private readonly queue: Entry[] = [];
  private queueSorted = true;
  private active = 0;
  private discoversRunning = 0;
  private changesRunning = 0;
  private idleWaiters: (() => void)[] = [];

  // batching
  private readonly pendingUpserts = new Map<string, RunSummary>();
  private readonly pendingRemovals = new Set<string>();
  private readonly pendingDetails = new Set<string>();
  private pendingFull = false;
  private flushTimer: unknown = null;
  private flushDueAt = 0;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private requestedInterval = MIN_FLUSH_MS;
  private hidden = false;

  // detail subscriptions
  private watched = new Set<string>();
  private readonly detailLimits = new Map<string, number>();
  // watch priority (multiviewer in low GPU mode): watched runs outside `focused` are slow
  private focused = new Set<string>();
  private slowMs = 0;
  private readonly lastDetailAt = new Map<string, number>();

  // timers
  private statusTimer: unknown = null;
  private pollTimer: unknown = null;

  private sourcesCache?: SourceStatus[];

  private readonly listeners: { [K in keyof StoreEvents]: Set<StoreEvents[K]> } = {
    runsUpdate: new Set(),
    runDetail: new Set(),
    runDetails: new Set(),
    runFinished: new Set(),
  };

  constructor(deps: StoreDeps) {
    this.adapters = deps.adapters;
    this.env = deps.env;
    this.tempDir = deps.tempDir;
    this.clock = deps.clock ?? realClock;
    this.concurrency = Math.max(1, deps.concurrency ?? 4);
    this.log = deps.log ?? (() => {});
    this.parseTimeoutMs = deps.parseTimeoutMs ?? 60_000;
    this.discoverTimeoutMs = deps.discoverTimeoutMs ?? 30_000;
    this.watchDepth = deps.watchDepth ?? {};
    this.watchFactory = deps.watch;
  }

  // ---- events --------------------------------------------------------------------------------

  on<K extends keyof StoreEvents>(event: K, cb: StoreEvents[K]): () => void {
    (this.listeners[event] as Set<StoreEvents[K]>).add(cb);
    return () => (this.listeners[event] as Set<StoreEvents[K]>).delete(cb);
  }

  private emit<K extends keyof StoreEvents>(event: K, arg: Parameters<StoreEvents[K]>[0]): void {
    for (const cb of this.listeners[event] as Set<(a: typeof arg) => void>) {
      try {
        cb(arg);
      } catch (e) {
        this.log('warn', `listener for ${event} threw: ${String(e)}`);
      }
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  /** Starts every enabled source. Resolves once discovery is done (parsing continues). */
  async start(settings: Settings): Promise<void> {
    if (this.started) return this.updateSettings(settings);
    this.started = true;
    this.stopped = false;
    this.settings = settings;
    if (this.watchFactory === undefined) {
      try {
        this.watchFactory = await chokidarFactory();
      } catch (e) {
        this.log('warn', `file watching unavailable, polling only: ${String(e)}`);
        this.watchFactory = null;
      }
    }
    for (const adapter of this.adapters) {
      const src: Source = {
        adapter,
        id: adapter.id,
        enabled: this.sourceEnabled(adapter.id),
        roots: [],
        rootsKey: '',
        watched: new Set(),
        ids: new Set(),
        gen: 0,
        discovering: null,
        discoverAgain: false,
        lastDiscoverAt: Number.NEGATIVE_INFINITY,
        rediscoverTimer: null,
        changed: new Set(),
        structural: false,
        changeTimer: null,
      };
      src.roots = this.rootsFor(src);
      src.rootsKey = src.roots.join('\n');
      this.sources.set(adapter.id, src);
    }
    this.pendingFull = true;
    this.startTimers();
    await Promise.all([...this.sources.values()].filter((s) => s.enabled).map((s) => this.bringUp(s)));
    // The first full update waits for discovery, so it never claims an empty list while still looking.
    // It carries what is parsed so far plus progress; parse results follow as normal updates.
    this.discovered = true;
    if (!this.stopped) this.scheduleFlush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.discovered = false;
    this.stopTimers();
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await Promise.all([...this.sources.values()].map((s) => this.closeWatcher(s)));
    for (const s of this.sources.values()) {
      s.gen++;
      if (s.changeTimer) this.clock.clearTimeout(s.changeTimer);
      if (s.rediscoverTimer) this.clock.clearTimeout(s.rediscoverTimer);
    }
    for (const e of this.entries.values()) this.release(e);
    this.queue.length = 0;
    this.sources.clear();
    this.entries.clear();
    this.byPath.clear();
    this.checkIdle(true);
  }

  /** Applies new settings: restarts changed sources, re-masks, retimes. */
  async updateSettings(next: Settings): Promise<void> {
    const prev = this.settings;
    this.settings = next;
    this.sourcesCache = undefined;
    if (!this.started || !prev) return;

    if (prev.refreshMs !== next.refreshMs) {
      this.stopTimers();
      this.startTimers();
    }

    if (prev.maskSecrets !== next.maskSecrets) {
      for (const e of this.entries.values()) if (e.state) this.refreshSummary(e, false);
      for (const id of this.watched) if (this.entries.get(id)?.state) this.pendingDetails.add(id);
      this.scheduleFlush();
    }

    const windowChanged =
      prev.historyDays !== next.historyDays || prev.projectRoots.join('\n') !== next.projectRoots.join('\n');
    const work: Promise<void>[] = [];
    for (const src of this.sources.values()) {
      const enabled = this.sourceEnabled(src.id);
      const roots = this.rootsFor(src);
      const rootsKey = roots.join('\n');
      if (enabled !== src.enabled || rootsKey !== src.rootsKey) {
        src.enabled = enabled;
        src.roots = roots;
        src.rootsKey = rootsKey;
        work.push(this.restartSource(src));
      } else if (windowChanged && src.enabled) {
        work.push(this.rediscover(src));
      }
    }
    await Promise.all(work);
  }

  // ---- queries -------------------------------------------------------------------------------

  listRuns(): RunSummary[] {
    const out: RunSummary[] = [];
    for (const e of this.entries.values()) if (e.summary) out.push(e.summary);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The session behind a run (for "reveal in folder"). */
  getRef(id: string): SessionRef | undefined {
    return this.entries.get(id)?.ref;
  }

  async getDetail(id: string, limit = DEFAULT_DETAIL_LIMIT): Promise<RunDetail | null> {
    if (this.entries.has(id)) this.detailLimits.set(id, limit);
    return this.buildDetail(id, limit, false);
  }

  /**
   * A run's detail built with masking on whatever the display setting, without changing what is
   * pushed to the renderer (the watched detail limit is left alone). For text that leaves the app
   * (AI summaries).
   */
  maskedDetail(id: string, limit = DEFAULT_DETAIL_LIMIT): Promise<RunDetail | null> {
    return this.buildDetail(id, limit, true);
  }

  private async buildDetail(id: string, limit: number, forceMask: boolean): Promise<RunDetail | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    if (!e.state) {
      await new Promise<void>((resolve) => {
        e.waiters.push(resolve);
        this.enqueue(e, true);
      });
    }
    if (e.removed || !e.state) return null;
    return toDetail(e.ref, e.state, this.clock.now(), forceMask || this.mask, limit);
  }

  /** Per-source detection: default and custom roots, whether they exist, and run counts (discover only). */
  async getSources(rescan = false): Promise<SourceStatus[]> {
    if (!rescan && this.sourcesCache) return this.sourcesCache;
    const settings = this.settings;
    const since = this.since();
    const result = await Promise.all(
      this.adapters.map(async (adapter): Promise<SourceStatus> => {
        const custom = settings?.sources[adapter.id]?.customRoots ?? [];
        let defaults: string[] = [];
        let error: string | undefined;
        try {
          defaults = adapter.defaultRoots(this.env) ?? [];
        } catch (e) {
          error = `Couldn't work out where ${adapter.displayName} keeps its sessions: ${String((e as Error)?.message ?? e)}`;
        }
        const defaultRoots = await Promise.all(defaults.map(async (p) => ({ path: p, exists: await exists(p) })));
        const customRoots = await Promise.all(custom.map(async (p) => ({ path: p, exists: await exists(p) })));
        const existing = [...defaultRoots, ...customRoots].filter((r) => r.exists).map((r) => r.path);
        let runCount = 0;
        try {
          const refs = await withTimeout(
            Promise.resolve(adapter.discover(existing, { env: this.env, since, projectRoots: settings?.projectRoots ?? [], tempDir: this.tempDir })),
            this.discoverTimeoutMs,
            'Looking for runs',
          );
          runCount = Array.isArray(refs) ? refs.length : 0;
        } catch (e) {
          error ??= `Couldn't list runs: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        }
        return {
          agent: adapter.id,
          displayName: adapter.displayName,
          enabled: this.sourceEnabled(adapter.id),
          defaultRoots,
          customRoots,
          runCount,
          note: adapter.note,
          confidence: adapter.confidence,
          error,
        };
      }),
    );
    this.sourcesCache = result;
    return result;
  }

  // ---- renderer hints ------------------------------------------------------------------------

  /** Runs whose detail is pushed when it changes (the open run, visible tiles). */
  watchRuns(ids: readonly string[]): void {
    this.watched = new Set(ids.filter((s) => typeof s === 'string').slice(0, MAX_WATCHED));
    for (const id of this.pendingDetails) if (!this.watched.has(id)) this.pendingDetails.delete(id);
    for (const id of this.lastDetailAt.keys()) if (!this.watched.has(id)) this.lastDetailAt.delete(id);
  }

  /**
   * Priority among the watched runs: those in `focused` get detail pushes with every flush, the
   * other watched runs at most every `slowMs` (their changes wait; they are not dropped).
   * slowMs 0 clears the priority.
   */
  setWatchPriority(focused: readonly string[], slowMs: number): void {
    this.focused = new Set(focused.filter((s) => typeof s === 'string').slice(0, MAX_WATCHED));
    this.slowMs = Number.isFinite(slowMs) ? Math.min(60_000, Math.max(0, slowMs)) : 0;
    // A run that just became focused may have a change waiting: send it with the next flush.
    if (this.pendingDetails.size) this.retimeFlush(true);
  }

  /** The renderer's minimum gap between pushes (250 normally, 1000 in low-GPU mode). */
  setUpdateInterval(ms: number): void {
    this.requestedInterval = Number.isFinite(ms) ? Math.min(60_000, Math.max(0, ms)) : MIN_FLUSH_MS;
    this.retimeFlush();
  }

  /** Main says the window is hidden or minimised: push at most every 5 s. */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.retimeFlush();
  }

  /** The gap between flushes right now. */
  get flushInterval(): number {
    return this.hidden ? Math.max(HIDDEN_FLUSH_MS, this.requestedInterval) : Math.max(MIN_FLUSH_MS, this.requestedInterval);
  }

  // ---- test and maintenance hooks ------------------------------------------------------------

  /** Re-runs discovery for every enabled source (what the slow poll does). */
  async pollNow(): Promise<void> {
    await Promise.all([...this.sources.values()].filter((s) => s.enabled).map((s) => this.pollSource(s)));
  }

  /** Re-judges live runs now (what the status clock does). */
  tickStatus(): void {
    for (const e of this.entries.values()) {
      if (e.state && e.summary && TIMED.has(e.summary.status)) this.refreshSummary(e, false);
    }
  }

  /** Sends the whole list again with the next flush (a renderer that just (re)loaded). */
  requestFull(): void {
    this.pendingFull = true;
    this.scheduleFlush();
  }

  /** Sends whatever is pending immediately. */
  flushNow(): void {
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
  }

  /** Resolves when no discovery or parse is running or queued. */
  async whenIdle(): Promise<void> {
    while (!this.isIdle()) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /** Tells the store paths changed (what the watcher does). */
  notifyChanged(agent: AgentId, paths: string[], structural = false): void {
    const src = this.sources.get(agent);
    if (!src || !src.enabled) return;
    for (const p of paths) src.changed.add(p);
    if (structural) src.structural = true;
    this.scheduleChanges(src);
  }

  // ---- settings helpers ----------------------------------------------------------------------

  private get mask(): boolean {
    return this.settings?.maskSecrets ?? true;
  }

  private sourceEnabled(id: AgentId): boolean {
    return this.settings?.sources[id]?.enabled ?? true;
  }

  private rootsFor(src: Source): string[] {
    let defaults: string[] = [];
    try {
      defaults = src.adapter.defaultRoots(this.env) ?? [];
    } catch (e) {
      this.log('warn', `${src.id}: defaultRoots threw: ${String(e)}`);
    }
    const custom = this.settings?.sources[src.id]?.customRoots ?? [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...defaults, ...custom]) {
      if (typeof r !== 'string' || !r) continue;
      const k = normPath(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  private since(): number {
    const days = this.settings?.historyDays ?? 14;
    return days > 0 ? this.clock.now() - days * 86_400_000 : 0;
  }

  // ---- timers --------------------------------------------------------------------------------

  private startTimers(): void {
    const refresh = this.settings?.refreshMs ?? 2000;
    this.statusTimer = this.clock.setInterval(() => this.tickStatus(), refresh);
    this.pollTimer = this.clock.setInterval(() => void this.pollNow(), Math.max(MIN_POLL_MS, refresh * 5));
  }

  private stopTimers(): void {
    if (this.statusTimer) this.clock.clearInterval(this.statusTimer);
    if (this.pollTimer) this.clock.clearInterval(this.pollTimer);
    this.statusTimer = this.pollTimer = null;
  }

  // ---- sources -------------------------------------------------------------------------------

  private async bringUp(src: Source): Promise<void> {
    await this.setupWatch(src);
    await this.rediscover(src);
  }

  private async restartSource(src: Source): Promise<void> {
    src.gen++;
    this.sourcesCache = undefined;
    await this.closeWatcher(src);
    if (src.changeTimer) this.clock.clearTimeout(src.changeTimer);
    if (src.rediscoverTimer) this.clock.clearTimeout(src.rediscoverTimer);
    src.changeTimer = src.rediscoverTimer = null;
    src.changed.clear();
    if (!src.enabled) {
      for (const id of [...src.ids]) this.removeEntry(id);
      this.scheduleFlush();
      return;
    }
    await this.bringUp(src);
  }

  private async setupWatch(src: Source): Promise<void> {
    const factory = this.watchFactory;
    if (!factory || this.stopped) return;
    const gen = src.gen;
    const existing: string[] = [];
    for (const r of src.roots) if (await exists(r)) existing.push(r);
    if (gen !== src.gen || !src.enabled || this.stopped || existing.length === 0) return;
    try {
      const w = factory(existing, { depth: this.watchDepth[src.id] ?? DEFAULT_DEPTH });
      w.on('all', (event, p) => {
        if (gen !== src.gen) return;
        this.notifyChanged(src.id, [p], event !== 'change');
      });
      w.on('error', (err) => {
        const code = errCode(err);
        // Windows reports EPERM/EBUSY when a watched folder is deleted or locked; polling covers it.
        if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOENT' || code === 'EACCES') return;
        this.log('warn', `${src.id}: watcher error ${code ?? ''} ${String((err as Error)?.message ?? err)}`);
      });
      src.watcher = w;
      src.watched = new Set(existing.map(normPath));
    } catch (e) {
      this.log('warn', `${src.id}: could not watch, polling only: ${String(e)}`);
    }
  }

  private async closeWatcher(src: Source): Promise<void> {
    const w = src.watcher;
    src.watcher = undefined;
    src.watched = new Set();
    if (!w) return;
    try {
      await w.close();
    } catch {
      /* already closed */
    }
  }

  /** Watches roots that appeared since the watcher started (an agent installed meanwhile). */
  private async addNewRoots(src: Source): Promise<void> {
    if (!this.watchFactory) return;
    const fresh: string[] = [];
    for (const r of src.roots) if (!src.watched.has(normPath(r)) && (await exists(r))) fresh.push(r);
    if (!fresh.length) return;
    if (!src.watcher) return this.setupWatch(src);
    try {
      src.watcher.add(fresh);
      for (const r of fresh) src.watched.add(normPath(r));
    } catch (e) {
      this.log('warn', `${src.id}: could not watch a new folder: ${String(e)}`);
    }
  }

  private async pollSource(src: Source): Promise<void> {
    await this.addNewRoots(src);
    // Retry runs that could not be read (a locked file, a permission blip).
    const now = this.clock.now();
    for (const id of src.ids) {
      const e = this.entries.get(id);
      if (e?.state?.run.readError && now - e.lastParseAt >= UNREADABLE_RETRY_MS) {
        e.fresh = true;
        this.enqueue(e);
      }
    }
    await this.rediscover(src);
  }

  /** Runs discover for a source and reconciles the result. Concurrent calls coalesce. */
  private rediscover(src: Source): Promise<void> {
    if (src.discovering) {
      src.discoverAgain = true;
      return src.discovering;
    }
    const gen = src.gen;
    this.discoversRunning++;
    src.discovering = (async () => {
      do {
        src.discoverAgain = false;
        src.lastDiscoverAt = this.clock.now();
        let refs: SessionRef[];
        try {
          const roots: string[] = [];
          for (const r of src.roots) if (await exists(r)) roots.push(r);
          const found = await withTimeout(
            Promise.resolve(
              src.adapter.discover(roots, { env: this.env, since: this.since(), projectRoots: this.settings?.projectRoots ?? [], tempDir: this.tempDir }),
            ),
            this.discoverTimeoutMs,
            'Looking for runs',
          );
          refs = Array.isArray(found) ? found : [];
          src.lastError = undefined;
        } catch (e) {
          // A failed listing keeps what we have: never drop runs because of a transient error.
          src.lastError = String((e as Error)?.message ?? e);
          this.log('warn', `${src.id}: discover failed: ${src.lastError}`);
          break;
        }
        if (gen !== src.gen || !src.enabled || this.stopped) break;
        this.reconcile(src, refs);
      } while (src.discoverAgain && gen === src.gen && !this.stopped);
    })().finally(() => {
      src.discovering = null;
      this.discoversRunning--;
      this.checkIdle();
    });
    return src.discovering;
  }

  /** Rediscover soon, but not more often than every couple of seconds per source. */
  private rediscoverSoon(src: Source): void {
    if (src.rediscoverTimer) return;
    const wait = Math.max(0, src.lastDiscoverAt + REDISCOVER_MIN_GAP_MS - this.clock.now());
    src.rediscoverTimer = this.clock.setTimeout(() => {
      src.rediscoverTimer = null;
      if (src.enabled && !this.stopped) void this.rediscover(src);
    }, wait);
  }

  private reconcile(src: Source, refs: SessionRef[]): void {
    const seen = new Set<string>();
    for (const raw of refs) {
      if (!raw || typeof raw.path !== 'string') continue;
      const ref: SessionRef = raw.agent === src.id ? raw : { ...raw, agent: src.id };
      const id = runId(ref);
      if (seen.has(id)) continue;
      seen.add(id);
      const e = this.entries.get(id);
      if (!e) {
        this.addEntry(src, id, ref);
      } else if (e.source === src.id) {
        const changed = e.ref.mtimeMs !== ref.mtimeMs || e.ref.size !== ref.size;
        if (ref.size < e.ref.size) e.fresh = true;
        e.ref = ref;
        if (changed) this.enqueue(e);
      }
    }
    for (const id of [...src.ids]) if (!seen.has(id)) this.removeEntry(id);
    this.sourcesCache = undefined;
  }

  // ---- change events -------------------------------------------------------------------------

  private scheduleChanges(src: Source): void {
    if (src.changeTimer || this.stopped) return;
    src.changeTimer = this.clock.setTimeout(() => {
      src.changeTimer = null;
      this.changesRunning++;
      void this.processChanges(src).finally(() => {
        this.changesRunning--;
        this.checkIdle();
      });
    }, CHANGE_DEBOUNCE_MS);
  }

  private async processChanges(src: Source): Promise<void> {
    const paths = [...src.changed];
    src.changed.clear();
    let needDiscover = src.structural;
    src.structural = false;
    const gen = src.gen;
    for (const p of paths) {
      if (src.adapter.isLiveSignal?.(p)) {
        for (const id of src.ids) {
          const e = this.entries.get(id);
          if (e && e.summary && ACTIVE_FOR_SIGNAL.has(e.summary.status)) this.enqueue(e);
        }
        continue;
      }
      if (src.adapter.isRelevantChange && !src.adapter.isRelevantChange(p)) continue;
      const key = normPath(p);
      const ids = this.byPath.get(key);
      if (ids && ids.size) {
        let st: Stats | undefined;
        try {
          st = await stat(p);
        } catch (e) {
          if (errCode(e) === 'ENOENT') needDiscover = true;
        }
        if (gen !== src.gen) return;
        for (const id of ids) {
          const e = this.entries.get(id);
          if (!e) continue;
          // One file holding several runs (a database): its mtime is not any one run's, so list
          // again and let discover() give each run its own time; reconcile() re-parses the changed ones.
          if (e.ref.subId !== undefined) {
            needDiscover = true;
            continue;
          }
          if (st && st.isFile() && (st.mtimeMs !== e.ref.mtimeMs || st.size !== e.ref.size)) {
            if (st.size < e.ref.size) e.fresh = true;
            e.ref = { ...e.ref, mtimeMs: st.mtimeMs, size: st.size };
            this.enqueue(e);
          } else if (st && !st.isFile()) {
            this.enqueue(e);
          }
        }
        continue;
      }
      // A file inside a run that lives in a folder (or a sidecar such as a -wal file).
      const owner = this.ownerOf(key);
      for (const id of owner) {
        const e = this.entries.get(id);
        if (e && e.ref.subId === undefined) {
          e.ref = { ...e.ref, mtimeMs: Math.max(e.ref.mtimeMs, this.clock.now()) };
          this.enqueue(e);
        }
      }
      // Unknown path: possibly a new run, or an old one that moved into the history window.
      needDiscover = true;
    }
    if (needDiscover) this.rediscoverSoon(src);
  }

  /** Entries whose path is an ancestor (up to 4 levels) of `key`, or `key` minus a sidecar suffix. */
  private ownerOf(key: string): Set<string> {
    const out = new Set<string>();
    const sidecar = key.replace(/-(?:wal|shm|journal)$/, '');
    if (sidecar !== key) for (const id of this.byPath.get(sidecar) ?? []) out.add(id);
    let dir = key;
    for (let i = 0; i < 4; i++) {
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
      for (const id of this.byPath.get(dir) ?? []) out.add(id);
    }
    return out;
  }

  // ---- entries -------------------------------------------------------------------------------

  private addEntry(src: Source, id: string, ref: SessionRef): void {
    const e: Entry = {
      id,
      source: src.id,
      ref,
      queued: false,
      urgent: false,
      parsing: false,
      again: false,
      fresh: false,
      removed: false,
      lastParseAt: 0,
      waiters: [],
    };
    this.entries.set(id, e);
    src.ids.add(id);
    const key = normPath(ref.path);
    let set = this.byPath.get(key);
    if (!set) this.byPath.set(key, (set = new Set()));
    set.add(id);
    this.enqueue(e);
  }

  private removeEntry(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.removed = true;
    this.entries.delete(id);
    this.sources.get(e.source)?.ids.delete(id);
    const key = normPath(e.ref.path);
    const set = this.byPath.get(key);
    if (set) {
      set.delete(id);
      if (!set.size) this.byPath.delete(key);
    }
    this.pendingUpserts.delete(id);
    this.pendingDetails.delete(id);
    this.detailLimits.delete(id);
    if (e.summary) {
      this.pendingRemovals.add(id);
      this.scheduleFlush();
    }
    this.release(e);
  }

  private release(e: Entry): void {
    const w = e.waiters;
    e.waiters = [];
    for (const r of w) r();
  }

  // ---- parse queue ---------------------------------------------------------------------------

  private enqueue(e: Entry, urgent = false): void {
    if (e.removed || this.stopped) return;
    if (urgent && !e.urgent) {
      e.urgent = true;
      this.queueSorted = false;
    }
    if (e.parsing) {
      e.again = true;
      return;
    }
    if (!e.queued) {
      e.queued = true;
      this.queue.push(e);
      this.queueSorted = false;
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length && !this.stopped) {
      if (!this.queueSorted) {
        // Urgent (someone is waiting on it) first, then newest first.
        this.queue.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.ref.mtimeMs - a.ref.mtimeMs);
        this.queueSorted = true;
      }
      const e = this.queue.shift()!;
      e.queued = false;
      if (e.removed) continue;
      e.parsing = true;
      e.urgent = false;
      this.active++;
      void this.parseEntry(e).finally(() => {
        this.active--;
        e.parsing = false;
        if (e.again && !e.removed) {
          e.again = false;
          this.enqueue(e);
        }
        this.pump();
        this.checkIdle();
      });
    }
  }

  private async parseEntry(e: Entry): Promise<void> {
    const src = this.sources.get(e.source);
    if (!src) return;
    const gen = src.gen;
    const ref = e.ref;
    const prev = e.fresh || e.state?.run.readError ? undefined : e.state;
    e.fresh = false;
    let st: ParseState;
    try {
      st = await withTimeout(
        safeParse(src.adapter, ref, prev, { env: this.env, tempDir: this.tempDir }),
        this.parseTimeoutMs,
        'Reading this run',
      );
    } catch (err) {
      st = freshState();
      st.run = emptyRun(ref.hint?.project ?? baseName(ref.path));
      st.run.readError = String((err as Error)?.message ?? err);
      st.size = ref.size;
      st.mtimeMs = ref.mtimeMs;
      // A timed-out parse may still be mutating `prev`; never reuse it.
      e.fresh = true;
    }
    if (e.removed) return;
    if (gen !== src.gen) {
      // The source restarted mid-parse: parse again under the new generation.
      e.again = true;
      return;
    }
    e.state = st;
    e.lastParseAt = this.clock.now();
    this.refreshSummary(e, true);
    this.release(e);
  }

  // ---- summaries, notices, batching ----------------------------------------------------------

  private refreshSummary(e: Entry, fromParse: boolean): void {
    if (!e.state) return;
    const s = toSummary(e.ref, e.state, this.clock.now(), this.mask);
    const key = JSON.stringify(s);
    const before = e.summary;
    const changed = key !== e.summaryKey;
    if (changed) {
      e.summary = s;
      e.summaryKey = key;
      this.pendingUpserts.set(e.id, s);
      this.pendingRemovals.delete(e.id);
    }
    // Only transitions seen while watching count; a run's first summary is never a transition.
    if (before && before.status === 'running' && s.status !== 'running') {
      const outcome = OUTCOME[s.status];
      if (outcome) this.emit('runFinished', { run: s, outcome });
    }
    if (this.watched.has(e.id) && (fromParse || changed)) this.pendingDetails.add(e.id);
    if (changed || this.pendingDetails.size) this.scheduleFlush();
  }

  /**
   * Arms the flush timer for the earliest allowed moment: one flush interval after the last flush,
   * and not before `notBefore`. A timer already armed for a later moment is pulled in.
   */
  private scheduleFlush(notBefore = Number.NEGATIVE_INFINITY): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const due = Math.max(now, this.lastFlushAt + this.flushInterval, notBefore);
    if (this.flushTimer) {
      if (this.flushDueAt <= due) return;
      this.clock.clearTimeout(this.flushTimer);
    }
    this.flushDueAt = due;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, due - now);
  }

  private retimeFlush(force = false): void {
    if (!this.flushTimer && !force) return;
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.scheduleFlush();
  }

  /** When a slow (unfocused) watched run may next get a detail push; 0 when it may now. */
  private slowUntil(id: string): number {
    if (this.slowMs <= 0 || this.focused.has(id)) return 0;
    const last = this.lastDetailAt.get(id);
    return last === undefined ? 0 : last + this.slowMs;
  }

  private flush(): void {
    if (this.stopped) return;
    const nextSlow = this.flushOnce();
    // Slow runs whose change had to wait: come back for them when they are due.
    if (nextSlow !== undefined) this.scheduleFlush(nextSlow);
  }

  /** One flush. Returns when the earliest held-back slow detail is due, if any. */
  private flushOnce(): number | undefined {
    if (this.pendingFull && !this.discovered) return undefined; // start() flushes once discovery is done
    let update: RunsUpdate | null = null;
    if (this.pendingFull) {
      this.pendingFull = false;
      update = { upserts: this.listRuns(), removed: [], full: true };
    } else if (this.pendingUpserts.size || this.pendingRemovals.size) {
      update = { upserts: [...this.pendingUpserts.values()], removed: [...this.pendingRemovals], full: false };
    }
    this.pendingUpserts.clear();
    this.pendingRemovals.clear();
    const now = this.clock.now();
    const details: string[] = [];
    let nextSlow: number | undefined;
    for (const id of [...this.pendingDetails]) {
      const until = this.watched.has(id) ? this.slowUntil(id) : 0;
      if (until > now) {
        nextSlow = Math.min(nextSlow ?? until, until); // stays pending for a later flush
        continue;
      }
      this.pendingDetails.delete(id);
      if (this.watched.has(id)) details.push(id);
    }
    if (!update && !details.length) return nextSlow;
    this.lastFlushAt = this.clock.now();
    if (update) {
      let parsed = 0;
      for (const e of this.entries.values()) if (e.summary) parsed++;
      update.progress = { parsed, total: this.entries.size };
      this.emit('runsUpdate', update);
    }
    const batch: RunDetail[] = [];
    for (const id of details) {
      const e = this.entries.get(id);
      if (!e?.state) continue;
      this.lastDetailAt.set(id, now);
      batch.push(toDetail(e.ref, e.state, now, this.mask, this.detailLimits.get(id) ?? DEFAULT_DETAIL_LIMIT));
    }
    for (const d of batch) this.emit('runDetail', d);
    if (batch.length) this.emit('runDetails', batch);
    return nextSlow;
  }

  // ---- idle tracking -------------------------------------------------------------------------

  private isIdle(): boolean {
    return this.stopped || (this.active === 0 && this.queue.length === 0 && this.discoversRunning === 0 && this.changesRunning === 0);
  }

  private checkIdle(force = false): void {
    if (!force && !this.isIdle()) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of w) r();
  }
}
