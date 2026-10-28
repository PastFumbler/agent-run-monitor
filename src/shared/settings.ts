// The settings model, shared by main (which stores it) and the renderer (which edits it).
// normalizeSettings() is the only way settings come in from disk or IPC: anything unknown or
// invalid falls back to its default, so a damaged settings file never stops the app.

import { AI_PROVIDERS, cleanModelName, type AiProvider } from './ai';
import { normalizeFolders, type RunFolder } from './folders';
import { AGENT_IDS, RUN_STATUSES, type AgentId, type RunStatus } from './schema';

export const THEME_IDS = ['paper', 'sage', 'dawn', 'dusk', 'moss', 'harbor'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Every run view, in tab order; number key n opens RUN_VIEWS[n-1]. */
export const RUN_VIEWS = ['activity', 'overview', 'files', 'tools', 'timeline', 'changes', 'reasoning'] as const;
export type RunView = (typeof RUN_VIEWS)[number];
/** Views every run has, so they can be the default. Reasoning only exists for runs with readable reasoning. */
export const DEFAULT_VIEWS = RUN_VIEWS.filter((v) => v !== 'reasoning');

export type TriState = 'auto' | 'on' | 'off';
export type TimeFormat = '24h' | '12h' | 'relative';
export type TextSize = 'small' | 'medium' | 'large';
export type Density = 'compact' | 'comfortable';
/** Default: the full app. Simple: only running runs, one large plain line each (readable from across the room). */
export const DISPLAY_TIERS = ['default', 'simple'] as const;
export type DisplayTier = (typeof DISPLAY_TIERS)[number];

/**
 * The colours a user picks for their custom theme (plain #rrggbb). Every other theme token (cards,
 * hover, muted text, borders, focus, status text...) is worked out from these by the renderer
 * (src/renderer/src/theme/custom.ts). A custom theme is never one of the presets in THEME_IDS.
 */
export interface CustomTheme {
  bg: string;
  surface: string;
  text: string;
  accent: string;
  status: Record<RunStatus, string>;
}

export interface SourceSettings {
  enabled: boolean;
  customRoots: string[];
}

export interface SavedLayout {
  name: string;
  runIds: string[];
}

export interface Settings {
  /** Bumped when the shape changes; normalizeSettings migrates older files. */
  version: 1;
  firstRunComplete: boolean;
  sources: Record<AgentId, SourceSettings>;
  /** Extra folders scanned for per-project agents (Aider writes into each project). */
  projectRoots: string[];
  /** How often live runs are re-checked, in milliseconds. */
  refreshMs: number;
  defaultView: RunView;
  /**
   * Sidebar Recent order. On: by last update (runs with new activity move up). Off: fixed; a newly
   * opened run goes on top and the others keep their places. Opening a run never reorders either way.
   */
  moveUpdatedToTop: boolean;
  /** Tiles per multiviewer page, 1-12. */
  gridTileLimit: number;
  notifyOnFinish: boolean;
  notifyOnFailure: boolean;
  reduceMotion: TriState;
  lowGpu: TriState;
  synonyms: boolean;
  fakeProgress: boolean;
  /** The preset in use, and the one a custom theme falls back to. */
  theme: ThemeId;
  /** The saved custom theme, or null when there is none. */
  customTheme: CustomTheme | null;
  /** Use customTheme instead of the preset. Only ever true while a custom theme is saved. */
  useCustomTheme: boolean;
  displayTier: DisplayTier;
  textSize: TextSize;
  density: Density;
  timeFormat: TimeFormat;
  startWithOs: boolean;
  /** Show runs updated within this many days (0 = all). */
  historyDays: number;
  maskSecrets: boolean;
  checkForUpdates: boolean;
  /**
   * Optional AI summaries in Overview (off by default). When on, main sends the masked content of the
   * run being viewed to `aiProvider`. Changing the provider turns this off until the user confirms again.
   */
  aiSummaries: boolean;
  aiProvider: AiProvider;
  /** The model to ask; '' means the provider's default (DEFAULT_MODELS in src/shared/ai.ts). */
  aiModel: string;
  pinned: string[];
  layouts: SavedLayout[];
  /** The user's run folders, in creation order (see src/shared/folders.ts). */
  folders: RunFolder[];
  /** Run id -> folder id. Runs without an entry are unfiled. */
  runFolders: Record<string, string>;
}

export const REFRESH_CHOICES = [1000, 2000, 5000, 10000, 30000] as const;
export const HISTORY_CHOICES = [1, 3, 7, 14, 30, 90, 0] as const;

export function defaultSettings(): Settings {
  const sources = {} as Record<AgentId, SourceSettings>;
  for (const id of AGENT_IDS) sources[id] = { enabled: true, customRoots: [] };
  return {
    version: 1,
    firstRunComplete: false,
    sources,
    projectRoots: [],
    refreshMs: 2000,
    defaultView: 'activity',
    moveUpdatedToTop: true,
    gridTileLimit: 12,
    notifyOnFinish: true,
    notifyOnFailure: true,
    reduceMotion: 'auto',
    lowGpu: 'auto',
    synonyms: true,
    fakeProgress: true,
    theme: 'paper',
    customTheme: null,
    useCustomTheme: false,
    displayTier: 'default',
    textSize: 'medium',
    density: 'comfortable',
    timeFormat: '24h',
    startWithOs: false,
    historyDays: 14,
    maskSecrets: true,
    checkForUpdates: false,
    aiSummaries: false,
    aiProvider: 'anthropic',
    aiModel: '',
    pinned: [],
    layouts: [],
    folders: [],
    runFolders: {},
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown): string | null => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);

/** A stored custom theme, or null unless every colour is a plain #rrggbb. */
export function normalizeCustomTheme(raw: unknown): CustomTheme | null {
  if (!isObj(raw) || !isObj(raw.status)) return null;
  const rawStatus = raw.status;
  const base = { bg: hex(raw.bg), surface: hex(raw.surface), text: hex(raw.text), accent: hex(raw.accent) };
  if (!base.bg || !base.surface || !base.text || !base.accent) return null;
  const status = {} as Record<RunStatus, string>;
  for (const st of RUN_STATUSES) {
    const c = hex(rawStatus[st]);
    if (!c) return null;
    status[st] = c;
  }
  return { bg: base.bg, surface: base.surface, text: base.text, accent: base.accent, status };
}

const strings = (v: unknown, max = 200) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 4096).slice(0, max) : [];

