// Turns Codex rollout records into run events.
//
// Provenance: Codex is not installed on the machine this was written on. The format was checked
// against the openai/codex source (main @ 6fe77fc, just after rust-v0.164.0, plus older tags for the
// format history): history/src/{lib.rs,rollout_payload.rs}, protocol/src/{models.rs,protocol.rs,
// items.rs}, rollout/src/{recorder.rs,policy.rs}. The fixtures are synthesized from that source.
// Items marked [UNVERIFIED] come from docs or community notes only.
//
// Format eras handled (see docs/research codex.md section 10):
// - bare JSONL (<= rust-v0.31, 2025-08): first line {id,timestamp,instructions}, then bare ResponseItems
//   and {"record_type":"state"} lines; no timestamps, events, model or cwd field.
// - envelope {timestamp,type,payload} (rust-v0.32+): session_meta, turn_context, response_item,
//   event_msg, compacted; task_started/task_complete only from rust-v0.100.
// - "extended history" (2026-03..06): adds error, exec_command_end, mcp_tool_call_end events.
// - paginated history_mode (2026-07+): an `ordinal` per line, item_completed TurnItems instead of
//   user_message/agent_message events.
//
// Messages are written twice (response_item and event_msg / item_completed). We keep whichever copy
// arrives first and drop its twin by matching text, so every era counts each message once.

import type { ToolKind } from '@shared/schema';
import { ev, type ParsedRun, type TurnState } from '../../adapter';
import { baseName, isObj, pushEvent, textOf, toolFilePath, toolInputSummary, toMs } from '../../events';
import {
  bareName,
  changeFiles,
  codexKind,
  decodeOutput,
  looksLikePatchFailure,
  looksLikeToolError,
  parseArgs,
  patchFiles,
  resolveIn,
  toolName,
  type PatchFile,
} from './tools';

/** Bump when CodexState changes shape, so old incremental state is discarded. */
export const STATE_VERSION = 2;

interface Pending {
  name: string;
  kind: ToolKind;
  ts?: number;
  order: number;
  patch?: PatchFile[];
  failed?: boolean;
  asksUser?: boolean;
}

/** Everything carried between incremental parses (plain data only, lives in ParseState.extra). */
export interface CodexState {
  v: number;
  head?: string;
  mode?: string;
  metaSeen: number;
  forkBoundary?: number;
  /** task_started/task_complete seen: turn ends are explicit (rust-v0.100+). */
  lifecycle: boolean;
  turn: TurnState;
  detail?: string;
  /** The current error came from an `error` event, which a retry can still recover from. */
  softError: boolean;
  cwd?: string;
  pending: Record<string, Pending>;
  order: number;
  /** Recent message texts per source, to drop the twin copy of each message. */
  recent: { k: string; src: string; t: string }[];
  /** Calls whose file changes were already emitted. */
  donePatches: string[];
  recognised: number;
  bad: number;
  lastTs?: number;
  parentThreadId?: string;
  /** null = looked and not found. */
  parentPath?: string | null;
}

export function newState(): CodexState {
  return {
    v: STATE_VERSION,
    metaSeen: 0,
    lifecycle: false,
    turn: 'unknown',
    softError: false,
    pending: {},
    order: 0,
    recent: [],
    donePatches: [],
    recognised: 0,
    bad: 0,
  };
}

/** Injected context that Codex sends as role:"user" text; never a real prompt. [SRC protocol.rs] */
const CONTEXT_MARKERS = [
  '<environment_context>',
  '<user_instructions>',
  '# AGENTS.md instructions',
  '<permissions instructions>',
  '<environments_instructions>',
  '<apps_instructions>',
  '<skills_instructions>',
  '<plugins_instructions>',
  '<collaboration_mode>',
  '<multi_agent_mode>',
  '<context_window>',
  '<turn_aborted>',
  '<user_shell_command>',
];
const REQUEST_PREFIX = '## My request for Codex:';

