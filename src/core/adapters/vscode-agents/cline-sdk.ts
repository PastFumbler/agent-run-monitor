// Cline 4.x ("Cline SDK") sessions: ~/.cline/data/sessions/<id>/<id>.json (manifest) and
// <id>.messages.json ({version, updated_at, messages[]}; older writers store a bare array).
//
// Provenance (research/vscode-agents.md, 2026-10-27): checked against cline/cline @ 775d039
// (extension 4.1.26): sdk/packages/core session-artifacts.ts, session-manifest.ts,
// shared/src/llms/messages.ts, runtime/orchestration/session-runtime-orchestrator.ts [source].
// Cline is not installed on the development machine, so no real session was seen.
//
// Quirks:
// - The messages file is rewritten non-atomically on every persist, so a reader can catch it
//   cut off; the complete leading messages are recovered (see readTranscript).
// - The manifest's `status` (idle | running | pending | completed | failed | cancelled) is the
//   authoritative state. `idle` means the turn finished and the session waits for the next prompt.
// - User text is wrapped in <user_input mode="act|plan">…</user_input>.
// - A terminal run error is a display-only assistant message (metadata.displayRole "error").
// - The SQLite index (db/sessions.db) holds the same fields as the manifests; it is not read.

import { join } from 'node:path';
import type { FileOp } from '@shared/schema';
import { emptyRun, type ParsedRun, type ParseState, type SessionRef, type TurnState } from '../../adapter';
import { applyPatchFiles, diffTexts, newFileDiff, pushChange } from '../../changes';
import { baseName, clip, makeTitle, pushEvent, textOf, toMs, toolInputSummary } from '../../events';
import { addUsageSince, setUsageTotal } from '../../usage';
import {
  fileOpOf,
  fingerprint,
  isObj,
  kindOf,
  looksFailed,
  num,
  patchFiles,
  readJsonQuiet,
  readTranscript,
  resultText,
  str,
  UNRECOGNISED,
  unchanged,
  type Obj,
} from './common';

/** The wrappers the SDK puts around typed text: <user_input mode="act">, <user_command slash="x">. */
const USER_INPUT = /<\/?user_input\b[^>]*>/g;
const MODE_NOTICE = /<mode_notice>[\s\S]{0,2000}?<\/mode_notice>/g;
const USER_COMMAND = /^\s*<user_command\b[^>]*\bslash="([^"]+)"[^>]*>([\s\S]*)<\/user_command>\s*$/i;
/** Appended as a user message when a 3.x task is resumed [source: apps/vscode/src/sdk/legacy-task-handling.ts]. */
const LEGACY_WARNING = 'Warning: this is a legacy conversation, which means tool names may have changed.';

/** Typed text as Cline shows it (formatDisplayUserInput): wrappers and mode notices removed, `/cmd text` for slash commands. */
function displayUserInput(text: string): string {
  const cmd = USER_COMMAND.exec(text);
  const body = (cmd ? cmd[2] : text).replace(MODE_NOTICE, '').replace(USER_INPUT, '').replace(/<\/?user_command\b[^>]*>/g, '').trim();
  return cmd ? `/${cmd[1]}${body ? ` ${body}` : ''}` : body;
}

interface Result {
  text: string;
  isError: boolean;
}