export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const sources = { ...d.sources };
  if (isObj(raw.sources)) {
    for (const id of AGENT_IDS) {
      const s = raw.sources[id];
      if (isObj(s)) sources[id] = { enabled: bool(s.enabled, true), customRoots: strings(s.customRoots, 50) };
    }
  }
  const layouts: SavedLayout[] = Array.isArray(raw.layouts)
    ? raw.layouts
        .filter(isObj)
        .filter((l) => typeof l.name === 'string' && l.name.trim().length > 0)
        .map((l) => ({ name: String(l.name).slice(0, 80), runIds: strings(l.runIds, 100) }))
        .slice(0, 50)
    : [];
  const { folders, runFolders } = normalizeFolders(raw.folders, raw.runFolders);
  const customTheme = normalizeCustomTheme(raw.customTheme);
  return {
    version: 1,
    firstRunComplete: bool(raw.firstRunComplete, false),
    sources,
    projectRoots: strings(raw.projectRoots, 50),
    refreshMs: int(raw.refreshMs, d.refreshMs, 500, 60000),
    defaultView: pick(raw.defaultView, DEFAULT_VIEWS, d.defaultView),
    moveUpdatedToTop: bool(raw.moveUpdatedToTop, d.moveUpdatedToTop),
    gridTileLimit: int(raw.gridTileLimit, d.gridTileLimit, 1, 12),
    notifyOnFinish: bool(raw.notifyOnFinish, d.notifyOnFinish),
    notifyOnFailure: bool(raw.notifyOnFailure, d.notifyOnFailure),
    reduceMotion: pick(raw.reduceMotion, ['auto', 'on', 'off'] as const, d.reduceMotion),
    lowGpu: pick(raw.lowGpu, ['auto', 'on', 'off'] as const, d.lowGpu),
    synonyms: bool(raw.synonyms, d.synonyms),
    fakeProgress: bool(raw.fakeProgress, d.fakeProgress),
    theme: pick(raw.theme, THEME_IDS, d.theme),
    customTheme,
    useCustomTheme: customTheme !== null && bool(raw.useCustomTheme, d.useCustomTheme),
    displayTier: pick(raw.displayTier, DISPLAY_TIERS, d.displayTier),
    textSize: pick(raw.textSize, ['small', 'medium', 'large'] as const, d.textSize),
    density: pick(raw.density, ['compact', 'comfortable'] as const, d.density),
    timeFormat: pick(raw.timeFormat, ['24h', '12h', 'relative'] as const, d.timeFormat),
    startWithOs: bool(raw.startWithOs, d.startWithOs),
    historyDays: int(raw.historyDays, d.historyDays, 0, 3650),
    maskSecrets: bool(raw.maskSecrets, d.maskSecrets),
    checkForUpdates: bool(raw.checkForUpdates, d.checkForUpdates),
    aiSummaries: bool(raw.aiSummaries, d.aiSummaries),
    aiProvider: pick(raw.aiProvider, AI_PROVIDERS, d.aiProvider),
    aiModel: cleanModelName(raw.aiModel),
    pinned: strings(raw.pinned, 500),
    layouts,
    folders,
    runFolders,
  };
}

/**
 * AI summaries send run content to one provider the user agreed to. A change of provider turns them
 * off unless the same change turns them on (the user confirmed the new provider). Applied by both
 * backends after merging a patch.
 */
export function guardAiProvider(prev: Settings, next: Settings, patch: Partial<Settings>): Settings {
  if (next.aiProvider !== prev.aiProvider && patch.aiSummaries !== true) return { ...next, aiSummaries: false };
  return next;
}
