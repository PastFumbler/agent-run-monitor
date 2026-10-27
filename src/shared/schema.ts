// The common run and event schema. The renderer knows only these types: no adapter type
// and no raw agent format ever crosses the IPC boundary.

export const AGENT_IDS = [
  'claude-code',
  'codex',
  'gemini-cli',
  'qwen-code',
  'copilot-vscode',
  'copilot-cli',
  'aider',
  'cursor',
  'cline',
  'roo-code',
  'opencode',
  'continue',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  'qwen-code': 'Qwen Code',
  'copilot-vscode': 'Copilot (VS Code)',
  'copilot-cli': 'Copilot CLI',
  aider: 'Aider',
  cursor: 'Cursor',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  opencode: 'OpenCode',
  continue: 'Continue',
};

/**
 * running    - the agent is working right now (recent writes, or a tool call is open)
 * waiting    - the agent stopped to ask the user something (approval, a question)
 * idle       - the last turn finished recently; the session may continue
 * done       - finished and quiet for a while
 * failed     - the last turn ended in an error (API error, crash, aborted with error)
 * stuck      - looked busy but nothing has happened for too long
 * unreadable - the file could not be parsed
 */
export const RUN_STATUSES = ['running', 'waiting', 'idle', 'done', 'failed', 'stuck', 'unreadable'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses that count as "active" for live views, synonyms and the fake progress bar. */
export const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(['running']);
/** Statuses that need the user's attention. */
export const ATTENTION_STATUSES: ReadonlySet<RunStatus> = new Set(['waiting', 'failed', 'stuck', 'unreadable']);

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stuck: 'Stuck',
  unreadable: "Couldn't read this run",
};

export interface RunCounts {
  events: number;
  messages: number;
  toolCalls: number;
  errors: number;
  filesChanged: number;
}

/**
 * Token counts exactly as the source records them. A field the source does not record is
 * undefined (show "not reported"), never 0, and nothing is ever estimated. Where a source's input
 * figure includes the prompt cache and the split is documented (Anthropic, OpenAI/Codex,
 * Gemini/Qwen, Copilot, OpenCode), `input` is the uncached part, so total input = input +
 * cacheRead + cacheWrite. Cline, Roo Code, Continue and Aider record provider-dependent figures,
 * kept as recorded. Sources that report one combined input figure leave the cache fields undefined.
 */
export interface TokenUsage {
  /** Input tokens not read from or written to the prompt cache (see above for the exceptions). */
  input?: number;
  /** Output tokens, including reasoning ("thinking") tokens where the source reports them. */
  output?: number;
  /** Input tokens read from the prompt cache (cache hits). */
  cacheRead?: number;
  /** Input tokens written to the prompt cache (cache creation). */
  cacheWrite?: number;
}

/** A run's token totals, plus the same counts per local calendar day. */
export interface RunUsage extends TokenUsage {
  /**
   * Usage per local day ('YYYY-MM-DD', see shared/usage.ts dayKey) of the message or record that
   * reported it. Tokens whose time the source does not record count in the totals only, so the
   * days may add up to less than the totals; the remainder has no known time.
   */
  byDay?: Record<string, TokenUsage>;
}

export interface RunSummary {
  /** Stable across restarts: `${agent}:${hash}`. */
  id: string;
  agent: AgentId;
  title: string;
  projectName: string;
  projectPath?: string;
  gitBranch?: string;
  model?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  updatedAt: number;
  status: RunStatus;
  /** Plain words that explain the status, e.g. "Waiting for tool approval". */
  statusDetail?: string;
  /**
   * True when the status is inferred, not recorded: the agent's files cannot show an approval
   * prompt, so a quiet open tool call is read as waiting. The UI then says "Probably waiting for you".
   */
  statusInferred?: boolean;
  counts: RunCounts;
  /**
   * Token usage. Absent when the source did not report any usage for this run: the UI says
   * "not reported", never 0.
   */
  usage?: RunUsage;
  /**
   * True when the run has at least one reasoning event with readable text. Reasoning the source
   * stored without its text (placeholder events) does not count.
   */
  hasReasoning?: boolean;
  /** Where the run was read from, shown in Overview so users can find the file. */
  sourcePath: string;
  /** Set when status is 'unreadable'. */
  readError?: string;
  /** The tool currently open, if any (for live chips). */
  currentTool?: string;
  /** Parent run, for sub-agent runs (e.g. Claude Code sidechains, workflow agents). */
  parentId?: string;
}

