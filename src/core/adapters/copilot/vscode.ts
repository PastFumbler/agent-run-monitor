// GitHub Copilot Chat in VS Code (ask, edit and agent modes).
//
// Provenance (research/copilot.md, 2026-10-27): the on-disk format was read from the shipped
// code of VS Code 1.143.1 (ChatSessionStore, ChatModel, log serializer) and Copilot Chat 0.71.0
// [source]. Only the locations were checked on a real Windows install (%APPDATA%\Code\User,
// workspaceStorage/<id>/workspace.json, globalStorage/emptyWindowChatSessions) and every session
// there was empty, so record contents were never seen end to end: confidence is 'source'.
// Insiders, VSCodium, macOS and Linux paths are best-effort.
//
// Layout under the VS Code user dir (<UD>):
//   workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl   current: mutation log
//   workspaceStorage/<hash>/chatSessions/<sessionId>.json    older: whole-file snapshot
//   workspaceStorage/<hash>/workspace.json                   {"folder": "file:///..."}
//   globalStorage/emptyWindowChatSessions/<id>.jsonl|json    chats in a window with no folder
//   globalStorage/transferredChatSessions/<id>.json          chats moved between windows
// When both <id>.jsonl and <id>.json exist VS Code reads the .jsonl first; so do we.

import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { FileOp, ToolKind } from '@shared/schema';
import { emptyRun, type DiscoverContext, type Env, type ParsedRun, type ParseState, type SessionRef } from '../../adapter';
import { baseName, isObj, makeTitle, pushEvent, toMs, toolFilePath, toolInputSummary, toolKind } from '../../events';
import { readJson, readJsonl } from '../../jsonl';
import { diffTexts, newFileDiff, pushChange, type DiffText } from '../../changes';
import { addUsageSince, tokenCount } from '../../usage';
import { canContinue, cleanLinks, firstLinkedPath, listDir, readSignature, readSmallText, statOrNull, uriToPath } from './shared';

export const UNRECOGNISED = "No records this app recognises; the agent may have changed its format.";

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------- locations

const VARIANTS = ['Code', 'Code - Insiders', 'VSCodium'];

/** The VS Code user dirs (<appData>/<variant>/User) for this OS, plus portable mode. */
export function vscodeRoots(env: Env): string[] {
  const p = env.platform === 'win32' ? win32 : posix;
  const v = env.vars;
  const roots: string[] = [];
  // Portable mode keeps everything next to the executable: <VSCODE_PORTABLE>/user-data/User.
  if (v.VSCODE_PORTABLE) roots.push(p.join(v.VSCODE_PORTABLE, 'user-data', 'User'));
  const appData =
    v.VSCODE_APPDATA ||
    (env.platform === 'win32'
      ? v.APPDATA || p.join(env.home, 'AppData', 'Roaming')
      : env.platform === 'darwin'
        ? p.join(env.home, 'Library', 'Application Support')
        : v.XDG_CONFIG_HOME || p.join(env.home, '.config'));
  for (const name of VARIANTS) roots.push(p.join(appData, name, 'User'));
  return [...new Set(roots)];
}

// ---------------------------------------------------------------- discover

export async function discoverVscode(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const out: SessionRef[] = [];
  const seen = new Set<string>();
  for (const root of new Set(roots)) {
    for (const ref of await discoverRoot(root, ctx.since)) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      out.push(ref);
    }
  }
  return out;
}

/** A root may be a user dir, one workspaceStorage/<hash> dir, or a folder of session files. */
async function discoverRoot(root: string, since: number): Promise<SessionRef[]> {
  const entries = await listDir(root);
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const refs: SessionRef[] = [];
  if (dirs.has('workspaceStorage') || dirs.has('globalStorage')) {
    const wsRoot = join(root, 'workspaceStorage');
    for (const ws of await listDir(wsRoot)) {
      if (ws.isDirectory()) refs.push(...(await scanWorkspace(join(wsRoot, ws.name), since)));
    }
    for (const sub of ['emptyWindowChatSessions', 'transferredChatSessions']) {
      refs.push(...(await scanSessionDir(join(root, 'globalStorage', sub), since, undefined)));
    }
  } else if (dirs.has('chatSessions')) {
    refs.push(...(await scanWorkspace(root, since)));
  } else {
    refs.push(...(await scanSessionDir(root, since, undefined)));
  }
  return refs;
}

