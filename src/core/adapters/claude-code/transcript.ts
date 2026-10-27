// Parses one Claude Code transcript (main session, Agent-tool sub-agent or workflow agent).
//
// Format (verified on a real install, CLI 2.1.293 to 2.1.309, plus the v2.1.310 bundle):
// - one JSON record per line, append-only, written while we read it;
// - every `assistant` record holds exactly ONE content block; blocks of one API message share
//   `message.id` and repeat the same `usage`, so tokens are counted once per message id;
// - `user` records carry prompts, tool results (paired by tool_use.id == tool_result.tool_use_id),
//   meta injections (isMeta, <system-reminder>, <command-name>, task notifications) and the
//   interrupt markers "[Request interrupted by user]" / "... for tool use";
// - API failures are `assistant` records with isApiErrorMessage and model "<synthetic>";
//   `system/api_error` is a retry notice, not the end of a turn;
// - `stop_reason` is often null in sub-agent files, so it is a hint only.
// Many record types are bookkeeping (titles, cost, request blobs); they are recognised and skipped.

import { basename } from 'node:path';
import type { TokenUsage } from '@shared/schema';
import type { ParsedRun, ParseState, SessionRef, ToolKind } from '../../adapter';
import { freshState } from '../../adapter';
import { capDiff, diffFromHunks, diffTexts, newFileDiff, pushChange, type DiffText } from '../../changes';
import { addUsage, tokenCount } from '../../usage';
import { baseName, isObj, makeTitle, pushEvent, textOf, toMs, toolFilePath, toolInputSummary, toolKind } from '../../events';
import { readJsonl } from '../../jsonl';
import { cloneState, readSmallJson } from './io';
import { rootOfSession, type ClaudeRunKind } from './paths';
import { liveEntry, waitDetail } from './registry';
import { workflowAgentVerdict } from './workflow';
import { SHELL_STUCK_AFTER, STUCK_AFTER, TOOL_STUCK_AFTER } from '../../status';

/** Bump when the extra-state shape or parsing rules change: older states are re-read from 0. */
const STATE_VERSION = 3;

interface PendingTool {
  id: string;
  name: string;
  kind: ToolKind;
  since?: number;
  filePath?: string;
  /** For edit tools: the change as the call's input describes it, used when the result has no patch. */
  edit?: DiffText;
}

export interface TranscriptExtra {
  [k: string]: unknown;
  v: number;
  kind: ClaudeRunKind;
  pending: PendingTool[];
  recognised: number;
  firstPrompt?: string;
  customTitle?: string;
  aiTitle?: string;
  summaryTitle?: string;
  lastPrompt?: string;
  metaTitle?: string;
  /** Usage of the message currently being written, so repeated blocks are counted once. */
  msgId?: string;
  msgUsage?: TokenUsage;
  /** The turn as the transcript alone shows it (the registry may override it per parse). */
  baseTurn?: ParsedRun['turn'];
  baseDetail?: string;
}

/** Types that are known bookkeeping: recognised, never shown. */
const QUIET_TYPES = new Set([
  'queue-operation', 'atis-latch', 'mode', 'cost-state', 'api-request', 'api-request-blob', 'api-request-shape',
  'file-history-snapshot', 'file-history-delta', 'teleported-from', 'progress', 'agent-name',
]);

/** Tools that stop and ask the user; an open call means the run waits on them. */
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// Injected context, not words the user typed. Checked per text block: on the real install a
// human prompt can lead with an `<ide_opened_file>`, `<ide_selection>` or `<system-reminder>`
// block followed by the actual prompt in a second block.
const WRAPPER = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|ide_[a-z_]+)\b/;
/** A prompt-style slash command (skill or custom command): it starts a model turn. */
const PROMPT_COMMAND = /^<command-message>/;
const MAX_PROMPT_KEPT = 2000;
const INTERRUPT = /^\[Request interrupted\b/;
const HARNESS_LINE = /^\[Workflow harness[^\]]*\].*$/gm;

