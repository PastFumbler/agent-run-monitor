// The source adapter contract. Each agent gets one small adapter that finds its session files
// (discover) and turns one of them into the common schema (parse). Adapters never write.
// See CONTRIBUTING.md, "Adding a source adapter".

import type { AgentId, EventKind, FileOp, RunEvent, ToolKind } from '@shared/schema';

/** Where an adapter looks. Injected so tests can point adapters at fixture folders. */
export interface Env {
  platform: NodeJS.Platform;
  /** The user's home directory. */
  home: string;
  /** process.env (or a test copy), for the agents' own overrides such as CODEX_HOME. */
  vars: Record<string, string | undefined>;
}

/** One session found by discover(): stat information only, no content read yet. */
export interface SessionRef {
  agent: AgentId;
  /** The file (or folder, or database) the run lives in. */
  path: string;
  /** Distinguishes several runs inside one file (e.g. one SQLite database holding many chats). */
  subId?: string;
  mtimeMs: number;
  size: number;
  /** Anything discover() learned cheaply that parse() can reuse (project folder, workspace). */
  hint?: Record<string, string>;
}

/** How the run's last turn stands, as far as the adapter can tell from the file. */
export type TurnState =
  | 'in_progress' // the agent was mid-turn at the last record
  | 'completed' // the last turn ended normally
  | 'waiting_input' // the agent asked the user for approval or an answer
  | 'error' // the last turn ended in an error
  | 'aborted' // the user interrupted / cancelled
  | 'unknown';

export interface OpenTool {
  name: string;
  kind: ToolKind;
  /** Epoch ms when the call started. */
  since: number;
}

/** What parse() returns: the run without a final status. core/status.ts judges the status. */
export interface ParsedRun {
  title: string;
  projectName: string;
  projectPath?: string;
  gitBranch?: string;
  model?: string;
  startedAt?: number;
  /** Timestamp of the newest record, if the format has timestamps. */
  lastEventAt?: number;
  events: Omit<RunEvent, 'seq'>[];
  turn: TurnState;
  /** Plain words for an error or wait, e.g. "API error: overloaded". */
  turnDetail?: string;
  openTool?: OpenTool;
  inputTokens?: number;
  outputTokens?: number;
  /** Records the adapter did not recognise (counted, never fatal). */
  skipped: number;
  /** The file the parent run (the session that started this sub-agent) lives in. */
  parentPath?: string;
  /**
   * The parent's SessionRef.subId, when the parent is one of several runs inside parentPath (a
   * session in a shared SQLite database). Omit for parents that are a file of their own.
   */
  parentSubId?: string;
  /** Set when the file could not be read at all; the run shows as "couldn't read this run". */
  readError?: string;
  /** Running totals: events may be capped (see MAX_EVENTS) but these always count everything. */
  tally: { events: number; messages: number; toolCalls: number; errors: number };
  files: Record<string, { ops: FileOp[]; count: number; lastTs?: number }>;
  /** Events dropped from the front because of MAX_EVENTS. */
  dropped: number;
}

/** Adapter-owned state carried between incremental parses of the same file. */
export interface ParseState {
  /** Byte offset already consumed (JSONL adapters). */
  offset: number;
  /** Size and mtime when last parsed, so whole-file adapters can skip unchanged files. */
  size: number;
  mtimeMs: number;
  /** The run so far. */
  run: ParsedRun;
  /** Anything else the adapter needs (pending tool calls by id, etc.). Must be plain data. */
  extra: Record<string, unknown>;
}

export interface SourceAdapter {
  id: AgentId;
  displayName: string;
  /** How well the format is known: see SourceStatus.confidence. */
  confidence: 'verified' | 'source' | 'best-effort';
  /** One line for the wizard: what it reads. */
  note: string;
  /** Folders (or files) to look in on this OS, honouring the agent's own env overrides. */
  defaultRoots(env: Env): string[];
  /**
   * Lists sessions under the given roots. Cheap: readdir + stat only (whole-file JSON formats may
   * read a small index). `projectRoots` are user-chosen folders for per-project agents (Aider).
   */
  discover(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]>;
  /**
   * Parses one session. With `prev`, continue from where the last parse stopped when the format
   * allows it (append-only JSONL), else re-read. Throwing is allowed: safeParse turns any throw
   * into an 'unreadable' run.
   */
  parse(ref: SessionRef, prev: ParseState | undefined, ctx: ParseContext): Promise<ParseState>;
  /**
   * Optional: false for watched paths that can never affect a run (caches, backups), so they do
   * not trigger a re-discovery. Default: every change is relevant.
   */
  isRelevantChange?(path: string): boolean;
  /**
   * Optional: true for side files that change a live run's state without touching its session
   * file (e.g. a "waiting for approval" registry). The store then re-parses this adapter's active
   * runs (running, waiting, idle, stuck).
   */
  isLiveSignal?(path: string): boolean;
}

export interface DiscoverContext {
  env: Env;
  /** Only sessions modified at or after this time (epoch ms; 0 = all). */
  since: number;
  projectRoots: string[];
  /** A scratch folder for adapters that must copy a file to list its sessions (SQLite). */
  tempDir?: string;
}

export interface ParseContext {
  env: Env;
  /** A scratch folder adapters may copy files into before reading (SQLite). Never the source folder. */
  tempDir: string;
}

export function emptyRun(projectName = 'Unknown project'): ParsedRun {
  return {
    title: '',
    projectName,
    events: [],
    turn: 'unknown',
    skipped: 0,
    tally: { events: 0, messages: 0, toolCalls: 0, errors: 0 },
    files: {},
    dropped: 0,
  };
}

export function freshState(): ParseState {
  return { offset: 0, size: 0, mtimeMs: 0, run: emptyRun(), extra: {} };
}

/** Helper for building events with the right optional fields. */
export function ev(
  kind: EventKind,
  text: string,
  extra: Partial<Omit<RunEvent, 'seq' | 'kind' | 'text'>> = {},
): Omit<RunEvent, 'seq'> {
  return { kind, text, ...extra };
}

export type { FileOp, ToolKind };