async function scanWorkspace(wsDir: string, since: number): Promise<SessionRef[]> {
  const dir = join(wsDir, 'chatSessions');
  const files = await listDir(dir);
  if (!files.length) return [];
  return scanSessionDir(dir, since, await workspaceFolder(wsDir), files);
}

/** workspace.json maps the hashed folder to {folder} or {workspace} (a .code-workspace file). */
async function workspaceFolder(wsDir: string): Promise<string | undefined> {
  const text = await readSmallText(join(wsDir, 'workspace.json'), 64 * 1024);
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as Obj;
    if (typeof j.folder === 'string') return uriToPath(j.folder);
    if (typeof j.workspace === 'string') return uriToPath(j.workspace);
  } catch {
    // A broken workspace.json only costs us the project name.
  }
  return undefined;
}

async function scanSessionDir(
  dir: string,
  since: number,
  projectPath: string | undefined,
  entries?: Awaited<ReturnType<typeof listDir>>,
): Promise<SessionRef[]> {
  const byId = new Map<string, { jsonl?: string; json?: string }>();
  for (const e of entries ?? (await listDir(dir))) {
    if (!e.isFile()) continue;
    const m = /^(.+)\.(jsonl|json)$/i.exec(e.name);
    if (!m) continue;
    const slot = byId.get(m[1]) ?? {};
    slot[m[2].toLowerCase() as 'jsonl' | 'json'] = join(dir, e.name);
    byId.set(m[1], slot);
  }
  const refs: SessionRef[] = [];
  for (const [id, f] of byId) {
    const a = f.jsonl ? await statOrNull(f.jsonl) : null;
    const b = f.json ? await statOrNull(f.json) : null;
    // Prefer the log; fall back to the snapshot when the log is missing or empty.
    const useLog = !!(a && a.size > 0);
    const chosen = useLog ? a : b;
    const path = useLog ? f.jsonl : f.json;
    if (!chosen || !path || chosen.size === 0) continue;
    if (since > 0 && chosen.mtimeMs < since) continue;
    const hint: Record<string, string> = { sessionId: id };
    if (projectPath) {
      hint.projectPath = projectPath;
      hint.project = projectNameOf(projectPath);
    }
    if (useLog && f.json && b && b.size > 0) hint.alt = f.json;
    refs.push({ agent: 'copilot-vscode', path, mtimeMs: chosen.mtimeMs, size: chosen.size, hint });
  }
  return refs;
}

function join(a: string, ...rest: string[]): string {
  return (/^[a-zA-Z]:[\\/]|^\\\\/.test(a) ? win32 : posix).join(a, ...rest);
}

function projectNameOf(p: string): string {
  return baseName(p).replace(/\.code-workspace$/i, '');
}

// ---------------------------------------------------------------- parse

interface LogState {
  data: Obj | null;
  recognised: number;
  skipped: number;
  bad: number;
  lines: number;
}

export async function parseVscode(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const s = await stat(ref.path);
  const kind = /\.jsonl$/i.test(ref.path) ? 'vscode-jsonl' : 'vscode-json';
  // Unchanged since last time: nothing to do (whole-file and log formats alike).
  if (prev && prev.extra.kind === kind && prev.size === s.size && prev.mtimeMs === s.mtimeMs) return prev;
  return kind === 'vscode-jsonl' ? parseLog(ref, prev, s.size) : parseSnapshot(ref, s.size, s.mtimeMs);
}

async function parseSnapshot(ref: SessionRef, size: number, mtimeMs: number): Promise<ParseState> {
  const data = await readJson(ref.path);
  const run = isChatData(data) ? buildRun(normalise(data), ref, 0) : unrecognised(ref);
  return { offset: size, size, mtimeMs, run, extra: { kind: 'vscode-json' } };
}

/**
 * The .jsonl log must be replayed from its first line (later lines patch paths inside earlier
 * state), so the replayed object is kept in extra.log and new lines are applied on top of it.
 * Events are rebuilt from that object each time: a later line can rewrite an earlier response.
 */