/** Claude-specific tool kinds on top of the shared name rules. */
export function claudeToolKind(name: string): ToolKind {
  if (name === 'Workflow' || name === 'SendMessage') return 'agent';
  if (name === 'StructuredOutput') return 'other';
  return toolKind(name);
}

/** Raw API request records can be several MB each and are never shown: skip them unparsed. */
const API_BLOB = /"type"\s*:\s*"api-request/;
function isApiBlob(head: string): boolean {
  return API_BLOB.test(head);
}

export async function parseTranscript(ref: SessionRef, prev: ParseState | undefined, kind: ClaudeRunKind, parentPath?: string): Promise<ParseState> {
  const continuing = !!prev && prev.extra.v === STATE_VERSION && prev.extra.kind === kind && prev.offset <= ref.size;
  const st = continuing ? cloneState(prev!) : freshState();
  if (!continuing) await initFresh(st, ref, kind);
  const x = st.extra as TranscriptExtra;
  const run = st.run;
  run.parentPath = parentPath;
  if (x.baseTurn) {
    run.turn = x.baseTurn;
    run.turnDetail = x.baseDetail;
  }

  const res = await readJsonl(ref.path, st.offset, (rec) => handleRecord(rec, run, x), { skipLine: isApiBlob });
  if (res.restarted && continuing) return parseTranscript(ref, undefined, kind, parentPath); // file was rewritten
  st.offset = res.offset;
  st.size = res.size;
  st.mtimeMs = res.mtimeMs;
  run.skipped += res.bad;

  finalize(run, x, st.offset);
  if (kind === 'session') await applyRegistry(ref, run, x);
  else if (kind === 'workflow-agent') await applyJournal(ref, run, st.mtimeMs);
  return st;
}

async function initFresh(st: ParseState, ref: SessionRef, kind: ClaudeRunKind): Promise<void> {
  const extra: TranscriptExtra = { v: STATE_VERSION, kind, pending: [], recognised: 0 };
  st.extra = extra;
  st.run.projectName = ref.hint?.project || 'Unknown project';
  if (kind === 'subagent' || kind === 'workflow-agent') {
    // agent-<id>.meta.json: {agentType, description, ...}; description is the label the user saw.
    const meta = await readSmallJson(ref.path.replace(/\.jsonl$/, '.meta.json'), 64 * 1024);
    if (isObj(meta) && typeof meta.description === 'string' && meta.description.trim()) extra.metaTitle = meta.description.trim();
  }
}

// ---------------------------------------------------------------------------------------------
// Records

function handleRecord(rec: unknown, run: ParsedRun, x: TranscriptExtra): void {
  if (!isObj(rec) || typeof rec.type !== 'string') {
    run.skipped++;
    return;
  }
  const type = rec.type;
  // Older layouts kept sub-agent records inline in the main file (unverified); keep them out of
  // the main run's turn state.
  if (x.kind === 'session' && rec.isSidechain === true && (type === 'user' || type === 'assistant' || type === 'attachment' || type === 'system')) {
    x.recognised++;
    return;
  }
  noteEnvelope(rec, run);
  switch (type) {
    case 'assistant':
      return count(x, onAssistant(rec, run, x), run);
    case 'user':
      return count(x, onUser(rec, run, x), run);
    case 'system':
      x.recognised++;
      return onSystem(rec, run);
    case 'attachment':
      x.recognised++;
      return onAttachment(rec, run);
    case 'custom-title':
      x.recognised++;
      if (typeof rec.customTitle === 'string' && rec.customTitle.trim()) x.customTitle = rec.customTitle;
      return;
    case 'ai-title':
      x.recognised++;
      if (typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) x.aiTitle = rec.aiTitle;
      return;
    case 'summary':
      x.recognised++;
      if (typeof rec.summary === 'string' && rec.summary.trim()) x.summaryTitle = rec.summary;
      return;
    case 'last-prompt':
      x.recognised++;
      if (typeof rec.lastPrompt === 'string' && rec.lastPrompt.trim()) x.lastPrompt = rec.lastPrompt;
      return;
    default:
      if (QUIET_TYPES.has(type)) x.recognised++;
      else run.skipped++;
  }
}