/** Record types we know and deliberately show nothing for. */
const QUIET_TOP = new Set([
  'world_state',
  'retained_context',
  'security_risk_score',
  'realtime_item',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
]);
const QUIET_ITEMS = new Set([
  'additional_tools',
  'configuration_update',
  'compaction',
  'compaction_summary',
  'context_compaction',
  'ghost_snapshot',
]);
const QUIET_EVENTS = new Set([
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'agent_reasoning_section_break',
  'context_compacted',
  'thread_goal_updated',
  'entered_review_mode',
  'exited_review_mode',
  'sub_agent_activity',
  'web_search_begin',
  'web_search_end',
  'image_generation_begin',
  'image_generation_end',
  'mcp_tool_call_begin',
  'item_started',
  'turn_diff',
  'plan_update',
  'session_configured',
  'shutdown_complete',
  'background_event',
  'mcp_startup_update',
  'mcp_startup_complete',
  'get_history_entry_response',
  'thread_name_updated',
  'undo_started',
  'undo_completed',
  'guardian_assessment',
]);

const ABORT_WORDS: Record<string, string> = {
  interrupted: 'Interrupted by you',
  replaced: 'Replaced by a new turn',
  review_ended: 'Review ended',
  budget_limited: 'Stopped at the budget limit',
};

// ---------------------------------------------------------------- dispatch

/** Handles one parsed JSONL value. Never throws on odd shapes: unknown records count as skipped. */
export function handleRecord(rec: unknown, run: ParsedRun, s: CodexState): void {
  if (!isObj(rec)) {
    run.skipped++;
    return;
  }
  let ok: boolean;
  if (typeof rec.type === 'string' && 'payload' in rec) ok = envelope(rec, run, s);
  else if (rec.record_type === 'state') ok = true; // bare era checkpoint marker
  else if (typeof rec.type === 'string') {
    s.mode ??= 'bare';
    ok = responseItem(rec, toMs(rec.timestamp), run, s);
  } else if (typeof rec.id === 'string' && 'timestamp' in rec && s.metaSeen === 0) {
    s.mode = 'bare';
    ok = sessionMeta(rec, run, s);
  } else ok = false;
  if (ok) s.recognised++;
  else run.skipped++;
}

function envelope(rec: Record<string, unknown>, run: ParsedRun, s: CodexState): boolean {
  const ts = toMs(rec.timestamp);
  if (ts && (!s.lastTs || ts > s.lastTs)) s.lastTs = ts;
  const p = isObj(rec.payload) ? rec.payload : {};
  // Paginated forks copy the parent's history first; skip records before the boundary. [SRC-INFER]
  if (rec.type !== 'session_meta' && s.forkBoundary != null && typeof rec.ordinal === 'number' && rec.ordinal < s.forkBoundary)
    return true;
  switch (rec.type) {
    case 'session_meta':
      return sessionMeta(p, run, s);
    case 'turn_context':
      turnContext(p, run, s);
      return true;
    case 'response_item':
      return responseItem(p, ts, run, s);
    case 'event_msg':
      return eventMsg(p, ts, run, s);
    case 'compacted':
      pushEvent(run, ev('system', 'Context compacted', { ts }));
      return true;
    case 'token_usage_record':
      setTokens(run, p.thread_token_usage);
      return true;
    default:
      return QUIET_TOP.has(String(rec.type));
  }
}

// ---------------------------------------------------------------- session / turn context