async function parseLog(ref: SessionRef, prev: ParseState | undefined, size: number): Promise<ParseState> {
  const cont = await canContinue(ref.path, prev, size, 'vscode-jsonl');
  const log: LogState = cont ? (prev!.extra.log as LogState) : { data: null, recognised: 0, skipped: 0, bad: 0, lines: 0 };
  const res = await readJsonl(ref.path, cont ? prev!.offset : 0, (rec) => applyEntry(log, rec));
  log.bad += res.bad;
  log.lines += res.good + res.bad;

  let run: ParsedRun;
  if (log.data) run = buildRun(log.data, ref, log.skipped + log.bad);
  else if (ref.hint?.alt) run = await fallbackSnapshot(ref, ref.hint.alt);
  else if (log.lines > 0) run = unrecognised(ref, log.skipped + log.bad);
  else run = emptyRun(ref.hint?.project || 'Unknown project');

  const sig = await readSignature(ref.path, res.offset);
  return { offset: res.offset, size: res.size, mtimeMs: res.mtimeMs, run, extra: { kind: 'vscode-jsonl', sig, log } };
}

/** A log without its initial snapshot is unusable; VS Code then reads <id>.json, and so do we. */
async function fallbackSnapshot(ref: SessionRef, alt: string): Promise<ParsedRun> {
  try {
    const data = await readJson(alt);
    if (isChatData(data)) return buildRun(normalise(data), ref, 0);
  } catch {
    // fall through
  }
  return unrecognised(ref);
}

function unrecognised(ref: SessionRef, skipped = 0): ParsedRun {
  const run = emptyRun(ref.hint?.project || 'Unknown project');
  run.readError = UNRECOGNISED;
  run.skipped = skipped;
  return run;
}

function isChatData(v: unknown): v is Obj {
  return isObj(v) && (Array.isArray(v.requests) || typeof v.sessionId === 'string');
}

// ---------------------------------------------------------------- mutation log replay

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
type Key = string | number;

function keyPath(k: unknown): Key[] | null {
  if (!Array.isArray(k)) return null;
  for (const x of k) {
    if (typeof x === 'number' ? !Number.isInteger(x) || x < 0 : typeof x !== 'string' || UNSAFE_KEYS.has(x)) return null;
  }
  return k as Key[];
}

/** The container that holds the last key of `k`, or undefined when an intermediate is missing. */
function parentOf(root: Obj, k: Key[]): Record<Key, unknown> | undefined {
  let cur: unknown = root;
  for (let i = 0; i < k.length - 1; i++) {
    cur = (cur as Record<Key, unknown>)[k[i]];
    if (typeof cur !== 'object' || cur === null) return undefined;
  }
  return cur as Record<Key, unknown>;
}

/**
 * Replay rules from the VS Code log serializer [source]:
 *   kind 0 {v}       initial snapshot (also what a compacted file restarts with)
 *   kind 1 {k, v}    set the value at path k
 *   kind 2 {k, v, i} truncate the array at k to length i (when given), then push v's items
 *   kind 3 {k}       delete the key at path k
 */
function applyEntry(log: LogState, rec: unknown): void {
  if (!isObj(rec)) return void log.skipped++;
  if (rec.kind === 0) {
    if (!isObj(rec.v)) return void log.skipped++;
    log.data = normalise(rec.v);
    log.recognised++;
    return;
  }
  const k = keyPath(rec.k);
  if (!log.data || !k || ![1, 2, 3].includes(rec.kind as number)) return void log.skipped++;
  const ok = rec.kind === 1 ? setAt(log.data, k, rec.v) : rec.kind === 2 ? pushAt(log.data, k, rec.v, rec.i) : deleteAt(log.data, k);
  if (ok) log.recognised++;
  else log.skipped++;
}

function setAt(root: Obj, k: Key[], v: unknown): boolean {
  if (!k.length) return false;
  const parent = parentOf(root, k);
  if (!parent) return false;
  parent[k[k.length - 1]] = v;
  return true;
}

function pushAt(root: Obj, k: Key[], v: unknown, i: unknown): boolean {
  if (!k.length) return false;
  const parent = parentOf(root, k);
  if (!parent) return false;
  const last = k[k.length - 1];
  if (parent[last] === undefined || parent[last] === null) parent[last] = [];
  const arr = parent[last];
  if (!Array.isArray(arr)) return false;
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < arr.length) arr.length = i;
  if (Array.isArray(v)) for (const item of v) arr.push(item);
  return true;
}