function count(x: TranscriptExtra, ok: boolean, run: ParsedRun): void {
  if (ok) x.recognised++;
  else run.skipped++;
}

/**
 * cwd (first one wins: later ones come from worktrees and cd), the latest git branch, and the
 * time span of every timestamped record (queue operations and hook output count as activity).
 */
function noteEnvelope(rec: Record<string, unknown>, run: ParsedRun): void {
  const ts = toMs(rec.timestamp);
  if (ts) {
    if (!run.startedAt || ts < run.startedAt) run.startedAt = ts;
    if (!run.lastEventAt || ts > run.lastEventAt) run.lastEventAt = ts;
  }
  if (!run.projectPath && typeof rec.cwd === 'string' && rec.cwd) {
    run.projectPath = rec.cwd;
    run.projectName = baseName(rec.cwd) || run.projectName;
  }
  if (typeof rec.gitBranch === 'string' && rec.gitBranch) run.gitBranch = rec.gitBranch;
}

function blocksOf(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

// ---------------------------------------------------------------------------------------------
// assistant

function onAssistant(rec: Record<string, unknown>, run: ParsedRun, x: TranscriptExtra): boolean {
  const msg = rec.message;
  if (!isObj(msg)) return false;
  const ts = toMs(rec.timestamp);
  const synthetic = msg.model === '<synthetic>';
  if (typeof msg.model === 'string' && msg.model && !synthetic) run.model = msg.model;
  // The tokens this record newly reports go on its first event (see RunEvent.usage).
  let usage = usageDelta(msg, x);
  const take = () => {
    const u = usage;
    usage = undefined;
    return u;
  };
  const blocks = blocksOf(msg.content);

  if (rec.isApiErrorMessage === true) {
    const text = blocks.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n').trim() || textOf(rec.error) || 'API error';
    pushEvent(run, { kind: 'error', text, ts, isError: true, usage: take() });
    setTurn(run, 'error', apiErrorDetail(rec, text));
    x.pending = [];
    return true;
  }

  for (const b of blocks) {
    if (!isObj(b)) continue;
    switch (b.type) {
      case 'thinking':
      case 'redacted_thinking': {
        // Most thinking blocks are stored empty (only a signature): a stand-in text, marked as such.
        const readable = b.type === 'thinking' && typeof b.thinking === 'string' && !!b.thinking.trim();
        pushEvent(run, { kind: 'reasoning', text: thinkingText(b, rec), ts, placeholder: readable ? undefined : true, usage: take() });
        setTurn(run, 'in_progress');
        break;
      }
      case 'text': {
        const text = typeof b.text === 'string' ? b.text : '';
        if (synthetic) {
          // e.g. "No response requested." after an interrupt: not a model turn.
          pushEvent(run, { kind: 'system', text, ts, usage: take() });
          break;
        }
        pushEvent(run, { kind: 'assistant', text, ts, usage: take() });
        // 'tool_use' means a call follows in this message. null (common in sub-agents) or
        // end_turn: the turn is over unless more blocks arrive, which flips it back.
        if (msg.stop_reason === 'tool_use') setTurn(run, 'in_progress');
        else {
          setTurn(run, 'completed');
          if (msg.stop_reason === 'end_turn') x.pending = [];
        }
        break;
      }
      case 'tool_use':
      case 'server_tool_use':
        onToolUse(b, run, x, ts, take());
        break;
      case 'web_search_tool_result':
        onToolResult(b, rec, run, x, ts, take());
        break;
      default:
        // image, document and future block types: nothing to show
        break;
    }
  }
  if (usage) addUsage(run, usage, ts); // no event carried it
  if (rec.isAbortedMidStream === true) setTurn(run, 'aborted', 'The response was cut off');
  return true;
}

function onToolUse(b: Record<string, unknown>, run: ParsedRun, x: TranscriptExtra, ts: number | undefined, usage?: TokenUsage): void {
  const name = typeof b.name === 'string' ? b.name : 'tool';
  const id = typeof b.id === 'string' ? b.id : undefined;
  const kind = claudeToolKind(name);
  const filePath = kind === 'edit' || EDIT_TOOLS.has(name) ? toolFilePath(b.input) : undefined;
  pushEvent(run, {
    kind: 'tool_call',
    text: toolInputSummary(b.input),
    ts,
    toolName: name,
    toolCallId: id,
    toolKind: filePath ? 'edit' : kind,
    filePath,
    fileOp: filePath ? 'edit' : undefined, // a Write that creates a file is corrected when its result arrives
    usage,
  });
  if (id) x.pending.push({ id, name, kind, since: ts, filePath, edit: filePath ? inputEdit(name, b.input) : undefined });
  if (ASKS_USER.has(name)) setTurn(run, 'waiting_input', name === 'ExitPlanMode' ? 'Waiting for you to approve the plan' : 'Waiting for your answer');
  else setTurn(run, 'in_progress');
}

function thinkingText(b: Record<string, unknown>, rec: Record<string, unknown>): string {
  if (typeof b.thinking === 'string' && b.thinking.trim()) return b.thinking;
  // About 95% of thinking blocks are stored empty (display "omitted"); only the duration is left.
  const ms = typeof rec.thinkingDurationMs === 'number' ? rec.thinkingDurationMs : undefined;
  return ms ? `Thinking (${(ms / 1000).toFixed(1)} s, text not stored)` : 'Thinking (text not stored)';
}

function apiErrorDetail(rec: Record<string, unknown>, text: string): string {
  const status = typeof rec.apiErrorStatus === 'number' ? ` ${rec.apiErrorStatus}` : '';
  const line = text.split(/\r?\n/)[0].replace(/^API Error:\s*/i, '').trim();
  const detail = `API error${status}: ${line || textOf(rec.error) || 'request failed'}`;
  return detail.length > 160 ? `${detail.slice(0, 157)}…` : detail;
}

/**
 * The tokens this record adds, counted once per message id: the same usage repeats on every
 * block record of a message, sometimes updated, so only the growth counts. input_tokens is the
 * uncached part; the cache figures are separate (Anthropic API usage).
 */
function usageDelta(msg: Record<string, unknown>, x: TranscriptExtra): TokenUsage | undefined {
  const u = msg.usage;
  if (!isObj(u)) return undefined;
  const now: TokenUsage = {
    input: tokenCount(u.input_tokens),
    output: tokenCount(u.output_tokens),
    cacheRead: tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_creation_input_tokens),
  };
  const id = typeof msg.id === 'string' ? msg.id : undefined;
  const before = id && id === x.msgId ? x.msgUsage : undefined;
  x.msgId = id;
  x.msgUsage = now;
  if (!before) return now;
  const delta: TokenUsage = {};
  let grew = false;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (now[k] === undefined) continue;
    delta[k] = Math.max(0, now[k]! - (before[k] ?? 0));
    if (delta[k]) grew = true;
  }
  return grew ? delta : undefined;
}