function sessionMeta(p: Record<string, unknown>, run: ParsedRun, s: CodexState): boolean {
  s.metaSeen++;
  // Forks copy the parent's records, including its session_meta: only the first one is ours. [SRC]
  if (s.metaSeen > 1) return true;
  if (s.mode !== 'bare') s.mode = typeof p.history_mode === 'string' ? p.history_mode : 'legacy';
  if (typeof p.cwd === 'string' && p.cwd) setProject(run, s, p.cwd);
  const git = isObj(p.git) ? p.git : undefined;
  if (git && typeof git.branch === 'string' && git.branch) run.gitBranch = git.branch;
  const started = toMs(p.timestamp);
  if (started && (!run.startedAt || started < run.startedAt)) run.startedAt = started;
  const src = isObj(p.source) ? p.source : undefined;
  const spawn = src && isObj(src.subagent) && isObj(src.subagent.thread_spawn) ? src.subagent.thread_spawn : undefined;
  const parent = p.parent_thread_id ?? spawn?.parent_thread_id;
  if (typeof parent === 'string' && parent) s.parentThreadId = parent;
  if (s.mode === 'paginated') {
    const base = isObj(p.history_base) ? p.history_base.end_ordinal_exclusive : undefined;
    const b = p.forked_from_ordinal_exclusive ?? base ?? p.subagent_history_start_ordinal;
    if (typeof b === 'number') s.forkBoundary = b;
  }
  return true;
}

function turnContext(p: Record<string, unknown>, run: ParsedRun, s: CodexState): void {
  if (typeof p.model === 'string' && p.model) run.model = p.model;
  if (typeof p.cwd === 'string' && p.cwd) {
    s.cwd = p.cwd;
    if (!run.projectPath) setProject(run, s, p.cwd);
  }
}

function setProject(run: ParsedRun, s: CodexState, cwd: string): void {
  run.projectPath = cwd;
  run.projectName = baseName(cwd) || cwd;
  s.cwd ??= cwd;
}

function setTokens(run: ParsedRun, usage: unknown): void {
  if (!isObj(usage)) return;
  if (typeof usage.input_tokens === 'number') run.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') run.outputTokens = usage.output_tokens;
}

// ---------------------------------------------------------------- turn state

function begin(s: CodexState): void {
  s.turn = 'in_progress';
  s.detail = undefined;
  s.softError = false;
}

/** The agent did something: a recoverable error, a wait or an older-era "finished" guess is over. */
function activity(s: CodexState): void {
  if (s.turn === 'waiting_input' || s.turn === 'unknown' || s.softError || (!s.lifecycle && s.turn === 'completed')) begin(s);
}

function endTurn(s: CodexState, turn: TurnState, detail?: string): void {
  s.turn = turn;
  s.detail = detail;
  s.softError = false;
  s.pending = {}; // calls still open when a turn ends were never answered
}

// ---------------------------------------------------------------- messages