function deleteAt(root: Obj, k: Key[]): boolean {
  if (!k.length) return false;
  const parent = parentOf(root, k);
  if (!parent) return false;
  const last = k[k.length - 1];
  if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
  else delete parent[last];
  return true;
}

/** Older snapshots: no version = v1, v2 used computedTitle; responses may be plain strings. */
function normalise(d: Obj): Obj {
  if (d.version === 2 && d.customTitle === undefined && typeof d.computedTitle === 'string') d.customTitle = d.computedTitle;
  return d;
}

// ---------------------------------------------------------------- building the run

/** VS Code tool ids that the shared name rules miss (or file under the wrong kind). [source, list may drift] */
const VSCODE_TOOL_KINDS: Record<string, ToolKind> = {
  copilot_readfile: 'read',
  copilot_replacestring: 'edit',
  copilot_multireplacestring: 'edit',
  copilot_insertedit: 'edit',
  copilot_createfile: 'edit',
  copilot_applypatch: 'edit',
  copilot_editnotebook: 'edit',
  copilot_findfiles: 'search',
  copilot_findtextinfiles: 'search',
  copilot_searchcodebase: 'search',
  copilot_listdirectory: 'search',
  copilot_searchworkspacesymbols: 'search',
  copilot_listcodeusages: 'search',
  copilot_fetchwebpage: 'web',
  copilot_githubrepo: 'web',
  copilot_runinterminal: 'run',
  run_in_terminal: 'run',
  copilot_runtests: 'run',
  runsubagent: 'agent',
  copilot_runsubagent: 'agent',
  search_subagent: 'agent',
};

export function vscodeToolKind(id: string): ToolKind {
  const known = VSCODE_TOOL_KINDS[id.toLowerCase()];
  if (known) return known;
  const direct = toolKind(id);
  if (direct !== 'other') return direct;
  // copilot_readFile -> read_file, so the shared rules get a second chance.
  const snake = id.replace(/^copilot_/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return toolKind(snake);
}

/** Response part kinds we understand but do not show. */
const QUIET_PARTS = new Set([
  'undoStop',
  'codeblockUri',
  'codeCitation',
  'prepareToolInvocation',
  'mcpServersStarting',
  'references',
  'reference',
  'usedContext',
  'command',
  'pullRequest',
  'extensions',
  'treeData',
  'multiDiffData',
  'planReview',
  'textEdit',
  'notebookEdit',
  'toolInvocation',
]);

function buildRun(data: Obj, ref: SessionRef, extraSkipped: number): ParsedRun {
  const run = emptyRun(ref.hint?.project || 'Unknown project');
  const cwd = uriToPath(data.workingDirectory) ?? ref.hint?.projectPath;
  if (cwd) {
    run.projectPath = cwd;
    run.projectName = projectNameOf(cwd) || run.projectName;
  }
  const created = toMs(data.creationDate);
  if (created) run.startedAt = created;

  const reqs = (Array.isArray(data.requests) ? data.requests : []).filter(isObj);
  reqs.forEach((r) => emitRequest(run, r));
  // VS Code's own title: customTitle (renamed, or generated by Copilot), else the first prompt,
  // which pushEvent already took. [source: getDefaultTitle]
  const custom = typeof data.customTitle === 'string' ? makeTitle(data.customTitle) : '';
  if (custom) run.title = custom;
  run.model = modelOf(reqs.at(-1), data);
  judgeTurn(run, reqs.at(-1));
  run.skipped += extraSkipped;
  return run;
}

function modelOf(last: Obj | undefined, data: Obj): string | undefined {
  const sel = isObj(data.inputState) && isObj(data.inputState.selectedModel) ? data.inputState.selectedModel : undefined;
  const raw =
    (typeof last?.modelId === 'string' && last.modelId) ||
    (sel && typeof sel.identifier === 'string' && sel.identifier) ||
    (sel && isObj(sel.metadata) && typeof sel.metadata.id === 'string' && sel.metadata.id) ||
    undefined;
  return raw ? raw.replace(/^copilot\//, '') : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** An IMarkdownString ({value}) or a plain string. */
function mdValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isObj(v) && typeof v.value === 'string') return v.value;
  return '';
}

function messageText(m: unknown): string {
  if (typeof m === 'string') return m;
  if (!isObj(m)) return '';
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.parts)) return m.parts.map((p) => (isObj(p) ? str(p.text) : '')).join('');
  return '';
}