export async function parseClineSdk(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const id = ref.hint?.sessionId ?? baseName(ref.path).replace(/(\.messages)?\.json$/, '');
  const manifestPath = ref.hint?.manifest ?? join(ref.path, '..', `${id}.json`);
  const isManifestOnly = ref.path === manifestPath;
  const siblings = { manifest: isManifestOnly ? 0 : await fingerprint(manifestPath) };
  if (unchanged(ref, prev, siblings)) return prev!;

  const manifestRaw = await readJsonQuiet(manifestPath, 4 * 1024 * 1024);
  const manifest = isObj(manifestRaw) ? manifestRaw : undefined;
  let messages: unknown[] = [];
  let salvaged = false;
  if (!isManifestOnly) {
    try {
      const r = await readTranscript(ref.path, 'messages');
      salvaged = r.salvaged;
      const v = r.value;
      messages = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.messages) ? v.messages : [];
      if (!Array.isArray(v) && !(isObj(v) && Array.isArray(v.messages))) {
        const st = freshFrom(ref, manifest);
        manifestUsage(st.run, manifest);
        st.run.readError = UNRECOGNISED;
        return st;
      }
    } catch (e) {
      if (prev && !prev.run.readError) return prev;
      if (!manifest) throw e;
      salvaged = true; // only the manifest is readable; show what it says
    }
  }

  const st = freshFrom(ref, manifest);
  st.extra = { siblings };
  const run = st.run;
  const recognised = walkMessages(run, messages.filter(isObj));
  manifestUsage(run, manifest);
  run.skipped += messages.length - messages.filter(isObj).length;
  if (salvaged) run.skipped++;
  if (messages.length > 0 && recognised === 0) run.readError = UNRECOGNISED;
  setTurn(run, manifest, messages.filter(isObj));
  return st;
}

function freshFrom(ref: SessionRef, manifest: Obj | undefined): ParseState {
  const meta = isObj(manifest?.metadata) ? (manifest!.metadata as Obj) : {};
  const projectPath = str(manifest?.workspace_root) ?? str(manifest?.cwd);
  const run = emptyRun(baseName(projectPath) || 'Unknown project');
  if (projectPath) run.projectPath = projectPath;
  const title = str(meta.title) ?? str(manifest?.prompt);
  if (title) run.title = makeTitle(displayUserInput(title));
  run.model = str(manifest?.model) ?? str(meta.modelId);
  const started = toMs(manifest?.started_at);
  if (started) run.startedAt = started;
  return { offset: 0, size: ref.size, mtimeMs: ref.mtimeMs, run, extra: {} };
}

/**
 * The manifest's session totals win over the per-message metrics (kept as recorded; the cache
 * figures are separate fields). Growth beyond the messages has no known day.
 */
function manifestUsage(run: ParsedRun, manifest: Obj | undefined): void {
  const meta = isObj(manifest?.metadata) ? (manifest!.metadata as Obj) : {};
  if (num(meta.tokensIn) == null && num(meta.tokensOut) == null) return;
  setUsageTotal(run, { input: num(meta.tokensIn), output: num(meta.tokensOut), cacheRead: num(meta.cacheReads), cacheWrite: num(meta.cacheWrites) });
}

/** Builds events from the messages; returns how many messages were recognised. */
function walkMessages(run: ParsedRun, messages: Obj[]): number {
  const results = new Map<string, Result>();
  for (const m of messages) {
    for (const b of blocksOf(m)) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const text = clip(resultText(b.content));
        results.set(b.tool_use_id, { text, isError: b.is_error === true || looksFailed(text) });
      }
    }
  }
  let recognised = 0;
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') {
      run.skipped++;
      continue;
    }
    recognised++;
    const ts = toMs(m.ts);
    const meta = isObj(m.metadata) ? m.metadata : {};
    if (meta.displayOnly === true && meta.displayRole === 'error') {
      pushEvent(run, { kind: 'error', text: textOf(blocksOf(m)) || 'Error', ts, isError: true });
      continue;
    }
    // displayRole "system"/"status": injected hook context, compaction summaries, "continue where
    // you left off" reminders. They reach the model as user messages but are not the user's words
    // [source: sdk/packages/agents/src/agent-runtime.ts, core/src/extensions/context/compaction-shared.ts].
    const plain = textOf(blocksOf(m).filter((b) => b.type === 'text'));
    if (meta.displayRole === 'system' || meta.displayRole === 'status' || (m.role === 'user' && plain.startsWith(LEGACY_WARNING))) {
      const label = meta.kind === 'compaction_summary' ? 'Context compacted' : meta.displayRole === 'status' ? 'Status' : 'Context added';
      if (plain.trim()) pushEvent(run, { kind: 'system', text: plain.startsWith(LEGACY_WARNING) ? 'Resumed a Cline 3.x task' : `${label}: ${plain}`, ts });
      for (const b of blocksOf(m)) if (b.type === 'tool_result') block(run, m.role, b, ts, results, names);
      continue;
    }
    const mi = isObj(m.modelInfo) ? m.modelInfo : undefined;
    if (mi && str(mi.id) && !run.model) run.model = String(mi.id);
    const mark = run.tally.events;
    for (const b of blocksOf(m)) block(run, m.role, b, ts, results, names);
    const x = isObj(m.metrics) ? m.metrics : undefined;
    if (x) addUsageSince(run, mark, { input: num(x.inputTokens), output: num(x.outputTokens), cacheRead: num(x.cacheReadTokens), cacheWrite: num(x.cacheWriteTokens) }, ts);
  }
  return recognised;
}

