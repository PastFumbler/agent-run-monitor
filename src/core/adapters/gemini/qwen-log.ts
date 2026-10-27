// Qwen Code session logs (projects/<sanitized-cwd>/chats/<uuid>.jsonl, since 2025-12, PR #1113).
// Plain append-only JSONL in a Claude-Code-like shape: every record has uuid/parentUuid, type
// (user | assistant | tool_result | system), cwd, version, gitBranch and a Gemini `Content`
// in `message`. Tool calls are functionCall parts on assistant records, paired with tool_result
// records by `toolCallResult.callId`. Rewinds are marker records, so line-by-line is enough.
// Provenance: QwenLM/qwen-code source (chatRecordingService.ts, sessionService.ts), read by the
// research pass; not checked against a real installation.

import type { ParsedRun, TurnState } from '../../adapter';
import { baseName, isObj, makeTitle, pushEvent, toolFilePath, toolInputSummary, toMs } from '../../events';
import { addUsageSince } from '../../usage';
import {
  fileDiffOf,
  geminiUsage,
  noteFileChange,
  isMetaPrompt,
  isQuestionTool,
  kindOf,
  opForTool,
  partsOf,
  partsText,
  responseOf,
  resultText,
  str,
  type Part,
} from './common';

interface Pending {
  name: string;
  since: number;
  filePath?: string;
}

/** Carried between parses in ParseState.extra (plain data only). */
export interface QwenState {
  /** Open tool calls by call id, oldest first. */
  pending: Record<string, Pending>;
  /** A tool in the current turn was cancelled (the user rejected it or pressed Esc). */
  cancelled: boolean;
  /** The turn's state is 'error' because of an api_error telemetry record (a retry may follow). */
  apiError?: boolean;
  promptTitle?: string;
  manualTitle?: string;
  autoTitle?: string;
  sessionModel?: string;
  skipped: number;
  recognised: number;
}

export function newQwenState(): QwenState {
  return { pending: {}, cancelled: false, skipped: 0, recognised: 0 };
}

/** System subtypes that carry only metadata: recognised, no event. */
const QUIET_SUBTYPES = new Set([
  'session_approval_mode',
  'file_history_snapshot',
  'ui_telemetry',
  'agent_bootstrap',
  'at_command',
]);

export function applyQwenRecord(run: ParsedRun, st: QwenState, r: unknown): void {
  if (!isObj(r) || typeof r.type !== 'string') {
    st.skipped++;
    return;
  }
  const ts = toMs(r.timestamp);
  let ok = true;
  switch (r.type) {
    case 'user':
      onUser(run, st, r, ts);
      break;
    case 'assistant':
      onAssistant(run, st, r, ts);
      break;
    case 'tool_result':
      onToolResult(run, st, r, ts);
      break;
    case 'system':
      ok = onSystem(run, st, r, ts);
      break;
    default:
      ok = false;
  }
  if (!ok) {
    st.skipped++;
    return;
  }
  st.recognised++;
  noteContext(run, r);
}

/** Every record repeats cwd and gitBranch; the cwd keeps its original case (the folder name does not). */
function noteContext(run: ParsedRun, r: Record<string, unknown>): void {
  const cwd = str(r.cwd);
  if (cwd && !run.projectPath) {
    run.projectPath = cwd;
    run.projectName = baseName(cwd);
  }
  const branch = str(r.gitBranch);
  if (branch) run.gitBranch = branch;
}

function onUser(run: ParsedRun, st: QwenState, r: Record<string, unknown>, ts: number | undefined): void {
  const parts = partsOf(isObj(r.message) ? r.message.parts : undefined);
  const payload = isObj(r.systemPayload) ? r.systemPayload : {};
  const text = str(payload.displayText) ?? partsText(parts, '\n');
  const exec = isObj(r.executionContext) ? r.executionContext : {};
  if (!run.model && str(exec.modelId)) run.model = exec.modelId as string;
  // Notifications, cron, agent messages etc. are user-typed records with a subtype, and
  // provenance other than real_user marks injected text: neither is a prompt the user typed.
  const injected = !!r.subtype || (typeof r.provenance === 'string' && r.provenance !== 'real_user');
  if (!text.trim()) return;
  if (injected || isMetaPrompt(text)) {
    pushEvent(run, { kind: 'system', text, ts });
    return;
  }
  pushEvent(run, { kind: 'user', text, ts });
  st.promptTitle ??= makeTitle(text);
  st.cancelled = false;
  st.apiError = false;
  // A new prompt means calls that never got a result (the CLI died, then was resumed) are over.
  st.pending = {};
  run.turn = 'in_progress';
  run.turnDetail = undefined;
}

