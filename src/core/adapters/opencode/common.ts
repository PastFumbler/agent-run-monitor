// Event building shared by the three OpenCode storage generations. In every generation a tool
// call and its result are ONE object updated in place (G1/G2 `part.type = "tool"` with `callID`,
// G3 `content[].type = "tool"` with `id`), so pairing is by construction: we emit the tool_call
// and, once the state is completed/error, a tool_result with the same toolCallId.
// [SRC sst/opencode v1.1.65 session/message-v2.ts; main schema/src/session-message.ts]

import type { TokenUsage } from '@shared/schema';
import type { FileOp, OpenTool, ParsedRun, TurnState } from '../../adapter';
import { emptyRun } from '../../adapter';
import { countDiffLines, diffTexts, newFileDiff, pushChange, splitFileDiffs, type DiffText } from '../../changes';
import { baseName, isObj, pushEvent, toolFilePath, toolInputSummary, toolKind } from '../../events';
import { tokenCount } from '../../usage';
import { resolveIn } from './paths';

export const NO_RECORDS = 'No records this app recognises; the agent may have changed its format.';

/** OpenCode's placeholder title before its title generator runs [SRC v1.1.65 Session.isDefaultTitle]. */
const DEFAULT_TITLE = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T/;

export interface Builder {
  run: ParsedRun;
  /** The session's working folder (native separators), for resolving relative tool paths. */
  dir?: string;
  /** Open tool calls, oldest first. */
  open: Map<string, OpenTool>;
  recognised: number;
}

export function newBuilder(dir: string | undefined, projectName: string | undefined, title: string | undefined): Builder {
  const run = emptyRun(projectName || 'Unknown project');
  if (dir) run.projectPath = dir;
  const t = title?.trim();
  // A generated title wins over the first prompt; pushEvent fills the title from the first user event otherwise.
  if (t && !DEFAULT_TITLE.test(t)) run.title = t.length > 120 ? `${t.slice(0, 117)}…` : t;
  return { run, dir, open: new Map(), recognised: 0 };
}

/**
 * Project name: project.name, else the repo root's (project.worktree) folder name, else the session
 * folder's, so sessions started in a sub-folder of a repo still group under the repo. Non-git
 * folders belong to the "global" project, whose worktree is "/" [SRC Project.ID.global]: skipped.
 */