function blocksOf(m: Obj): Obj[] {
  if (typeof m.content === 'string') return [{ type: 'text', text: m.content }];
  return Array.isArray(m.content) ? m.content.filter(isObj) : [];
}

function block(run: ParsedRun, role: unknown, b: Obj, ts: number | undefined, results: Map<string, Result>, names: Map<string, string>): void {
  switch (b.type) {
    case 'text': {
      const text = typeof b.text === 'string' ? b.text : '';
      if (!text.trim()) return;
      if (role === 'user') {
        const shown = displayUserInput(text);
        if (shown) pushEvent(run, { kind: 'user', text: shown, ts });
      }
      else pushEvent(run, { kind: 'assistant', text, ts });
      return;
    }
    case 'thinking':
      if (typeof b.thinking === 'string' && b.thinking.trim()) pushEvent(run, { kind: 'reasoning', text: b.thinking, ts });
      return;
    case 'redacted_thinking':
      pushEvent(run, { kind: 'reasoning', text: '(reasoning hidden by the provider)', ts, placeholder: true });
      return;
    case 'tool_use':
      toolUse(run, b, ts, results, names);
      return;
    case 'tool_result': {
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
      const r = id ? results.get(id) : undefined;
      const name = str(b.name) ?? (id ? names.get(id) : undefined);
      pushEvent(run, { kind: 'tool_result', text: r?.text ?? '', ts, toolCallId: id, toolName: name, toolKind: kindOf(name), isError: r?.isError ?? false });
      return;
    }
    case 'image':
    case 'file':
    case 'media':
      return; // attachments: not shown (can be large base64)
    default:
      run.skipped++;
  }
}

/** Files an edit tool touched: `editor {path}` or the `*** Update File:` lines of apply_patch. */
function editedFiles(name: string, input: unknown): { path: string; op: FileOp }[] {
  if (!isObj(input)) return [];
  if (name === 'apply_patch') return patchFiles(str(input.input) ?? str(input.patch) ?? '');
  const p = str(input.path) ?? str(input.file_path) ?? str(input.filePath);
  return p ? [{ path: p, op: fileOpOf(name) }] : [];
}

function toolUse(run: ParsedRun, b: Obj, ts: number | undefined, results: Map<string, Result>, names: Map<string, string>): void {
  const id = typeof b.id === 'string' ? b.id : undefined;
  const name = str(b.name) ?? 'tool';
  if (id) names.set(id, name);
  const kind = kindOf(name);
  const failed = id ? results.get(id)?.isError === true : false;
  const files = kind === 'edit' && !failed ? editedFiles(name, b.input) : [];
  const one = files.length === 1 ? { filePath: files[0].path, fileOp: files[0].op } : {};
  pushEvent(run, { kind: 'tool_call', text: sdkSummary(b.input), ts, toolName: name, toolCallId: id, toolKind: kind, ...one });
  if (files.length > 1) for (const f of files) pushEvent(run, { kind: 'file_change', text: f.path, ts, filePath: f.path, fileOp: f.op, toolCallId: id, toolName: name });
  // A change once the call's result is in and not an error.
  const r = id ? results.get(id) : undefined;
  if (!files.length || !r || r.isError) return;
  const input = isObj(b.input) ? b.input : {};
  if (name === 'apply_patch') {
    for (const f of applyPatchFiles(str(input.input) ?? str(input.patch) ?? '')) {
      if (!f.moved) pushChange(run, { ts, filePath: f.path, op: f.op, diff: f.diff?.diff, linesAdded: f.diff?.added, linesRemoved: f.diff?.removed, toolCallId: id });
    }
    return;
  }
  const before = str(input.old_text) ?? str(input.old_str);
  const after = str(input.new_text) ?? str(input.new_str);
  const content = str(input.content) ?? str(input.file_text);
  const d = before !== undefined && after !== undefined ? diffTexts(before, after) : content !== undefined ? newFileDiff(content) : undefined;
  pushChange(run, { ts, filePath: files[0].path, op: files[0].op, diff: d?.diff, linesAdded: d?.added, linesRemoved: d?.removed, toolCallId: id });
}