function onAssistant(run: ParsedRun, st: QwenState, r: Record<string, unknown>, ts: number | undefined): void {
  if (str(r.model)) run.model = r.model as string;
  const mark = run.tally.events;
  // The model is called again only once every call of its previous response has a result, so
  // anything still pending lost its tool_result record. A model reply also ends a cancellation.
  st.pending = {};
  st.cancelled = false;
  st.apiError = false;
  let text = '';
  const flushText = () => {
    if (text.trim()) pushEvent(run, { kind: 'assistant', text, ts });
    text = '';
  };
  for (const p of partsOf(isObj(r.message) ? r.message.parts : undefined)) {
    if (p.thought === true && typeof p.text === 'string') {
      if (p.text.trim()) pushEvent(run, { kind: 'reasoning', text: p.text, ts });
    } else if (typeof p.text === 'string') {
      text += p.text;
    } else if (isObj(p.functionCall)) {
      flushText();
      onFunctionCall(run, st, p.functionCall as Part, ts);
    }
  }
  flushText();
  const u = r.usageMetadata;
  if (isObj(u)) addUsageSince(run, mark, geminiUsage(u.promptTokenCount, u.cachedContentTokenCount, u.candidatesTokenCount, u.thoughtsTokenCount, u.toolUsePromptTokenCount), ts);
  const open = Object.keys(st.pending).length > 0;
  run.turn = open ? 'in_progress' : 'completed';
  run.turnDetail = undefined;
}

function onFunctionCall(run: ParsedRun, st: QwenState, fc: Part, ts: number | undefined): void {
  const name = str(fc.name) ?? 'tool';
  const id = str(fc.id) ?? `${name}@${ts ?? 0}`;
  if (id === '__proto__') return; // never a real call id; would replace pending's prototype
  const kind = kindOf(name);
  // Edit tools get their file_change from the result, so a failed edit counts no file.
  pushEvent(run, {
    kind: 'tool_call',
    text: toolInputSummary(fc.args),
    ts,
    toolName: name,
    toolCallId: id,
    toolKind: kind,
    filePath: kind === 'edit' ? undefined : toolFilePath(fc.args),
  });
  st.pending[id] = { name, since: ts ?? 0, filePath: toolFilePath(fc.args) };
}

function onToolResult(run: ParsedRun, st: QwenState, r: Record<string, unknown>, ts: number | undefined): void {
  const parts = partsOf(isObj(r.message) ? r.message.parts : undefined);
  const fr = parts.find((p) => isObj(p.functionResponse))?.functionResponse as Part | undefined;
  const tcr = isObj(r.toolCallResult) ? r.toolCallResult : {};
  // Without an id, pair with the oldest open call of the same tool.
  const id =
    str(tcr.callId) ?? str(fr?.id) ?? Object.keys(st.pending).find((k) => st.pending[k].name === str(fr?.name));
  const pending = id && Object.hasOwn(st.pending, id) ? st.pending[id] : undefined;
  const name = str(fr?.name) ?? pending?.name ?? 'tool';
  if (pending) delete st.pending[id!];
  const res = responseOf(fr);
  const status = str(tcr.status);
  const isError = status === 'error' || res.isError;
  let text = resultText(tcr.resultDisplay, res);
  if (!text && status === 'cancelled') text = 'Cancelled';
  const kind = kindOf(name);
  pushEvent(run, { kind: 'tool_result', text, ts, toolName: name, toolCallId: id, toolKind: kind, isError });
  if (kind === 'edit' && status !== 'cancelled' && !isError) {
    const diff = fileDiffOf(tcr.resultDisplay);
    const filePath = diff?.filePath ?? pending?.filePath;
    const fileOp = diff?.fileOp ?? opForTool(name);
    if (filePath) {
      pushEvent(run, { kind: 'file_change', text: diff?.diff ?? `${fileOp} ${filePath}`, ts, toolName: name, toolCallId: id, filePath, fileOp });
      noteFileChange(run, diff, filePath, fileOp, ts, id);
    }
  }
  if (status === 'cancelled') st.cancelled = true;
  const stillOpen = Object.keys(st.pending).length > 0;
  // All tools answered: the results go back to the model, unless the user cancelled.
  if (stillOpen || !st.cancelled) setTurn(run, 'in_progress');
  else setTurn(run, 'aborted', 'Tool call cancelled');
}