export const EVENT_KINDS = [
  'user',
  'assistant',
  'reasoning',
  'tool_call',
  'tool_result',
  'file_change',
  'error',
  'system',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type ToolKind = 'run' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'other';
export type FileOp = 'create' | 'edit' | 'delete';

export interface RunEvent {
  /** Monotonic within a run, starting at 0. */
  seq: number;
  /** Epoch milliseconds, when the source records it. */
  ts?: number;
  kind: EventKind;
  /** Display text, already masked when masking is on. May be long; the UI truncates. */
  text: string;
  toolName?: string;
  toolCallId?: string;
  toolKind?: ToolKind;
  filePath?: string;
  fileOp?: FileOp;
  isError?: boolean;
  /** For tool calls whose result has arrived. */
  durationMs?: number;
  /**
   * Tokens newly reported with this event: for most sources the usage of the model message the
   * event belongs to (on its first event only). Already counted in RunSummary.usage.
   */
  usage?: TokenUsage;
  /** The source stored no readable text for this event (e.g. reasoning kept only as a signature); `text` is a stand-in. */
  placeholder?: boolean;
}

/**
 * One edit an agent made to a file. Line counts are exact when known and undefined when the
 * source does not record the edit's content (show "unknown", never 0).
 */
export interface CodeChange {
  /** Epoch ms, when the source records it. */
  ts?: number;
  filePath: string;
  op: FileOp;
  linesAdded?: number;
  linesRemoved?: number;
  /**
   * Unified-diff style text when the source records the edit's content: hunks start with "@@"
   * (with line numbers when they are known), then lines starting with " ", "+" or "-". Masked
   * like event text.
   */
  diff?: string;
  /** The diff was cut (or dropped) to keep memory bounded. Line counts stay exact. */
  truncated?: boolean;
  toolCallId?: string;
}

export interface FileChangeSummary {
  path: string;
  ops: FileOp[];
  count: number;
  lastTs?: number;
}

export interface ToolCallSummary {
  toolCallId?: string;
  toolName: string;
  toolKind: ToolKind;
  input: string;
  output?: string;
  isError?: boolean;
  startedAt?: number;
  durationMs?: number;
  open: boolean;
}

/** Everything a run view needs. Events are the newest `limit` events, oldest first. */
export interface RunDetail {
  summary: RunSummary;
  events: RunEvent[];
  /** Total events in the run (events may be a tail window). */
  totalEvents: number;
  files: FileChangeSummary[];
  tools: ToolCallSummary[];
  /** Edits in time order, oldest first (may be a tail window, see totalChanges). */
  changes: CodeChange[];
  /** Total edits in the run (changes may be a tail window). */
  totalChanges: number;
}

/** What the first-run wizard and the sources settings show per agent. */
export interface SourceStatus {
  agent: AgentId;
  displayName: string;
  enabled: boolean;
  /** Default locations checked for this OS, with whether each exists. */
  defaultRoots: { path: string; exists: boolean }[];
  customRoots: { path: string; exists: boolean }[];
  runCount: number;
  /** One line on what this adapter reads and how well it is verified. */
  note: string;
  /** 'verified' = checked against a real installation; 'source' = checked against the tool's source code; 'best-effort' = neither. */
  confidence: 'verified' | 'source' | 'best-effort';
  error?: string;
}
