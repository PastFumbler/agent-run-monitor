// The fixture backend: the whole Backend interface over synthetic demo data, for the browser demo,
// the Playwright suite and screenshot scripts. A few runs are live: a timer appends events every
// 0.5-2 s and, now and then, finishes or fails one. Pushes are batched by setUpdateInterval, like
// the real backend. URL parameters:
//   ?scenario=demo|empty|firstrun|many   ?now=<epoch ms or ISO date>   ?live=0 (no timer)
//   ?seed=<n>   ?battery=1 (report battery power)   ?fresh=1 (ignore saved settings)
// window.__armFixture exposes controls for tests (see FixtureControls).

import type {
  AppInfo,
  Backend,
  PowerState,
  RunFinishedNotice,
  RunsUpdate,
  UpdateInfo,
  Unsubscribe,
} from '@shared/ipc';
import { AGENT_IDS, AGENT_NAMES, type RunDetail, type RunStatus, type RunSummary, type SourceStatus } from '@shared/schema';
import { defaultSettings, normalizeSettings, type Settings } from '@shared/settings';
import { setClockTo, shiftClock, nowMs } from './clock';
import {
  buildDemo,
  demoProject,
  detailOf,
  EventWriter,
  makeRun,
  refreshSummary,
  type DemoRun,
  type Scenario,
} from './demoData';
import { Rng } from './prng';

export interface FixtureOptions {
  scenario?: Scenario;
  now?: number;
  live?: boolean;
  seed?: number;
  battery?: boolean;
  fresh?: boolean;
}

export interface FixtureControls {
  /** Moves the clock forward and runs `ticks` live steps. */
  advance(ms: number, ticks?: number): void;
  /** Runs one live step now (and flushes). */
  tick(): void;
  pause(): void;
  resume(): void;
  /** Adds a live run; returns its id. */
  addRun(partial?: Partial<Pick<RunSummary, 'agent' | 'status' | 'projectName' | 'title'>>): string;
  failRun(id: string, detail?: string): void;
  finishRun(id: string): void;
  setStatus(id: string, status: RunStatus): void;
  setPower(p: Partial<PowerState>): void;
  setVisible(visible: boolean): void;
  /** Like clicking a finish notification in the desktop app. */
  openRun(id: string): void;
  /** Flushes pending batched updates immediately. */
  flush(): void;
  runs(): RunSummary[];
  updateInterval(): number;
}

declare global {
  interface Window {
    __armFixture?: FixtureControls;
  }
}

type Listener<T> = (v: T) => void;