/** Older files store the response as a string or an array of strings: those are markdown parts. */
function responseParts(r: Obj): Obj[] {
  const resp = r.response;
  if (typeof resp === 'string') return [{ value: resp }];
  if (!Array.isArray(resp)) return [];
  return resp.map((p) => (typeof p === 'string' ? { value: p } : p)).filter(isObj);
}

function isMarkdown(p: Obj): boolean {
  return p.kind === undefined && typeof p.value === 'string';
}

/** toolCallRounds keep the raw tool arguments (a JSON string) keyed by tool call id. [source; nesting plausible] */
function argsById(r: Obj): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const meta = isObj(r.result) && isObj(r.result.metadata) ? r.result.metadata : undefined;
  const rounds = meta && Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds : [];
  for (const round of rounds) {
    if (!isObj(round) || !Array.isArray(round.toolCalls)) continue;
    for (const tc of round.toolCalls) {
      if (!isObj(tc) || typeof tc.id !== 'string') continue;
      map.set(tc.id, parseMaybe(tc.arguments));
    }
  }
  return map;
}

function parseMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function pathKey(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

function emitRequest(run: ParsedRun, r: Obj): void {
  const ts = toMs(r.timestamp);
  const text = messageText(r.message);
  if (!r.hiddenFromTranscript && text.trim()) {
    // Requests VS Code sends on its own (isSystemInitiated) are not the user's prompt.
    pushEvent(run, { kind: r.isSystemInitiated ? 'system' : 'user', text, ts });
  }

  const pts = toMs(r.responseTimestamp) ?? ts;
  const mark = run.tally.events;
  const parts = responseParts(r);
  const args = argsById(r);
  // Paths that edit groups cover: tool calls on them do not count the file a second time.
  const edited = new Set<string>();
  for (const p of parts) {
    if (p.kind === 'textEditGroup' || p.kind === 'notebookEditGroup' || (p.kind === 'codeblockUri' && p.isEdit)) {
      const fp = uriToPath(p.uri);
      if (fp) edited.add(pathKey(fp));
    }
  }
  const filesDone = new Set<string>();

  let md = '';
  let think = '';
  const flushMd = () => {
    if (md.trim()) pushEvent(run, { kind: 'assistant', text: md, ts: pts });
    md = '';
  };
  const flushThink = () => {
    if (think.trim()) pushEvent(run, { kind: 'reasoning', text: think, ts: pts });
    think = '';
  };

  for (const p of parts) {
    if (isMarkdown(p) || p.kind === 'markdownContent' || p.kind === 'inlineReference') {
      flushThink();
      md += p.kind === 'inlineReference' ? inlineRefText(p) : p.kind === 'markdownContent' ? mdValue(p.content) : str(p.value);
      continue;
    }
    if (p.kind === 'thinking') {
      flushMd();
      think += Array.isArray(p.value) ? p.value.map(mdValue).join('') : mdValue(p.value);
      continue;
    }
    flushMd();
    flushThink();
    switch (p.kind) {
      case 'toolInvocationSerialized':
        emitTool(run, p, args, edited, pts);
        break;
      case 'textEditGroup':
      case 'notebookEditGroup':
      case 'codeblockUri': {
        if (p.kind === 'codeblockUri' && !p.isEdit) break;
        const fp = uriToPath(p.uri);
        if (!fp || filesDone.has(pathKey(fp))) break;
        filesDone.add(pathKey(fp));
        pushEvent(run, { kind: 'file_change', text: `Edited ${fp}`, filePath: fp, fileOp: 'edit', ts: pts });
        // Edit groups hold the new text but not the text it replaced: line counts unknown.
        pushChange(run, { ts: pts, filePath: fp, op: 'edit' });
        break;
      }
      case 'progressMessage':
      case 'warning':
      case 'progressTaskSerialized':
        pushEvent(run, { kind: 'system', text: cleanLinks(mdValue(p.content)) || String(p.kind), ts: pts });
        break;
      case 'confirmation':
      case 'elicitation':
      case 'elicitationSerialized':
        pushEvent(run, { kind: 'system', text: [mdValue(p.title), mdValue(p.message)].filter(Boolean).join(': ') || String(p.kind), ts: pts });
        break;
      default:
        if (!QUIET_PARTS.has(String(p.kind))) run.skipped++;
    }
  }
  flushMd();
  flushThink();

  const res = isObj(r.result) ? r.result : undefined;
  const ed = res && isObj(res.errorDetails) ? res.errorDetails : undefined;
  const ms = isObj(r.modelState) ? r.modelState : undefined;
  const doneAt = ms && (res || ms.value === 1 || ms.value === 3) ? toMs(ms.completedAt) : undefined;
  if (ed && ed.code !== 'canceled') {
    pushEvent(run, { kind: 'error', text: str(ed.message) || 'The request failed', isError: true, ts: doneAt ?? pts });
  } else if (ed) {
    pushEvent(run, { kind: 'system', text: 'Cancelled', ts: doneAt ?? pts });
  }
  if (doneAt && (!run.lastEventAt || doneAt > run.lastEventAt)) run.lastEventAt = doneAt;
  // Usage per request: promptTokens is the whole prompt (no cache split is recorded).
  addUsageSince(run, mark, { input: tokenCount(r.promptTokens), output: tokenCount(r.completionTokens) }, pts);
}

function inlineRefText(p: Obj): string {
  if (typeof p.name === 'string' && p.name) return p.name;
  const ref = p.inlineReference;
  const fp = uriToPath(isObj(ref) && ref.uri ? ref.uri : ref);
  return fp ? baseName(fp) : '';
}

function terminalInfo(p: Obj): { command?: string; exitCode?: number; duration?: number } {
  const t = isObj(p.toolSpecificData) && p.toolSpecificData.kind === 'terminal' ? p.toolSpecificData : undefined;
  if (!t) return {};
  const cl = t.commandLine;
  const command = typeof cl === 'string' ? cl : isObj(cl) ? str(cl.userEdited) || str(cl.toolEdited) || str(cl.original) : str(t.command);
  const st = isObj(t.terminalCommandState) ? t.terminalCommandState : undefined;
  return {
    command: command || undefined,
    exitCode: typeof st?.exitCode === 'number' ? st.exitCode : undefined,
    duration: typeof st?.duration === 'number' ? st.duration : undefined,
  };
}

/** One toolInvocationSerialized part holds the call and, once complete, its result. [source] */
function emitTool(run: ParsedRun, p: Obj, args: Map<string, unknown>, edited: Set<string>, ts: number | undefined): void {
  const id = str(p.toolCallId) || undefined;
  const name = str(p.toolId) || 'tool';
  const kind = vscodeToolKind(name);
  const details = isObj(p.resultDetails) ? p.resultDetails : undefined;
  const raw = (id && args.get(id)) ?? (details ? parseMaybe(details.input) : undefined);
  const inv = mdValue(p.invocationMessage);
  const past = mdValue(p.pastTenseMessage);
  const term = terminalInfo(p);
  const input = raw !== undefined && raw !== '' ? toolInputSummary(raw) : term.command ?? cleanLinks(inv || past);
  const fp = toolFilePath(raw) ?? firstLinkedPath(inv) ?? firstLinkedPath(past);
  const fileOp: FileOp | undefined = kind === 'edit' ? (/create/i.test(name) ? 'create' : 'edit') : undefined;
  // An edit tool counts its file only when no edit group in this request already does.
  const countFile = kind !== 'edit' || (fp && !edited.has(pathKey(fp)));
  pushEvent(run, {
    kind: 'tool_call',
    text: input || name,
    toolName: name,
    toolCallId: id,
    toolKind: kind,
    filePath: fp && countFile ? fp : undefined,
    fileOp: fp && countFile ? fileOp : undefined,
    ts,
  });
  if (!isComplete(p)) return;
  const err = p.resultError;
  const isError = !!err || details?.isError === true;
  let text = typeof err === 'string' ? err : isObj(err) ? str(err.message) : '';
  if (!text) text = outputText(details) || cleanLinks(past) || 'Done';
  // A non-zero exit code is not a tool failure; say so in the text only. [source]
  if (term.exitCode !== undefined && term.exitCode !== 0) text += `\n(exit code ${term.exitCode})`;
  pushEvent(run, { kind: 'tool_result', text, toolName: name, toolCallId: id, toolKind: kind, isError, durationMs: term.duration, ts });
  if (kind === 'edit' && fp && countFile && !isError) {
    const d = toolEdit(raw);
    pushChange(run, { ts, filePath: fp, op: fileOp, diff: d?.diff, linesAdded: d?.added, linesRemoved: d?.removed, toolCallId: id });
  }
}

/** What an edit tool's arguments say it changed: replace_string_in_file and create_file. [source] */
function toolEdit(raw: unknown): DiffText | undefined {
  if (!isObj(raw)) return undefined;
  if (typeof raw.oldString === 'string' && typeof raw.newString === 'string') return diffTexts(raw.oldString, raw.newString);
  if (typeof raw.content === 'string') return newFileDiff(raw.content);
  return undefined;
}

/**
 * VS Code 1.143 always writes isComplete:true; a tool that is still streaming, waiting for
 * approval or executing is marked by summary:{kind:"incomplete"} instead. [source: toJSON of the
 * live tool invocation] Older builds wrote isComplete:false.
 */
function isComplete(p: Obj): boolean {
  if (isObj(p.summary) && p.summary.kind === 'incomplete') return false;
  return p.isComplete !== false || p.resultError !== undefined || isObj(p.resultDetails);
}

function outputText(details: Obj | undefined): string {
  if (!details) return '';
  const out = details.output;
  if (Array.isArray(out)) {
    return out
      .map((o) => (isObj(o) ? (o.isText !== false && typeof o.value === 'string' ? o.value : `[${str(o.mimeType) || 'data'}]`) : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (isObj(out)) return `[${str(out.mimeType) || 'data'}]`;
  return '';
}

/**
 * modelState.value: 0 pending, 1 complete, 2 cancelled, 3 failed, 4 needs input [source].
 * VS Code writes 0 and 4 to disk as 2 with no result, so "2 and no result" means in flight,
 * waiting for approval, or VS Code closed mid-turn: an open tool keeps it running, a tool with no
 * confirmation yet reads as waiting (plausible), anything else is 'unknown' (live for 2 minutes).
 */
function judgeTurn(run: ParsedRun, last: Obj | undefined): void {
  if (!last) {
    run.turn = 'completed';
    return;
  }
  const res = isObj(last.result) ? last.result : undefined;
  const ed = res && isObj(res.errorDetails) ? res.errorDetails : undefined;
  const v = isObj(last.modelState) ? last.modelState.value : undefined;
  if ((ed && ed.code !== 'canceled') || v === 3) {
    run.turn = 'error';
    run.turnDetail = (ed && str(ed.message)) || 'The request failed';
  } else if (v === 1 || (res && v === undefined && !ed && last.isCanceled !== true)) {
    run.turn = 'completed';
  } else if (ed || (v === 2 && res) || (v === undefined && last.isCanceled === true)) {
    // isCanceled: snapshots from before modelState existed.
    run.turn = 'aborted';
    run.turnDetail = 'Cancelled';
  } else if (v === 4) {
    run.turn = 'waiting_input';
    run.turnDetail = 'Waiting for your input';
  } else {
    const open = responseParts(last).filter((p) => p.kind === 'toolInvocationSerialized' && !isComplete(p)).at(-1);
    const since = toMs(last.responseTimestamp) ?? toMs(last.timestamp) ?? run.lastEventAt ?? 0;
    if (open && open.isConfirmed == null) {
      run.turn = 'waiting_input';
      run.turnDetail = 'Waiting for tool approval';
    } else if (open) {
      run.turn = 'in_progress';
      const name = str(open.toolId) || 'tool';
      run.openTool = { name, kind: vscodeToolKind(name), since };
    } else {
      run.turn = v === 0 ? 'in_progress' : 'unknown';
    }
  }
}