/** The change an edit tool's input describes: Edit and MultiEdit snippets, a Write's content. */
function inputEdit(name: string, input: unknown): DiffText | undefined {
  if (!isObj(input)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const pair = (e: Record<string, unknown>) => {
    const before = str(e.old_string) ?? str(e.old_str);
    const after = str(e.new_string) ?? str(e.new_str);
    return before !== undefined && after !== undefined ? diffTexts(before, after) : undefined;
  };
  if (name === 'Write' && typeof input.content === 'string') return capDiff(newFileDiff(input.content));
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const parts = input.edits.map((e) => (isObj(e) ? pair(e) : undefined)).filter((d): d is DiffText => !!d && !!d.diff);
    if (!parts.length) return undefined;
    return capDiff({ diff: parts.map((d) => d.diff).join('\n'), added: parts.reduce((n, d) => n + d.added, 0), removed: parts.reduce((n, d) => n + d.removed, 0) });
  }
  return capDiff(pair(input));
}

/** Records one successful edit: the result's own patch when it has one, else the call's input. */
function noteEdit(run: ParsedRun, p: PendingTool, result: unknown, ts: number | undefined): void {
  const r = isObj(result) ? result : {};
  const created = r.type === 'create';
  // A result with structuredPatch is exact (an empty patch is a no-op edit, or a new file whose
  // lines are all in `content`); older results without one fall back to the call's input.
  const d = !Array.isArray(r.structuredPatch)
    ? p.edit
    : created
      ? newFileDiff(typeof r.content === 'string' ? r.content : '')
      : (diffFromHunks(r.structuredPatch) ?? { diff: '', added: 0, removed: 0 });
  pushChange(run, {
    ts,
    filePath: p.filePath!,
    op: created ? 'create' : 'edit',
    diff: d?.diff,
    linesAdded: d?.added,
    linesRemoved: d?.removed,
    toolCallId: p.id,
  });
}