class Emitter<T> {
  private ls = new Set<Listener<T>>();
  on(cb: Listener<T>): Unsubscribe {
    this.ls.add(cb);
    return () => this.ls.delete(cb);
  }
  emit(v: T) {
    for (const l of [...this.ls]) {
      try {
        l(v);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

const SETTINGS_KEY = 'arm.fixture.settings';

function readSaved(scenario: Scenario): Partial<Settings> | null {
  try {
    const raw = localStorage.getItem(`${SETTINGS_KEY}.${scenario}`);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
  } catch {
    return null;
  }
}

export function fixtureOptionsFromUrl(search: string): FixtureOptions {
  const p = new URLSearchParams(search);
  const sc = p.get('scenario');
  const nowRaw = p.get('now');
  let now: number | undefined;
  if (nowRaw) {
    const n = /^\d+$/.test(nowRaw) ? Number(nowRaw) : Date.parse(nowRaw);
    if (Number.isFinite(n)) now = n;
  }
  return {
    scenario: sc === 'empty' || sc === 'firstrun' || sc === 'many' ? sc : 'demo',
    now,
    live: p.get('live') !== '0',
    seed: p.get('seed') ? Number(p.get('seed')) : undefined,
    battery: p.get('battery') === '1',
    fresh: p.get('fresh') === '1',
  };
}

export class FixtureBackend implements Backend {
  private readonly scenario: Scenario;
  private readonly rng: Rng;
  private runs = new Map<string, DemoRun>();
  private settings: Settings;
  private power: PowerState;
  private interval = 250;
  private watched = new Set<string>();
  private pendingUpserts = new Set<string>();
  private pendingRemoved = new Set<string>();
  private pendingDetails = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private paused: boolean;
  private lastFlush = 0;

  private evRuns = new Emitter<RunsUpdate>();
  private evDetail = new Emitter<RunDetail>();
  private evPower = new Emitter<PowerState>();
  private evFinished = new Emitter<RunFinishedNotice>();
  private evVisible = new Emitter<boolean>();
  private evOpenRun = new Emitter<string>();

  constructor(opts: FixtureOptions = {}) {
    this.scenario = opts.scenario ?? 'demo';
    if (opts.now !== undefined) setClockTo(opts.now);
    this.rng = new Rng((opts.seed ?? 20261027) ^ 0x5eed);
    for (const r of buildDemo(this.scenario, nowMs(), opts.seed)) this.runs.set(r.summary.id, r);

    const base = defaultSettings();
    base.firstRunComplete = this.scenario !== 'firstrun';
    const pinned = [...this.runs.values()].filter((r) => r.summary.status === 'failed').slice(0, 1).map((r) => r.summary.id);
    base.pinned = this.scenario === 'demo' ? pinned : [];
    const saved = opts.fresh ? null : readSaved(this.scenario);
    this.settings = normalizeSettings({ ...base, ...(saved ?? {}) });

    this.power = { onBattery: !!opts.battery, powerSaver: false, known: true };
    this.paused = opts.live === false;
    this.scheduleLive();
  }

  // ---- Backend ----

  async appInfo(): Promise<AppInfo> {
    return { version: '0.1.0-demo', platform: 'web', settingsPath: '(browser demo: settings live in this tab)' };
  }

  async getSettings(): Promise<Settings> {
    return structuredClone(this.settings);
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const wasEnabled = AGENT_IDS.map((a) => this.sourceEnabled(a)).join();
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    // Settings support (additive): switching a source on or off re-sends the full run list, the way
    // the real backend rescans, so that agent's runs leave (or rejoin) the list at once.
    if (AGENT_IDS.map((a) => this.sourceEnabled(a)).join() !== wasEnabled) {
      this.evRuns.emit({ upserts: this.visibleSummaries(), removed: [], full: true });
    }
    try {
      localStorage.setItem(`${SETTINGS_KEY}.${this.scenario}`, JSON.stringify(this.settings));
    } catch {
      /* private mode: memory only */
    }
    return structuredClone(this.settings);
  }

  async listRuns(): Promise<RunSummary[]> {
    return this.visibleSummaries();
  }

  // Settings support (additive): like the real backend, runs from a switched-off source are not listed.
  private sourceEnabled(agent: RunSummary['agent']): boolean {
    return this.settings.sources[agent]?.enabled !== false;
  }

  private visibleSummaries(): RunSummary[] {
    return [...this.runs.values()]
      .filter((r) => this.sourceEnabled(r.summary.agent))
      .map((r) => ({ ...r.summary, counts: { ...r.summary.counts } }));
  }

  async getRun(id: string, limit = 2000): Promise<RunDetail | null> {
    const r = this.runs.get(id);
    return r ? detailOf(r, limit) : null;
  }

  async getSources(): Promise<SourceStatus[]> {
    const counts = new Map<string, number>();
    for (const r of this.runs.values()) counts.set(r.summary.agent, (counts.get(r.summary.agent) ?? 0) + 1);
    const roots: Record<string, string> = {
      'claude-code': '/home/demo/.claude/projects',
      codex: '/home/demo/.codex/sessions',
      'gemini-cli': '/home/demo/.gemini/tmp',
      'qwen-code': '/home/demo/.qwen/tmp',
      'copilot-vscode': '/home/demo/.config/Code/User/workspaceStorage',
      'copilot-cli': '/home/demo/.copilot/session-state',
      aider: '/home/demo/code',
      cursor: '/home/demo/.config/Cursor/User/globalStorage',
      cline: '/home/demo/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
      'roo-code': '/home/demo/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      opencode: '/home/demo/.local/share/opencode/storage',
      continue: '/home/demo/.continue/sessions',
    };
    return AGENT_IDS.map((agent, i) => {
      const n = counts.get(agent) ?? 0;
      const exists = this.scenario === 'empty' ? i < 2 : n > 0 || i % 4 !== 3;
      return {
        agent,
        displayName: AGENT_NAMES[agent],
        enabled: this.settings.sources[agent]?.enabled ?? true,
        defaultRoots: [{ path: roots[agent], exists }],
        customRoots: (this.settings.sources[agent]?.customRoots ?? []).map((path) => ({ path, exists: true })),
        runCount: exists ? n : 0,
        note: `Demo data: reads ${agent === 'cursor' ? 'a SQLite database (copied first)' : 'session files'} read-only.`,
        confidence: i % 3 === 0 ? 'verified' : i % 3 === 1 ? 'source' : 'best-effort',
      } satisfies SourceStatus;
    });
  }

  async pickFolder(): Promise<string | null> {
    return '/home/demo/code/another-project';
  }

  async revealSource(): Promise<void> {
    /* The demo has no files to reveal. */
  }

  async getPower(): Promise<PowerState> {
    return { ...this.power };
  }

  async checkForUpdate(): Promise<UpdateInfo> {
    return { current: '0.1.0-demo', error: 'Update checks are off in the demo (no network).' };
  }

  onRunsUpdate(cb: (u: RunsUpdate) => void): Unsubscribe {
    return this.evRuns.on(cb);
  }
  onRunDetail(cb: (d: RunDetail) => void): Unsubscribe {
    return this.evDetail.on(cb);
  }
  onPower(cb: (p: PowerState) => void): Unsubscribe {
    return this.evPower.on(cb);
  }
  onRunFinished(cb: (n: RunFinishedNotice) => void): Unsubscribe {
    return this.evFinished.on(cb);
  }
  onWindowVisibility(cb: (visible: boolean) => void): Unsubscribe {
    return this.evVisible.on(cb);
  }
  onOpenRun(cb: (id: string) => void): Unsubscribe {
    return this.evOpenRun.on(cb);
  }

  watchRuns(ids: string[]): void {
    this.watched = new Set(ids);
  }

  setUpdateInterval(ms: number): void {
    this.interval = Math.max(50, ms);
  }

  // ---- live simulation ----

  private markDirty(id: string) {
    this.pendingUpserts.add(id);
    if (this.watched.has(id)) this.pendingDetails.add(id);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.lastFlush + this.interval - Date.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.lastFlush = Date.now();
    if (this.pendingUpserts.size || this.pendingRemoved.size) {
      const upserts = [...this.pendingUpserts]
        .map((id) => this.runs.get(id))
        .filter((r): r is DemoRun => !!r)
        .filter((r) => this.sourceEnabled(r.summary.agent)) // settings support: switched-off sources stay hidden
        .map((r) => ({ ...r.summary, counts: { ...r.summary.counts } }));
      const removed = [...this.pendingRemoved];
      this.pendingUpserts.clear();
      this.pendingRemoved.clear();
      this.evRuns.emit({ upserts, removed, full: false });
    }
    const details = [...this.pendingDetails];
    this.pendingDetails.clear();
    for (const id of details) {
      const r = this.runs.get(id);
      if (r) this.evDetail.emit(detailOf(r));
    }
  }

  private scheduleLive() {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (this.paused || this.scenario === 'empty') return;
    const delay = Math.round(this.rng.float(500, 2000));
    this.liveTimer = setTimeout(() => {
      this.liveStep();
      this.scheduleLive();
    }, delay);
  }

  private liveRuns(): DemoRun[] {
    return [...this.runs.values()].filter((r) => r.live && r.summary.status === 'running');
  }

  private writer(run: DemoRun) {
    return new EventWriter(run, this.rng, demoProject(run.summary.projectName));
  }

  liveStep() {
    const live = this.liveRuns();
    if (!live.length) return;
    const run = this.rng.pick(live);
    const w = this.writer(run);
    const t = nowMs();
    if (run.openCallId) {
      w.closeOpen(t, this.rng.chance(0.08));
    } else {
      const r = this.rng.next();
      if (r < 0.2) w.reasoning(t);
      else if (r < 0.35) w.assistant(t);
      else w.tool(this.rng.pick(['run', 'read', 'search', 'edit', 'edit', 'web'] as const), t, { open: true });
    }
    run.summary.updatedAt = t;
    run.summary.statusDetail = run.summary.currentTool ? `Running ${run.summary.currentTool}` : undefined;
    refreshSummary(run);
    this.markDirty(run.summary.id);

    // Now and then a live run ends. Keep at least two running so the demo stays alive.
    if (!run.keepAlive && this.rng.chance(0.01) && live.length > 2) {
      if (this.rng.chance(0.5)) this.finishRun(run.summary.id);
      else this.failRun(run.summary.id);
    }
    if (this.liveRuns().length < 2) this.addRun();
  }

  finishRun(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    const w = this.writer(run);
    const t = nowMs();
    w.closeOpen(t);
    w.assistant(t, 'Done. {task}: the change is in {file}, and the tests pass.');
    run.live = false;
    run.summary.status = 'done';
    run.summary.statusDetail = undefined;
    run.summary.updatedAt = t;
    refreshSummary(run);
    this.markDirty(id);
    this.evFinished.emit({ run: { ...run.summary }, outcome: 'done' });
  }

  failRun(id: string, detail = 'API error 529: overloaded') {
    const run = this.runs.get(id);
    if (!run) return;
    const w = this.writer(run);
    const t = nowMs();
    w.closeOpen(t, true);
    w.error(`${detail}. The run stopped.`, t);
    run.live = false;
    run.summary.status = 'failed';
    run.summary.statusDetail = detail;
    run.summary.updatedAt = t;
    refreshSummary(run);
    this.markDirty(id);
    this.evFinished.emit({ run: { ...run.summary }, outcome: 'failed' });
  }

  setStatus(id: string, status: RunStatus) {
    const run = this.runs.get(id);
    if (!run) return;
    if (status !== 'running') {
      this.writer(run).closeOpen(nowMs());
      run.live = false;
    }
    run.summary.status = status;
    run.summary.statusDetail = status === 'stuck' ? 'No activity for 21 min' : status === 'waiting' ? 'Waiting for tool approval' : undefined;
    run.summary.updatedAt = nowMs();
    refreshSummary(run);
    this.markDirty(id);
  }

  addRun(partial: Partial<Pick<RunSummary, 'agent' | 'status' | 'projectName' | 'title'>> = {}): string {
    const status = partial.status ?? 'running';
    const run = makeRun(
      {
        agent: partial.agent ?? this.rng.pick(AGENT_IDS),
        status,
        project: partial.projectName,
        age: 1000,
        live: status === 'running',
        size: this.rng.int(2, 5),
      },
      this.rng.fork(this.runs.size),
      nowMs(),
      [...this.runs.values()],
    );
    if (partial.title) run.summary.title = partial.title;
    this.runs.set(run.summary.id, run);
    this.markDirty(run.summary.id);
    return run.summary.id;
  }

  controls(): FixtureControls {
    return {
      advance: (ms, ticks = 1) => {
        shiftClock(ms);
        for (let i = 0; i < ticks; i++) this.liveStep();
        this.flush();
      },
      tick: () => {
        this.liveStep();
        this.flush();
      },
      pause: () => {
        this.paused = true;
        this.scheduleLive();
      },
      resume: () => {
        this.paused = false;
        this.scheduleLive();
      },
      addRun: (p) => {
        const id = this.addRun(p);
        this.flush();
        return id;
      },
      failRun: (id, d) => {
        this.failRun(id, d);
        this.flush();
      },
      finishRun: (id) => {
        this.finishRun(id);
        this.flush();
      },
      setStatus: (id, s) => {
        this.setStatus(id, s);
        this.flush();
      },
      setPower: (p) => {
        this.power = { ...this.power, ...p };
        this.evPower.emit({ ...this.power });
      },
      setVisible: (v) => this.evVisible.emit(v),
      openRun: (id) => this.evOpenRun.emit(id),
      flush: () => this.flush(),
      runs: () => [...this.runs.values()].map((r) => ({ ...r.summary })),
      updateInterval: () => this.interval,
    };
  }
}