export function projectLabel(name: string | undefined, worktree: string | undefined, dir: string | undefined): string | undefined {
  if (name?.trim()) return name.trim();
  const w = worktree?.trim();
  if (w && !/^(?:[\\/]+|[A-Za-z]:[\\/]*)$/.test(w)) return baseName(w);
  return dir ? baseName(dir) : undefined;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Usage {input, output, reasoning, cache{read, write}} as TokenUsage. OpenCode already keeps the
 * cache out of `input` [SRC session getUsage]; reasoning is billed as output.
 */
export function usageOf(t: unknown): TokenUsage | undefined {
  if (!isObj(t)) return undefined;
  const cache = isObj(t.cache) ? t.cache : {};
  const out = tokenCount(t.output);
  const reasoning = tokenCount(t.reasoning);
  return {
    input: tokenCount(t.input),
    output: out === undefined && reasoning === undefined ? undefined : (out ?? 0) + (reasoning ?? 0),
    cacheRead: tokenCount(cache.read),
    cacheWrite: tokenCount(cache.write),
  };
}

/** Sums usages field by field (a field stays undefined when no usage reports it). */
export function sumUsage(list: (TokenUsage | undefined)[]): TokenUsage | undefined {
  let out: TokenUsage | undefined;
  for (const u of list) {
    if (!u) continue;
    out ??= {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) if (u[k] !== undefined) out[k] = (out[k] ?? 0) + u[k]!;
  }
  return out;
}

/**
 * A file diff from tool metadata: a unified patch (headers dropped), else before/after texts.
 * additions/deletions, when recorded, are the line counts.
 */
export function fileDiff(patch: unknown, before: unknown, after: unknown, additions?: unknown, deletions?: unknown): DiffText | undefined {
  let d: DiffText | undefined;
  const part = typeof patch === 'string' ? splitFileDiffs(patch)[0] : undefined;
  if (part) d = { diff: part.diff, ...countDiffLines(part.diff) };
  else if (typeof before === 'string' && typeof after === 'string') d = before ? diffTexts(before, after, 1) : newFileDiff(after);
  const add = tokenCount(additions);
  const del = tokenCount(deletions);
  if (add !== undefined && del !== undefined) return { diff: d?.diff ?? '', added: add, removed: del };
  return d;
}

/** What an edit tool's input describes: edit {oldString, newString}, write {content}. */
function inputDiff(input: unknown): DiffText | undefined {
  if (!isObj(input)) return undefined;
  if (typeof input.oldString === 'string' && typeof input.newString === 'string') return diffTexts(input.oldString, input.newString);
  if (typeof input.content === 'string') return newFileDiff(input.content);
  return undefined;
}

/** Model JSON is {id, providerID} (G2/G3 columns, G3 messages) or {modelID, providerID} (G1/G2 messages). */
export function modelName(m: unknown): string | undefined {
  if (typeof m === 'string') {
    try {
      return modelName(JSON.parse(m));
    } catch {
      return m || undefined;
    }
  }
  if (!isObj(m)) return undefined;
  return str(m.id) ?? str(m.modelID);
}

/**
 * Error objects: G3 {type, message, status?}; G1/G2 tagged {name, data: {message, statusCode?}}.
 * MessageAbortedError (G1/G2) means the user interrupted the turn.
 */
export function errorInfo(e: unknown): { text: string; aborted: boolean } | undefined {
  if (!isObj(e)) return typeof e === 'string' && e ? { text: e, aborted: false } : undefined;
  const data = isObj(e.data) ? e.data : {};
  const name = str(e.type) ?? str(e.name) ?? 'Error';
  const msg = str(e.message) ?? str(data.message) ?? '';
  const status = num(e.status) ?? num(data.statusCode);
  if (/abort/i.test(name)) return { text: msg || 'Interrupted', aborted: true };
  const label = name === 'APIError' ? `API error${status ? ` ${status}` : ''}` : name.replace(/Error$/, ' error').trim();
  const text = msg ? `${label}: ${msg}` : label;
  return { text: text.length > 300 ? `${text.slice(0, 297)}…` : text, aborted: false };
}

export interface ToolInfo {
  id?: string;
  name: string;
  /** pending | running | streaming (G3) | completed | error */
  status: string;
  input: unknown;
  output?: string;
  error?: string;
  start?: number;
  end?: number;
  /** Files the tool's metadata says it changed (paths already resolved), with their diff when recorded. */
  files: { path: string; op: FileOp; text: string; diff?: DiffText }[];
  /** Operation for the path in the tool's input, when the metadata does not say. */
  op?: FileOp;
}

/**
 * Emits one tool call (+ its result when finished). An edit tool's input path rides on the
 * tool_call (so pushEvent counts it once); extra files from the metadata become file_change events.
 * Failed edits change nothing, so they carry no path. `touched` collects paths already counted
 * for this step, so the step's patch/snapshot file list does not count them twice.
 */
export function emitTool(b: Builder, t: ToolInfo, fallbackTs: number | undefined, touched: Set<string>): void {
  const kind = t.name === 'question' ? 'other' : toolKind(t.name);
  const ok = t.status !== 'error';
  const raw = kind === 'edit' ? toolFilePath(t.input) : undefined;
  const filePath = raw && ok ? resolveIn(b.dir, raw) : undefined;
  const ts = t.start ?? fallbackTs;
  const opFor = (p: string): FileOp => t.files.find((f) => f.path === p)?.op ?? t.op ?? 'edit';
  pushEvent(b.run, {
    kind: 'tool_call',
    text: toolInputSummary(t.input),
    toolName: t.name,
    toolCallId: t.id,
    toolKind: kind,
    ts,
    ...(filePath ? { filePath, fileOp: opFor(filePath) } : {}),
  });
  if (filePath) touched.add(filePath);
  const key = t.id ?? `${t.name}@${ts ?? b.run.tally.toolCalls}`;
  if (t.status !== 'completed' && t.status !== 'error') {
    b.open.set(key, { name: t.name, kind, since: ts ?? 0 });
    return;
  }
  b.open.delete(key);
  pushEvent(b.run, {
    kind: 'tool_result',
    text: ok ? (t.output ?? '') : t.error || 'The tool failed',
    toolName: t.name,
    toolCallId: t.id,
    toolKind: kind,
    isError: !ok,
    ts: t.end ?? ts,
    ...(t.start != null && t.end != null ? { durationMs: Math.max(0, t.end - t.start) } : {}),
  });
  if (!ok) return;
  const at = t.end ?? ts;
  const change = (path: string, op: FileOp, d: DiffText | undefined) =>
    pushChange(b.run, { ts: at, filePath: path, op, diff: d?.diff, linesAdded: d?.added, linesRemoved: d?.removed, toolCallId: t.id });
  if (filePath) {
    const meta = t.files.find((f) => f.path === filePath);
    change(filePath, opFor(filePath), meta?.diff ?? inputDiff(t.input));
  }
  for (const f of t.files) {
    if (touched.has(f.path)) continue;
    touched.add(f.path);
    pushEvent(b.run, { kind: 'file_change', text: f.text, filePath: f.path, fileOp: f.op, toolCallId: t.id, toolName: t.name, ts: at });
    change(f.path, f.op, f.diff);
  }
}

/** Files a step reports as changed (G1/G2 `patch` part, G3 `snapshot.files`) that no edit tool covered (e.g. a formatter run by shell). */
export function emitStepFiles(b: Builder, files: unknown, ts: number | undefined, touched: Set<string>): void {
  if (!Array.isArray(files)) return;
  for (const f of files) {
    if (typeof f !== 'string' || !f) continue;
    const p = resolveIn(b.dir, f);
    if (touched.has(p)) continue;
    touched.add(p);
    pushEvent(b.run, { kind: 'file_change', text: `Changed ${f}`, filePath: p, fileOp: 'edit', ts });
    pushChange(b.run, { ts, filePath: p, op: 'edit' }); // the step lists the file only: counts unknown
  }
}

/** A question tool still open means the agent is waiting on the user's answer. */
export function settle(b: Builder, turn: TurnState, detail: string | undefined, allowOpen: boolean): void {
  const run = b.run;
  run.turn = turn;
  run.turnDetail = detail;
  const open = allowOpen ? [...b.open.values()] : [];
  run.openTool = open.length ? open[open.length - 1] : undefined;
  if (open.some((t) => t.name === 'question') && (turn === 'in_progress' || turn === 'unknown')) {
    run.turn = 'waiting_input';
    run.turnDetail = 'Waiting for your answer to a question';
    run.openTool = undefined;
  }
}

/** FileDiff status [SRC schema/src/file-diff.ts]: added | deleted | modified. */
export function opOf(status: unknown): FileOp {
  return status === 'added' ? 'create' : status === 'deleted' ? 'delete' : 'edit';
}