// ---------------------------------------------------------------------------------------------
// user

function onUser(rec: Record<string, unknown>, run: ParsedRun, x: TranscriptExtra): boolean {
  const msg = rec.message;
  if (!isObj(msg)) return false;
  const ts = toMs(rec.timestamp);
  const origin = isObj(rec.origin) && typeof rec.origin.kind === 'string' ? rec.origin.kind : undefined;
  const meta = rec.isMeta === true || rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true || (!!origin && origin !== 'human');
  const texts: string[] = [];
  for (const b of blocksOf(msg.content)) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result') onToolResult(b, rec, run, x, ts);
    else if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text.trim()) texts.push(b.text.trim());
    } else if (b.type === 'image') texts.push('[image]');
    else if (b.type === 'document') texts.push('[document]');
  }
  if (texts.length) onUserText(texts, meta, origin, run, x, ts);
  return true;
}

function onUserText(texts: string[], meta: boolean, origin: string | undefined, run: ParsedRun, x: TranscriptExtra, ts: number | undefined): void {
  const interrupt = texts.find((t) => INTERRUPT.test(t));
  if (interrupt) {
    pushEvent(run, { kind: 'system', text: texts.join('\n'), ts });
    const detail = /for tool use/.test(interrupt) ? 'You stopped a tool call' : /session ended/.test(interrupt) ? 'The session ended before the agent finished' : 'Interrupted by you';
    setTurn(run, 'aborted', detail);
    x.pending = [];
    return;
  }
  // Split injected context (reminders, IDE selections, command wrappers) from what was typed.
  const context = meta ? texts : texts.filter((t) => WRAPPER.test(t));
  const said = meta ? [] : texts.filter((t) => !WRAPPER.test(t));
  if (context.length) pushEvent(run, { kind: 'system', text: context.join('\n'), ts });
  if (!said.length) {
    // A task notification, peer message or prompt-style slash command starts a model turn;
    // reminders, local commands and their output do not.
    if (origin === 'task-notification' || origin === 'peer' || origin === 'coordinator' || (origin === 'human' && texts.some((t) => PROMPT_COMMAND.test(t)))) {
      setTurn(run, 'in_progress');
    }
    return;
  }
  const t = said.join('\n');
  pushEvent(run, { kind: 'user', text: t, ts });
  if (!x.firstPrompt) x.firstPrompt = t.length > MAX_PROMPT_KEPT ? t.slice(0, MAX_PROMPT_KEPT) : t;
  setTurn(run, 'in_progress');
  x.pending = []; // a new prompt starts a new turn: earlier unanswered calls are orphans
}