/** The twin-matching key: image placeholders and <image> wrappers differ between the two copies. */
function normalise(t: string): string {
  return t
    .replace(/<\/?image\b[^>]*>|\[(?:image|audio)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/** Adds a user/assistant message unless its twin from the other source was already added. */
function addMessage(run: ParsedRun, s: CodexState, k: 'user' | 'assistant', text: string, src: string, ts?: number, phase?: unknown): void {
  const t = normalise(text);
  const twin = s.recent.findIndex((r) => r.k === k && r.src !== src && r.t === t);
  if (twin >= 0) s.recent.splice(twin, 1);
  else {
    s.recent.push({ k, src, t });
    if (s.recent.length > 16) s.recent.shift();
    pushEvent(run, ev(k, text, { ts }));
  }
  if (k === 'user') {
    begin(s);
    return;
  }
  activity(s);
  // Before rust-v0.100 there is no task_complete: a non-commentary answer with nothing open ends the turn.
  if (!s.lifecycle && phase !== 'commentary' && Object.keys(s.pending).length === 0) s.turn = 'completed';
}

function stripRequest(text: string): string {
  const i = text.indexOf(REQUEST_PREFIX);
  return i >= 0 ? text.slice(i + REQUEST_PREFIX.length).trim() : text;
}

/** The real prompt in a role:"user" message, or null when it is only injected context. */
function userText(content: unknown, run: ParsedRun, s: CodexState): string | null {
  const parts = Array.isArray(content) ? content : [content];
  const kept: string[] = [];
  const media: string[] = [];
  for (const c of parts) {
    const text = typeof c === 'string' ? c : isObj(c) && typeof c.text === 'string' ? c.text : undefined;
    if (text === undefined) {
      if (isObj(c) && /image/.test(String(c.type))) media.push('[image]');
      else if (isObj(c) && /audio/.test(String(c.type))) media.push('[audio]');
      continue;
    }
    const trimmed = text.trimStart();
    if (CONTEXT_MARKERS.some((m) => trimmed.startsWith(m))) {
      // The bare era has no cwd field; the environment context carries it.
      const cwd = /<cwd>([^<]+)<\/cwd>/.exec(text)?.[1]?.trim();
      if (cwd && !run.projectPath) setProject(run, s, cwd);
      continue;
    }
    // Attached images are wrapped in `<image name=[Image #1]>` ... `</image>` text parts: not the prompt.
    if (/^\s*<\/?image\b[^>]*>\s*$/i.test(text)) continue;
    if (text.trim()) kept.push(text);
  }
  // Prompt text first so the title is the prompt, not "[image]".
  const all = [...(kept.length ? [stripRequest(kept.join('\n'))] : []), ...media];
  return all.length ? all.join('\n') : null;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content);
  return content
    .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- tools

function openCall(s: CodexState, id: string | undefined, p: Omit<Pending, 'order'>): void {
  if (!id) return;
  s.pending[id] = { ...p, order: ++s.order };
}

function pushToolCall(run: ParsedRun, s: CodexState, o: { id?: string; name: string; input: unknown; ts?: number; open: boolean; patch?: PatchFile[] }): void {
  const kind = codexKind(o.name);
  const fp = o.patch ? undefined : toolFilePath(o.input);
  activity(s);
  if (o.open)
    openCall(s, o.id, { name: o.name, kind, ts: o.ts, patch: o.patch, asksUser: bareName(o.name) === 'request_user_input' });
  // apply_patch files are counted through file_change events, so the call itself carries no filePath.
  pushEvent(run, ev('tool_call', toolInputSummary(o.input), { ts: o.ts, toolName: o.name, toolCallId: o.id, toolKind: kind, filePath: fp }));
}

function closeCall(run: ParsedRun, s: CodexState, id: string | undefined, raw: unknown, ts?: number): void {
  const pend = id ? s.pending[id] : undefined;
  const { text, exitCode } = decodeOutput(raw);
  let isError = !!pend?.failed || (exitCode != null ? exitCode !== 0 : looksLikeToolError(text));
  if (pend?.patch && looksLikePatchFailure(text)) isError = true;
  activity(s);
  pushEvent(
    run,
    ev('tool_result', text, {
      ts,
      toolCallId: id,
      toolName: pend?.name,
      toolKind: pend?.kind,
      isError,
      durationMs: pend?.ts && ts ? Math.max(0, ts - pend.ts) : undefined,
    }),
  );
  // Older files have no patch_apply_end: fall back to the patch headers once the patch succeeded.
  if (pend?.patch && !isError && id) emitFiles(run, s, id, pend.patch.map((f) => ({ ...f, path: resolveIn(s.cwd, f.path) })), ts);
  if (id) delete s.pending[id];
}

/** Remembers that a call's file changes were handled (bounded list). */
function markPatchDone(s: CodexState, id: string): void {
  s.donePatches.push(id);
  if (s.donePatches.length > 64) s.donePatches.shift();
}

function emitFiles(run: ParsedRun, s: CodexState, id: string | undefined, files: PatchFile[], ts?: number): void {
  if (id) {
    if (s.donePatches.includes(id)) return;
    markPatchDone(s, id);
  }
  for (const f of files)
    pushEvent(run, ev('file_change', `${f.op === 'create' ? 'Created' : f.op === 'delete' ? 'Deleted' : 'Edited'} ${f.path}`, { ts, toolCallId: id, filePath: f.path, fileOp: f.op, toolKind: 'edit' }));
}

/** A side event (exec_command_end, patch_apply_end, ...) says the call failed. */
function markFailed(run: ParsedRun, s: CodexState, id: unknown): void {
  if (typeof id !== 'string' || !id) return;
  const pend = s.pending[id];
  if (pend) {
    pend.failed = true;
    return;
  }
  // The result was already pushed: flag it (copy-on-write, earlier states may share the object).
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i];
    if (e.kind !== 'tool_result' || e.toolCallId !== id) continue;
    if (!e.isError) {
      run.events[i] = { ...e, isError: true };
      run.tally.errors++;
    }
    return;
  }
}

/** Applies a patch_apply_end / FileChange `changes` map unless the patch failed. */
function applyChanges(run: ParsedRun, s: CodexState, id: unknown, changes: unknown, failed: boolean, ts?: number): void {
  const cid = typeof id === 'string' && id ? id : undefined;
  if (failed) {
    markFailed(run, s, cid);
    if (cid) markPatchDone(s, cid);
    return;
  }
  emitFiles(run, s, cid, changeFiles(changes), ts);
}

// ---------------------------------------------------------------- response_item

function responseItem(p: Record<string, unknown>, ts: number | undefined, run: ParsedRun, s: CodexState): boolean {
  const callId = typeof p.call_id === 'string' && p.call_id ? p.call_id : undefined;
  switch (p.type) {
    case 'message': {
      if (p.role === 'user') {
        const text = userText(p.content, run, s);
        if (text != null) addMessage(run, s, 'user', text, 'item', ts);
      } else if (p.role === 'assistant') {
        const text = assistantText(p.content);
        if (text.trim()) addMessage(run, s, 'assistant', text, 'item', ts, p.phase);
      }
      return true; // developer / system messages are instructions: known, not shown
    }
    case 'reasoning': {
      // Only the summary is readable; encrypted_content is opaque. Empty summaries add nothing.
      const summary = Array.isArray(p.summary) ? assistantText(p.summary) : '';
      const text = summary || (Array.isArray(p.content) ? assistantText(p.content) : '');
      activity(s);
      if (text.trim()) pushEvent(run, ev('reasoning', text, { ts }));
      return true;
    }
    case 'function_call': {
      const name = toolName(p.name, p.namespace);
      const args = parseArgs(p.arguments);
      const patch = bareName(name) === 'apply_patch' ? patchFiles(isObj(args) ? args.input : args) : undefined;
      pushToolCall(run, s, { id: callId ?? str(p.id), name, input: args, ts, open: true, patch });
      return true;
    }
    case 'custom_tool_call': {
      const name = toolName(p.name, p.namespace);
      const patch = bareName(name) === 'apply_patch' ? patchFiles(p.input) : undefined;
      pushToolCall(run, s, { id: callId, name, input: p.input, ts, open: true, patch });
      return true;
    }
    case 'local_shell_call': {
      // codex-mini era; answered by a function_call_output with the same call_id. [SRC]
      const action = isObj(p.action) ? p.action : {};
      const cmd = Array.isArray(action.command) ? action.command.join(' ') : textOf(action.command);
      pushToolCall(run, s, { id: callId ?? str(p.id), name: 'local_shell', input: { command: cmd }, ts, open: true });
      return true;
    }
    case 'tool_search_call':
      pushToolCall(run, s, { id: callId, name: 'tool_search', input: p.arguments, ts, open: true });
      return true;
    case 'web_search_call': {
      // No output item is ever written for web searches. [SRC]
      const a = isObj(p.action) ? p.action : {};
      const q = a.query ?? (Array.isArray(a.queries) ? a.queries.join(' | ') : undefined) ?? a.url ?? a.pattern ?? '';
      pushToolCall(run, s, { id: str(p.id), name: 'web_search', input: String(q), ts, open: false });
      return true;
    }
    case 'image_generation_call':
      pushToolCall(run, s, { id: str(p.id), name: 'image_generation', input: str(p.revised_prompt) ?? '', ts, open: false });
      return true;
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'tool_search_output':
      closeCall(run, s, callId, p.type === 'tool_search_output' ? p.tools : p.output, ts);
      return true;
    case 'agent_message': {
      // Multi-agent message between agents (2026-06+).
      const from = str(p.author) ?? 'agent';
      pushEvent(run, ev('system', `${from}: ${assistantText(p.content)}`, { ts }));
      return true;
    }
    default:
      return QUIET_ITEMS.has(String(p.type));
  }
}

// ---------------------------------------------------------------- event_msg

function eventMsg(p: Record<string, unknown>, ts: number | undefined, run: ParsedRun, s: CodexState): boolean {
  const type = String(p.type);
  switch (type) {
    case 'task_started':
    case 'turn_started':
      s.lifecycle = true;
      begin(s);
      return true;
    case 'task_complete':
    case 'turn_complete': {
      s.lifecycle = true;
      const err = errorText(p.error);
      // Older Codex ends a failed turn with an `error` event and then a plain task_complete (no
      // `error` field). An error with nothing after it but the turn end means the turn failed.
      const pendingError = s.softError ? s.detail : undefined;
      if (err) {
        if (err !== pendingError) pushEvent(run, ev('error', err, { ts, isError: true }));
        endTurn(s, 'error', err);
      } else if (pendingError) endTurn(s, 'error', pendingError);
      else endTurn(s, 'completed');
      return true;
    }
    case 'turn_aborted': {
      const reason = str(p.reason) ?? 'interrupted';
      const words = ABORT_WORDS[reason] ?? `Stopped (${reason})`;
      pushEvent(run, ev('system', `Turn stopped: ${words.toLowerCase()}`, { ts }));
      const err = errorText(p.error);
      if (err) {
        pushEvent(run, ev('error', err, { ts, isError: true }));
        endTurn(s, 'error', err);
      } else endTurn(s, 'aborted', words);
      return true;
    }
    case 'user_message': {
      const imgs = (Array.isArray(p.images) && p.images.length) || (Array.isArray(p.local_images) && p.local_images.length);
      const text = stripRequest(str(p.message) ?? '') || (imgs ? '[image]' : '');
      if (text) addMessage(run, s, 'user', text, 'event', ts);
      else begin(s);
      return true;
    }
    case 'agent_message': {
      const text = str(p.message) ?? '';
      if (text.trim()) addMessage(run, s, 'assistant', text, 'event', ts, p.phase);
      return true;
    }
    case 'token_count':
      // `info` is null when only rate limits changed; very early files may carry a flat usage. [UNVERIFIED]
      setTokens(run, isObj(p.info) ? p.info.total_token_usage : p);
      return true;
    case 'error': {
      // Persisted only in older / extended-history files. A retry may still recover the turn.
      const msg = str(p.message) ?? 'Codex reported an error';
      pushEvent(run, ev('error', msg, { ts, isError: true }));
      s.turn = 'error';
      s.detail = msg;
      s.softError = true;
      return true;
    }
    case 'stream_error':
    case 'warning':
      pushEvent(run, ev('system', `${type === 'warning' ? 'Warning' : 'Connection problem, retrying'}: ${str(p.message) ?? ''}`, { ts }));
      return true;
    case 'exec_command_begin':
    case 'patch_apply_begin':
      activity(s);
      return true;
    case 'exec_command_end':
      if ((typeof p.exit_code === 'number' && p.exit_code !== 0) || p.status === 'failed' || p.status === 'declined') markFailed(run, s, p.call_id);
      return true;
    case 'patch_apply_end':
      applyChanges(run, s, p.call_id, p.changes, p.success === false || p.status === 'failed' || p.status === 'declined', ts);
      return true;
    case 'mcp_tool_call_end': {
      const r = isObj(p.result) ? p.result : {};
      if ('Err' in r || (isObj(r.Ok) && r.Ok.isError === true)) markFailed(run, s, p.call_id);
      return true;
    }
    case 'exec_approval_request': {
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : str(p.command);
      wait(s, cmd ? `Waiting for approval to run: ${cmd.slice(0, 120)}` : 'Waiting for approval to run a command');
      return true;
    }
    case 'apply_patch_approval_request':
      wait(s, 'Waiting for approval to apply a patch');
      return true;
    case 'request_user_input':
      wait(s, 'Codex asked you a question');
      return true;
    case 'request_permissions':
      wait(s, 'Waiting for permission');
      return true;
    case 'elicitation_request':
      wait(s, 'An MCP server is asking for input');
      return true;
    case 'thread_settings_applied': {
      const ts2 = isObj(p.thread_settings) ? p.thread_settings : {};
      if (typeof ts2.model === 'string' && ts2.model) run.model = ts2.model;
      return true;
    }
    case 'thread_rolled_back':
      pushEvent(run, ev('system', `Rolled back ${typeof p.num_turns === 'number' ? p.num_turns : 'some'} turn(s)`, { ts }));
      return true;
    case 'item_completed':
      return turnItem(isObj(p.item) ? p.item : {}, ts, run, s);
    default:
      return QUIET_EVENTS.has(type) || type.endsWith('_delta');
  }
}

function wait(s: CodexState, detail: string): void {
  s.turn = 'waiting_input';
  s.detail = detail;
  s.softError = false;
}

/** Paginated mode's item_completed TurnItems (PascalCase `type`). [SRC protocol/src/items.rs] */
function turnItem(it: Record<string, unknown>, ts: number | undefined, run: ParsedRun, s: CodexState): boolean {
  const failed = it.status === 'failed' || it.status === 'declined';
  switch (it.type) {
    case 'UserMessage': {
      const parts = Array.isArray(it.content) ? it.content : [];
      const text = parts
        .map((c) => (isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : isObj(c) && /image/.test(String(c.type)) ? '[image]' : ''))
        .filter(Boolean)
        .join('\n');
      if (text.trim()) addMessage(run, s, 'user', stripRequest(text), 'event', ts);
      else begin(s);
      return true;
    }
    case 'AgentMessage': {
      const text = assistantText(it.content);
      if (text.trim()) addMessage(run, s, 'assistant', text, 'event', ts, it.phase);
      return true;
    }
    case 'CommandExecution':
      if (failed || (typeof it.exit_code === 'number' && it.exit_code !== 0)) markFailed(run, s, it.id);
      return true;
    case 'FileChange':
      applyChanges(run, s, it.id, it.changes, failed, ts);
      return true;
    case 'McpToolCall': {
      const r = isObj(it.result) ? it.result : {};
      if (failed || it.error || r.isError === true) markFailed(run, s, it.id);
      return true;
    }
    case 'ContextCompaction':
      return true; // the `compacted` record already says so
    default:
      // Reasoning duplicates the response_item; Plan, WebSearch, FunctionCallOutput, ... add nothing new.
      return typeof it.type === 'string';
  }
}

function errorText(e: unknown): string | undefined {
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  if (isObj(e)) return str(e.message) ?? textOf(e, 500);
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

// ---------------------------------------------------------------- finish

/** Copies the turn state onto the run and picks the open tool. Call after each read. */
export function finish(run: ParsedRun, s: CodexState, fileMtime: number): void {
  run.turn = s.turn;
  run.turnDetail = s.detail;
  let newest: Pending | undefined;
  for (const p of Object.values(s.pending)) if (!newest || p.order > newest.order) newest = p;
  run.openTool = newest ? { name: newest.name, kind: newest.kind, since: newest.ts ?? s.lastTs ?? run.startedAt ?? fileMtime } : undefined;
  // request_user_input waits for the user; approvals are not written to disk in current versions. [SRC]
  if (newest?.asksUser && run.turn === 'in_progress') {
    run.turn = 'waiting_input';
    run.turnDetail = 'Codex asked you a question';
  }
  if (s.recognised === 0 && (s.bad > 0 || run.skipped > 0))
    run.readError = 'No records this app recognises; the agent may have changed its format.';
  else delete run.readError;
}
