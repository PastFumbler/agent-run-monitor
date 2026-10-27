// Helpers shared by the Gemini CLI and Qwen Code parsers. Both tools store Gemini API
// `Content`/`Part` objects ({text}, {text, thought:true}, {functionCall}, {functionResponse}),
// and both describe file edits with the same `FileDiff` shape (Qwen forked Gemini CLI in 2025).

import { posix, win32 } from 'node:path';
import type { FileOp, TokenUsage, ToolKind } from '@shared/schema';
import type { Env, ParsedRun } from '../../adapter';
import { countDiffLines, pushChange, splitFileDiffs } from '../../changes';
import { isObj, MAX_TEXT, textOf, toolKind } from '../../events';
import { tokenCount } from '../../usage';

export type Part = Record<string, unknown>;

/** Path functions for the platform being described (tests describe other OSes than the host). */
export function pathApi(env: Env): typeof posix {
  return env.platform === 'win32' ? win32 : posix;
}

/** `~` and `~/x` in an override env var mean the user's home, as both CLIs resolve them. */
export function expandHome(p: string, env: Env): string {
  if (p === '~') return env.home;
  if (/^~[\\/]/.test(p)) return pathApi(env).join(env.home, p.slice(2));
  return p;
}

/** A `PartListUnion` (string | Part | Part[]) as a list of parts. */
export function partsOf(c: unknown): Part[] {
  if (c == null) return [];
  if (typeof c === 'string') return [{ text: c }];
  if (Array.isArray(c)) return c.flatMap((x) => (typeof x === 'string' ? [{ text: x }] : isObj(x) ? [x] : []));
  return isObj(c) ? [c] : [];
}

/** The visible text of some parts (thought parts excluded). */
export function partsText(c: unknown, sep = ''): string {
  return partsOf(c)
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join(sep);
}

/** Thought-summary parts (`{text, thought:true}`). */
export function thoughtTexts(c: unknown): string[] {
  return partsOf(c)
    .filter((p) => p.thought === true && typeof p.text === 'string' && p.text.trim())
    .map((p) => p.text as string);
}

/**
 * Gemini CLI's own "is this a real prompt" rule (sessionUtils): slash commands, `?` help and
 * injected context blocks are not prompts the user typed.
 */
export function isMetaPrompt(text: string): boolean {
  return /^(\/|\?|<session_context>|<hook_context>)/.test(text.trim());
}

const EXTRA_KINDS: Record<string, ToolKind> = {
  notebook_edit: 'edit',
  invoke_agent: 'agent',
  ask_user: 'other',
  ask_user_question: 'other',
  todo_write: 'other',
  write_todos: 'other',
};

/** toolKind() plus the few Gemini/Qwen tool names the shared table does not know. */
export function kindOf(name: string | undefined): ToolKind {
  return (name && EXTRA_KINDS[name]) || toolKind(name);
}

/** Tools that stop the turn to ask the user something while they are open. */
export function isQuestionTool(name: string | undefined): boolean {
  return !!name && /^(ask_user|ask_user_question|exit_plan_mode)$/.test(name);
}

/** Text and error flag of a `functionResponse.response` ({output} or {error}). */
export function responseOf(fr: unknown): { text: string; isError: boolean } {
  const resp = isObj(fr) ? fr.response : undefined;
  if (!isObj(resp)) return { text: textOf(resp), isError: false };
  if (resp.error !== undefined && resp.error !== null) return { text: textOf(resp.error), isError: true };
  if (resp.output !== undefined) return { text: textOf(resp.output), isError: false };
  return { text: textOf(resp), isError: false };
}

export interface FileDiffInfo {
  filePath?: string;
  fileOp: FileOp;
  diff: string;
}

/** A `FileDiff` result display, as both tools record it for edit/write tools. */
export function fileDiffOf(rd: unknown): FileDiffInfo | undefined {
  if (!isObj(rd) || typeof rd.fileDiff !== 'string') return undefined;
  const filePath =
    typeof rd.filePath === 'string' && rd.filePath ? rd.filePath : typeof rd.fileName === 'string' ? rd.fileName : undefined;
  const created = rd.isNewFile === true || ('originalContent' in rd && rd.originalContent === null);
  return { filePath, fileOp: created ? 'create' : 'edit', diff: rd.fileDiff };
}

/** What a finished tool shows: the diff for edits, the display string, else the raw response. */
export function resultText(resultDisplay: unknown, response: { text: string }): string {
  const diff = fileDiffOf(resultDisplay);
  if (diff) return diff.diff;
  if (typeof resultDisplay === 'string' && resultDisplay.trim()) return resultDisplay;
  return response.text;
}

/**
 * Gemini API token counts as TokenUsage: the prompt count includes the cached part (reported
 * apart), thoughts are billed as output, tool-use prompt tokens are input.
 */
export function geminiUsage(prompt: unknown, cached: unknown, output: unknown, thoughts: unknown, tool: unknown): TokenUsage {
  const p = tokenCount(prompt);
  const c = tokenCount(cached);
  const o = tokenCount(output);
  const t = tokenCount(thoughts);
  return {
    input: p === undefined ? undefined : Math.max(0, p - (c ?? 0)) + (tokenCount(tool) ?? 0),
    cacheRead: c,
    output: o === undefined && t === undefined ? undefined : (o ?? 0) + (t ?? 0),
  };
}

/** Records one successful edit, with the FileDiff's hunks and counts when the tool left one. */
export function noteFileChange(run: ParsedRun, diff: FileDiffInfo | undefined, filePath: string, fileOp: FileOp, ts: number | undefined, id: string | undefined): void {
  const part = diff ? splitFileDiffs(diff.diff)[0] : undefined;
  const n = part ? countDiffLines(part.diff) : undefined;
  pushChange(run, { ts, filePath, op: fileOp, diff: part?.diff, linesAdded: n?.added, linesRemoved: n?.removed, toolCallId: id });
}

/** File op for an edit tool that left no FileDiff. */
export function opForTool(name: string | undefined): FileOp {
  return name === 'delete_file' ? 'delete' : 'edit';
}

/** Longest string kept inside tool arguments in the reduced Gemini state. */
const ARGS_MAX = 2000;

/**
 * A copy small enough to keep between parses: long strings clipped, whole-file snapshots in
 * FileDiff (`originalContent`/`newContent`) and inline binary data dropped.
 */
export function slim(v: unknown, depth = 0, max = MAX_TEXT): unknown {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth > 12) return undefined; // nothing we read is this deep; never keep it unclipped
  if (Array.isArray(v)) return v.map((x) => slim(x, depth + 1, max));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === '__proto__') continue;
    if ((k === 'originalContent' || k === 'newContent') && x !== null) continue;
    if (k === 'inlineData' && isObj(x)) {
      out[k] = { mimeType: x.mimeType };
      continue;
    }
    // Tool arguments (write_file content, replace old/new strings) are only shown through
    // toolInputSummary (2000 chars) and toolFilePath, so keep them much shorter.
    out[k] = slim(x, depth + 1, k === 'args' ? Math.min(max, ARGS_MAX) : max);
  }
  return out;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