function onToolResult(b: Record<string, unknown>, rec: Record<string, unknown>, run: ParsedRun, x: TranscriptExtra, ts: number | undefined, usage?: TokenUsage): void {
  const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
  const i = id ? x.pending.findIndex((p) => p.id === id) : -1;
  const p = i >= 0 ? x.pending.splice(i, 1)[0] : undefined;
  // A rejection is written as an error result plus `toolDenialKind`; a missing is_error is false.
  const isError = b.is_error === true || typeof rec.toolDenialKind === 'string';
  const result = rec.toolUseResult;
  pushEvent(run, {
    kind: 'tool_result',
    text: resultText(b.content),
    ts,
    toolName: p?.name,
    toolCallId: id,
    toolKind: p?.kind,
    isError,
    durationMs: p?.since && ts ? Math.max(0, ts - p.since) : undefined,
    usage,
  });
  if (p?.filePath) {
    if (isError) uncountFile(run, p.filePath);
    else {
      if (isObj(result) && result.type === 'create') markCreated(run, p.filePath, p.id);
      noteEdit(run, p, result, ts);
    }
  }
  // Edits made through the shell (Bash `bashEditDiff`), one file_change per file.
  if (isObj(result) && isObj(result.bashEditDiff) && Array.isArray(result.bashEditDiff.files)) {
    for (const f of result.bashEditDiff.files) {
      if (isObj(f) && typeof f.filePath === 'string') {
        pushEvent(run, { kind: 'file_change', text: `Changed by a shell command: ${baseName(f.filePath)}`, ts, filePath: f.filePath, fileOp: 'edit', toolCallId: id, toolName: p?.name });
        const d = diffFromHunks(f.hunks);
        const op = f.created === true ? 'create' : f.deleted === true ? 'delete' : 'edit';
        pushChange(run, { ts, filePath: f.filePath, op, diff: d?.diff, linesAdded: d?.added, linesRemoved: d?.removed, toolCallId: id });
      }
    }
  }
  // Workflow agents hand in StructuredOutput and the result ends their turn.
  if (rec.toolEndsTurn === true) setTurn(run, 'completed');
  else if (run.turn !== 'aborted' && run.turn !== 'error') setTurn(run, x.pending.some((q) => ASKS_USER.has(q.name)) ? 'waiting_input' : 'in_progress');
}

/** Tool result content: a string, or blocks (text, image, tool_reference, document ...). */
function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return textOf(c);
  return c
    .map((b) => {
      if (!isObj(b)) return textOf(b);
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'tool_reference') return `[tool ${typeof b.tool_name === 'string' ? b.tool_name : ''}]`.replace(' ]', ']');
      return `[${typeof b.type === 'string' ? b.type : 'content'}]`; // never dump base64 images
    })
    .filter(Boolean)
    .join('\n');
}

/** A failed or rejected edit did not change its file. */
function uncountFile(run: ParsedRun, path: string): void {
  const f = run.files[path];
  if (!f) return;
  f.count--;
  if (f.count <= 0) delete run.files[path];
}