/** The SDK tools take lists (read_files.files, run_commands.commands, search_codebase.queries). */
function sdkSummary(input: unknown): string {
  if (isObj(input)) {
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (isObj(x) ? str(x.path) : str(x))).filter(Boolean).join('\n') : '');
    const joined = list(input.files) || list(input.commands) || list(input.queries);
    if (joined) return joined;
    if (typeof input.input === 'string') return input.input; // apply_patch
  }
  return toolInputSummary(input);
}

// ---------------------------------------------------------------- turn state

function setTurn(run: ParsedRun, manifest: Obj | undefined, messages: Obj[]): void {
  const lastError = [...run.events].reverse().find((e) => e.kind === 'error');
  const status = str(manifest?.status);
  const t = turnFrom(status, manifest, lastError?.text, messages);
  run.turn = t.turn;
  if (t.detail) run.turnDetail = t.detail;
  if (t.turn === 'in_progress' || t.turn === 'waiting_input') {
    const open = openCall(messages);
    if (open) {
      run.openTool = { name: open.name, kind: kindOf(open.name), since: open.ts ?? run.lastEventAt ?? 0 };
      if (open.name === 'ask_question') {
        run.turn = 'waiting_input';
        run.turnDetail = 'The agent asked you a question';
      }
    }
  }
}

function turnFrom(status: string | undefined, manifest: Obj | undefined, lastError: string | undefined, messages: Obj[]): { turn: TurnState; detail?: string } {
  switch (status) {
    case 'failed': {
      const meta = isObj(manifest?.metadata) ? (manifest!.metadata as Obj) : {};
      // Written by Cline's stale-session reconciler when the process died (editor closed mid-run):
      // an interruption, not an error in the run itself.
      if (meta.terminal_marker === 'failed_external_process_exit') return { turn: 'aborted', detail: 'Interrupted: the editor or agent process exited mid-run' };
      return { turn: 'error', detail: lastError ?? `Ended with exit code ${num(manifest?.exit_code) ?? 1}` };
    }
    case 'cancelled':
      return { turn: 'aborted', detail: 'Cancelled' };
    case 'completed':
    case 'idle':
      return { turn: 'completed' };
    case 'running':
    case 'pending':
      return { turn: 'in_progress' };
    default:
      break;
  }
  // No manifest: judge by the last message.
  const last = messages[messages.length - 1];
  if (!last) return { turn: 'unknown' };
  const meta = isObj(last.metadata) ? last.metadata : {};
  if (meta.displayRole === 'error') return { turn: 'error', detail: lastError };
  if (last.role === 'assistant' && !blocksOf(last).some((b) => b.type === 'tool_use')) return { turn: 'completed' };
  return { turn: 'in_progress' };
}

/** The newest tool_use with no tool_result anywhere after it. */
function openCall(messages: Obj[]): { name: string; ts?: number } | undefined {
  const answered = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = blocksOf(messages[i]);
    for (const b of blocks) if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') answered.add(b.tool_use_id);
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      if (b.type === 'tool_use' && typeof b.id === 'string' && !answered.has(b.id)) return { name: str(b.name) ?? 'tool', ts: toMs(messages[i].ts) };
    }
    if (messages[i].role === 'assistant' && blocks.some((b) => b.type === 'tool_use')) return undefined;
  }
  return undefined;
}