function onSystem(run: ParsedRun, st: QwenState, r: Record<string, unknown>, ts: number | undefined): boolean {
  const sub = str(r.subtype);
  const p = isObj(r.systemPayload) ? r.systemPayload : {};
  switch (sub) {
    case 'custom_title':
      if (p.titleSource === 'manual') st.manualTitle = str(p.customTitle) ?? st.manualTitle;
      else st.autoTitle = str(p.customTitle) ?? st.autoTitle;
      return true;
    case 'session_model':
      st.sessionModel = str(p.modelId) ?? st.sessionModel;
      return true;
    case 'turn_result':
      onTurnResult(run, st, p);
      return true;
    case 'rewind':
      pushEvent(run, { kind: 'system', text: `Rewound the conversation${p.truncatedCount ? ` (${p.truncatedCount} messages)` : ''}`, ts });
      return true;
    case 'chat_compression':
      // A resume-time reconstruction aid; replaying its history would duplicate events.
      pushEvent(run, { kind: 'system', text: 'Conversation compressed', ts });
      return true;
    case 'slash_command':
      if (str(p.rawCommand) && p.phase !== 'result') pushEvent(run, { kind: 'system', text: p.rawCommand as string, ts });
      return true;
    case 'ui_telemetry':
      onTelemetry(run, st, p, ts);
      return true;
    default:
      return !!sub && QUIET_SUBTYPES.has(sub);
  }
}

/** Only ACP (IDE / daemon) sessions write turn_result; when present it is authoritative. */
function onTurnResult(run: ParsedRun, st: QwenState, p: Record<string, unknown>): void {
  const err = isObj(p.error) ? str(p.error.message) : undefined;
  if (p.state === 'error') setTurn(run, 'error', err ?? 'The turn ended with an error');
  else if (p.state === 'cancelled') setTurn(run, 'aborted', 'Cancelled');
  else if (p.state === 'completed') setTurn(run, 'completed');
  else return;
  st.pending = {};
}

/**
 * API errors are logged only as telemetry; one with no later assistant record ends the turn.
 * Failed API calls are retried with backoff and each failed attempt may log its own api_error,
 * so a later api_response means a retry got through and the turn is still going.
 */
function onTelemetry(run: ParsedRun, st: QwenState, p: Record<string, unknown>, ts: number | undefined): void {
  const ev = isObj(p.uiEvent) ? p.uiEvent : {};
  const name = ev['event.name'];
  if (name === 'qwen-code.api_response') {
    if (st.apiError && run.turn === 'error') setTurn(run, 'in_progress');
    st.apiError = false;
    return;
  }
  if (name !== 'qwen-code.api_error') return;
  const msg = str(ev.error_message) ?? str(ev.error_type) ?? 'API error';
  pushEvent(run, { kind: 'error', text: msg, ts, isError: true });
  setTurn(run, 'error', `API error: ${msg}`);
  st.apiError = true;
}

function setTurn(run: ParsedRun, turn: TurnState, detail?: string): void {
  run.turn = turn;
  run.turnDetail = detail;
}

/** Fields derived from the whole state, set after each batch of records. */
export function finishQwenRun(run: ParsedRun, st: QwenState): void {
  run.title = st.manualTitle ?? st.promptTitle ?? st.autoTitle ?? run.title;
  if (!run.model && st.sessionModel) run.model = st.sessionModel;
  const open = Object.values(st.pending).at(-1);
  run.openTool = open ? { name: open.name, kind: kindOf(open.name), since: open.since } : undefined;
  if (open && run.turn === 'in_progress' && isQuestionTool(open.name)) setTurn(run, 'waiting_input', 'Waiting for your answer');
}