/** A Write whose result says `type: "create"` made a new file. */
function markCreated(run: ParsedRun, path: string, callId: string): void {
  const f = run.files[path];
  if (f) {
    if (f.count === 1 && f.ops.length === 1 && f.ops[0] === 'edit') f.ops = ['create'];
    else if (!f.ops.includes('create')) f.ops.push('create');
  }
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i];
    if (e.kind === 'tool_call' && e.toolCallId === callId) {
      run.events[i] = { ...e, fileOp: 'create' }; // replaced, not edited: prev states share events
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// system / attachment

function onSystem(rec: Record<string, unknown>, run: ParsedRun): void {
  const ts = toMs(rec.timestamp);
  const sub = typeof rec.subtype === 'string' ? rec.subtype : '';
  if (sub === 'api_error') {
    // A retry notice: the request is being retried, the turn goes on (unless retries ran out).
    const err = isObj(rec.error) ? rec.error : {};
    const msg = (typeof err.message === 'string' && err.message) || (typeof err.formatted === 'string' && err.formatted) || 'request failed';
    const attempt = Number(rec.retryAttempt);
    const max = Number(rec.maxRetries);
    const retry = Number.isFinite(attempt) && Number.isFinite(max) && max > 0 ? ` (retry ${attempt}/${max})` : '';
    pushEvent(run, { kind: 'error', text: `API error${retry}: ${msg}`, ts, isError: true });
    if (retry && attempt >= max) setTurn(run, 'error', `API error: ${msg}`);
    else setTurn(run, 'in_progress');
    return;
  }
  if (sub === 'compact_boundary') {
    pushEvent(run, { kind: 'system', text: 'Context compacted', ts });
    return;
  }
  if (sub === 'stop_hook_summary') {
    const errs = Array.isArray(rec.hookErrors) ? rec.hookErrors.length : 0;
    pushEvent(run, { kind: 'system', text: errs ? `Stop hooks reported ${errs} error(s)` : 'Stop hooks ran', ts, isError: errs > 0 || undefined });
    // Stop hooks run when the turn ends.
    if (run.turn === 'in_progress' || run.turn === 'unknown') setTurn(run, 'completed');
    return;
  }
  const text = typeof rec.content === 'string' && rec.content.trim() ? rec.content : sub || 'System notice';
  if (rec.level === 'error') pushEvent(run, { kind: 'error', text, ts, isError: true });
  else pushEvent(run, { kind: 'system', text, ts });
}

function onAttachment(rec: Record<string, unknown>, run: ParsedRun): void {
  const a = rec.attachment;
  if (!isObj(a)) return;
  const ts = toMs(rec.timestamp);
  if (a.type === 'queued_command' && a.commandMode === 'task-notification') {
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(prompt)?.[1]?.trim();
    pushEvent(run, { kind: 'system', text: summary ? `Background task finished: ${summary}` : 'Background task finished', ts });
  } else if (a.type === 'edited_text_file' && typeof a.filename === 'string') {
    // Changed by the user or a linter, not by the agent: shown, not counted as an agent edit.
    pushEvent(run, { kind: 'system', text: `${baseName(a.filename)} was changed outside the agent (by you or a linter)`, ts, filePath: a.filename });
  }
  // Hook output, dates, skills, structured_output, task status ...: context, not activity.
}

// ---------------------------------------------------------------------------------------------
// turn state, title, open tool

function setTurn(run: ParsedRun, turn: ParsedRun['turn'], detail?: string): void {
  run.turn = turn;
  run.turnDetail = detail;
}

function finalize(run: ParsedRun, x: TranscriptExtra, offset: number): void {
  const pick = x.customTitle ?? x.metaTitle ?? x.firstPrompt ?? x.aiTitle ?? x.summaryTitle ?? x.lastPrompt ?? '';
  run.title = makeTitle(pick.replace(HARNESS_LINE, ''));
  const last = x.pending.at(-1);
  run.openTool = last ? { name: last.name, kind: last.kind, since: last.since ?? run.lastEventAt ?? 0 } : undefined;
  if (offset > 0 && x.recognised === 0) run.readError = 'No records this app recognises; the agent may have changed its format.';
  else delete run.readError;
  x.baseTurn = run.turn;
  x.baseDetail = run.turnDetail;
}

/** A live registry entry saying "waiting" turns an open tool call into a wait for the user. */
async function applyRegistry(ref: SessionRef, run: ParsedRun, x: TranscriptExtra): Promise<void> {
  if (!x.pending.length || run.turn !== 'in_progress') return;
  const root = rootOfSession(ref.path);
  if (!root) return;
  const entry = await liveEntry(root, basename(ref.path, '.jsonl'));
  if (entry?.status === 'waiting') {
    run.turn = 'waiting_input';
    run.turnDetail = waitDetail(entry.waitingFor);
  }
}

/**
 * A workflow agent whose transcript stops mid-turn may have been cut off and replaced, or the
 * workflow may have recorded its end anyway; the journal next to it says which (per parse, like
 * the registry: the transcript's own turn stays in `baseTurn`).
 */
async function applyJournal(ref: SessionRef, run: ParsedRun, mtimeMs: number): Promise<void> {
  if (run.turn !== 'in_progress' && run.turn !== 'unknown') return;
  // Only call it replaced once it has been quiet as long as status.ts would call it stuck.
  const quiet = run.openTool ? (run.openTool.kind === 'run' ? SHELL_STUCK_AFTER : TOOL_STUCK_AFTER) : STUCK_AFTER;
  const verdict = await workflowAgentVerdict(ref.path, Math.max(run.lastEventAt ?? 0, mtimeMs || ref.mtimeMs), quiet);
  if (!verdict) return;
  run.turn = verdict.turn;
  run.turnDetail = verdict.detail;
  run.openTool = undefined;
}
