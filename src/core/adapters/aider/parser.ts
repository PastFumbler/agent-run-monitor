// A line-at-a-time parser for one session of .aider.chat.history.md. Its state is plain data so an
// incremental parse can resume where the last one stopped (see index.ts).
//
// Format facts (aider/io.py, verified against the source, not a live install):
// - "# aider chat started at <local time>" opens a session. There is no end marker.
// - "#### " lines are user input. A blank line comes before each input block.
// - "> " lines are tool output, warnings, errors and answered approvals, each ending in a Markdown
//   hard break ("  "). tool_output() with embedded newlines prefixes only the first line; the rest
//   are raw and the hard break lands on the last line, so "> " lines WITHOUT the hard break are
//   continued (the "Cost:" line, the failed SEARCH/REPLACE report).
// - Anything else after a blank line is assistant Markdown (ai_output), which may itself contain
//   blank lines, headings, quotes and fences. It ends at a blank line followed by a hard-broken
//   "> " or "#### " line outside a fence.
// - No per-message timestamps exist, so every event gets the session start time.

import type { FileOp } from '@shared/schema';
import { ev, type ParsedRun, type TurnState } from '../../adapter';
import { pushEvent, type NewEvent } from '../../events';
import { extractEdits } from './edits';
import {
  ADDED_OUTPUT,
  APPLIED,
  ARGV_AIDER,
  ARGV_MODEL,
  COMMIT,
  CONFIRM_FULL,
  CONFIRM_OLD,
  CTRL_C_EXIT,
  CTRL_C_ONCE,
  DID_NOT_APPLY,
  EDIT_ERRORS,
  FENCE_CLOSE,
  FENCE_OPEN,
  GIT_DIR,
  HEADER,
  headerTime,
  MODEL,
  OTHER_ERRORS,
  REASONING,
  REFLECTING_CONFIRMS,
  RETRY,
  RUNNING,
  SHELL_OUTPUT_CONFIRM,
  tokenCount,
  TOKENS,
  TOOL,
  TURN_ERRORS,
  USER,
  VERSION,
} from './patterns';

const MAX_BLOCK_LINES = 20_000;

interface PendingEdit {
  id: string;
  path: string;
  op: FileOp;
}

/** Everything the parser carries between lines. Plain data only (stored in ParseState.extra). */
export interface ParserState {
  /** Byte offset of the session header; prefix for synthetic tool-call ids. */
  start: number;
  headerSeen: boolean;
  /** A later session header was reached: this session is over. */
  ended: boolean;
  startedAt?: number;
  /** The block being collected: user lines, assistant lines or one tool message. */
  mode: 'none' | 'user' | 'asst' | 'tool';
  buf: string[];
  prevBlank: boolean;
  fence?: string;
  /** The pending tool message has no hard break yet, so raw lines (even blank ones) continue it. */
  toolOpen: boolean;
  /** Whether this session's "> " lines carry hard breaks (undefined until the first one). */
  hardBreaks?: boolean;
  toolLines: number;
  editFormat?: string;
  argvModel?: string;
  calls: number;
  pendingEdits: PendingEdit[];
  shell?: { id: string; cmd: string };
  /** Unclassified "> " lines (approval subjects such as a path or command) not yet emitted. */
  subjects: string[];
  lastAssistant?: string;
  handoff: boolean;
  /** The last input was a local command (/ls, /tokens, !cmd): its output is not an approval subject. */
  afterCommand: boolean;
  awaitingReply: boolean;
  interrupted: boolean;
  errorFinal: boolean;
  lastError?: string;
  exited?: 'exit' | 'ctrl-c';
  recognised: number;
}

export function newParserState(start: number): ParserState {
  return {
    start,
    headerSeen: false,
    ended: false,
    mode: 'none',
    buf: [],
    prevBlank: true,
    toolOpen: false,
    toolLines: 0,
    calls: 0,
    pendingEdits: [],
    subjects: [],
    handoff: false,
    afterCommand: false,
    awaitingReply: false,
    interrupted: false,
    errorFinal: false,
    recognised: 0,
  };
}

const endsHard = (raw: string) => / {2}$/.test(raw);
const isBlank = (raw: string) => raw.trim() === '';
const samePath = (a: string, b: string) => a.replace(/\\/g, '/') === b.replace(/\\/g, '/');

export interface FinishInfo {
  /** The file's mtime, used as the start of a tool still open at the end of the live session. */
  fileMtime: number;
  /** Treat a pending approval as abandoned (the file has been quiet for a long time). */
  stale: boolean;
}

export class SessionParser {
  constructor(
    private run: ParsedRun,
    readonly s: ParserState,
  ) {}

  /** Feeds one line (no line ending). Returns false once the next session's header is reached. */
  feed(raw: string): boolean {
    const s = this.s;
    if (!s.headerSeen) {
      if (HEADER.test(raw)) {
        s.headerSeen = true;
        s.startedAt = headerTime(raw);
        if (s.startedAt) this.run.startedAt = s.startedAt;
        s.recognised++;
      } else if (!isBlank(raw)) this.run.skipped++;
      return true;
    }
    if (HEADER.test(raw)) {
      s.ended = true;
      return false;
    }
    // Aider writes with errors="ignore", so NULs only come from damage: drop and count the line.
    if (raw.includes('\u0000')) {
      this.run.skipped++;
      return true;
    }
    this.line(raw);
    s.prevBlank = isBlank(raw);
    return true;
  }

  private line(raw: string): void {
    const s = this.s;
    if (s.mode === 'tool') {
      if (this.continuesTool(raw)) {
        s.buf.push(raw.trimEnd());
        if (s.toolOpen && endsHard(raw)) s.toolOpen = false;
        return;
      }
      this.flushTool();
    } else if (s.mode === 'asst') {
      const boundary = s.prevBlank && (s.fence === undefined ? this.isBoundary(raw) : this.isFencedBoundary(raw));
      if (!boundary) {
        if (s.buf.length >= MAX_BLOCK_LINES) {
          // A runaway block: keep memory bounded by emitting it in pieces.
          const fence = s.fence;
          this.flushAssistant();
          s.mode = 'asst';
          s.fence = fence;
        }
        this.trackFence(raw);
        s.buf.push(raw);
        return;
      }
      this.flushAssistant();
    } else if (s.mode === 'user') {
      const m = USER.exec(raw);
      if (m) {
        s.buf.push((m[1] ?? '').trimEnd());
        return;
      }
      this.flushUser();
    }
    this.startBlock(raw);
  }

  private continuesTool(raw: string): boolean {
    const s = this.s;
    if (s.buf.length >= MAX_BLOCK_LINES) return false;
    if (TOOL.test(raw) || USER.test(raw)) return false;
    // A message without its hard break yet runs on, blank lines included.
    if (s.toolOpen) return true;
    // Padded multi-line subjects (confirm_ask) can put the hard break early: raw lines that follow
    // directly still belong to the message.
    return !isBlank(raw);
  }

  private isBoundary(raw: string): boolean {
    const hard = this.s.hardBreaks !== false;
    const t = TOOL.exec(raw);
    if (t) return !hard || endsHard(raw) || /^(Tokens:|# \d+ SEARCH\/REPLACE)/.test(t[1] ?? '');
    return USER.test(raw) && (!hard || endsHard(raw));
  }

  /**
   * A reply cut short (Ctrl-C, token limit) can leave a code fence open. Aider's own next record
   * still ends it: a hard-broken "#### " line, or a "> " line Aider is known to write.
   */
  private isFencedBoundary(raw: string): boolean {
    const hard = this.s.hardBreaks !== false;
    if (USER.test(raw)) return hard && endsHard(raw);
    const t = TOOL.exec(raw);
    if (!t || (hard && !endsHard(raw) && !/^Tokens:/.test(t[1] ?? ''))) return false;
    return isAiderLine((t[1] ?? '').trim());
  }

  private trackFence(raw: string): void {
    const s = this.s;
    if (s.fence === undefined) {
      const m = FENCE_OPEN.exec(raw);
      if (m) s.fence = m[1];
    } else {
      const m = FENCE_CLOSE.exec(raw);
      if (m && m[1][0] === s.fence[0] && m[1].length >= s.fence.length) s.fence = undefined;
    }
  }

  private startBlock(raw: string): void {
    const s = this.s;
    s.mode = 'none';
    s.buf = [];
    if (isBlank(raw)) return;
    const u = USER.exec(raw);
    if (u) {
      s.mode = 'user';
      s.buf = [(u[1] ?? '').trimEnd()];
      return;
    }
    const t = TOOL.exec(raw);
    if (t) {
      if (s.hardBreaks === undefined) s.hardBreaks = endsHard(raw);
      s.mode = 'tool';
      s.buf = [(t[1] ?? '').trim()];
      s.toolOpen = s.hardBreaks && !endsHard(raw);
      return;
    }
    s.mode = 'asst';
    s.fence = undefined;
    s.buf = [raw];
    this.trackFence(raw);
  }

  /** Flushes whatever block is pending. */
  flush(): void {
    if (this.s.mode === 'tool') this.flushTool();
    else if (this.s.mode === 'asst') this.flushAssistant();
    else if (this.s.mode === 'user') this.flushUser();
    this.s.mode = 'none';
    this.s.buf = [];
  }

  // ---- events -------------------------------------------------------------------------------

  private push(e: NewEvent): void {
    pushEvent(this.run, { ...e, ts: this.s.startedAt });
  }

  private nextId(): string {
    return `${this.s.start}:${++this.s.calls}`;
  }

  private emitSubjects(): void {
    for (const t of this.s.subjects) this.push(ev('system', t));
    this.s.subjects = [];
  }

  private closeShell(text: string): void {
    const sh = this.s.shell;
    if (!sh) return;
    this.push(ev('tool_result', text, { toolName: 'shell', toolKind: 'run', toolCallId: sh.id }));
    this.s.shell = undefined;
  }

  private openShell(cmd: string): void {
    this.closeShell('Finished (Aider does not record command output in the chat log)');
    const id = this.nextId();
    this.s.shell = { id, cmd };
    this.push(ev('tool_call', cmd, { toolName: 'shell', toolKind: 'run', toolCallId: id }));
  }

  private takeEdit(path: string): PendingEdit | undefined {
    const i = this.s.pendingEdits.findIndex((p) => samePath(p.path, path));
    return i >= 0 ? this.s.pendingEdits.splice(i, 1)[0] : undefined;
  }

  // ---- user input ---------------------------------------------------------------------------

  private flushUser(): void {
    const s = this.s;
    const text = s.buf.join('\n').trim();
    s.mode = 'none';
    s.buf = [];
    s.recognised++;
    this.emitSubjects();
    this.closeShell('Finished (Aider does not record command output in the chat log)');
    s.pendingEdits = [];
    if (!text || text === '<blank>') return;

    // A remembered "(A)ll" answer is logged as user input (confirm_ask with group preference).
    const c = !text.includes('\n') ? CONFIRM_FULL.exec(text) : null;
    if (c) return this.confirm(c[1], c[2], '');

    if (s.handoff) {
      // Architect mode: the plan is re-sent to the editor model and logged again as "#### ".
      s.handoff = false;
      s.awaitingReply = true;
      this.push(ev('system', `Plan handed to the editor model\n\n${text}`));
      return;
    }
    s.interrupted = false;
    s.errorFinal = false;
    // Output of a local command (/ls, /tokens, /help...) is not an approval subject.
    s.afterCommand = true;
    if (text.startsWith('!')) {
      this.openShell(text.slice(1).trim());
      return;
    }
    const cmd = /^\/(\w[\w-]*)\s*([\s\S]*)$/.exec(text);
    if (!cmd) {
      s.afterCommand = false;
      s.awaitingReply = true;
      this.push(ev('user', text));
      return;
    }
    const [, name, args] = cmd;
    if (/^(run)$/i.test(name) && args) return this.openShell(args.trim());
    if (/^(exit|quit)$/i.test(name)) s.exited = 'exit';
    // Mode commands with a message send it to the model, so they read as a real prompt.
    if (/^(ask|code|architect|context|help)$/i.test(name) && args.trim()) {
      s.afterCommand = false;
      s.awaitingReply = true;
      this.push(ev('user', args.trim()));
      return;
    }
    this.push(ev('system', text));
  }

  // ---- assistant reply ----------------------------------------------------------------------

  private flushAssistant(): void {
    const s = this.s;
    let text = s.buf.join('\n').trim();
    s.mode = 'none';
    s.buf = [];
    s.fence = undefined;
    if (!text) return;
    s.recognised++;
    this.emitSubjects();
    this.closeShell('Finished (Aider does not record command output in the chat log)');
    s.awaitingReply = false;
    s.errorFinal = false;
    s.afterCommand = false;
    const r = REASONING.exec(text);
    if (r) {
      if (r[2].trim()) this.push(ev('reasoning', r[2].trim()));
      text = text.slice(r[0].length).trim();
    }
    if (!text) return;
    this.push(ev('assistant', text));
    s.lastAssistant = text;
    for (const e of extractEdits(text, s.editFormat)) {
      const id = this.nextId();
      s.pendingEdits.push({ id, path: e.path, op: e.op });
      const label = e.blocks > 1 ? `${e.path} (${e.blocks} blocks)` : e.path;
      this.push(ev('tool_call', label, { toolName: 'edit', toolKind: 'edit', toolCallId: id }));
    }
  }

  // ---- tool output --------------------------------------------------------------------------

  private flushTool(): void {
    const s = this.s;
    const [first = '', ...rest] = s.buf;
    const full = [first, ...rest.map((l) => l.trimEnd())].join('\n').trim();
    s.mode = 'none';
    s.buf = [];
    s.toolOpen = false;
    s.toolLines++;
    s.recognised++;
    if (!first) return; // ">  " padding (Ctrl-C writes two of them)
    this.tool(first, full);
  }

  private tool(t: string, full: string): void {
    const s = this.s;
    const c = CONFIRM_FULL.exec(t) ?? CONFIRM_OLD.exec(t);
    if (c && !rest(full)) return this.confirm(c[1], c[2], s.subjects.join('\n'));

    // The first line of a session is the launch command (main.py logs sys.argv).
    if (s.toolLines === 1 && ARGV_AIDER.test(t) && !VERSION.test(t)) {
      const m = ARGV_MODEL.exec(t);
      if (m) s.argvModel = m[1];
      this.push(ev('system', `Started: ${full}`));
      return;
    }
    if (!this.known(t, full)) {
      // Unclassified lines are often the subject of the approval prompt that follows.
      if (!s.afterCommand && looksLikeSubject(full)) s.subjects.push(full);
      else {
        this.emitSubjects();
        this.push(ev('system', full));
      }
    }
  }

  /** Handles a recognised tool line; false when the line is not one we know. */
  private known(t: string, full: string): boolean {
    const s = this.s;
    let m: RegExpExecArray | null;
    const sys = (text = full) => {
      this.emitSubjects();
      this.push(ev('system', text));
    };
    if ((m = TOKENS.exec(t))) {
      this.run.inputTokens = (this.run.inputTokens ?? 0) + tokenCount(m[1]);
      this.run.outputTokens = (this.run.outputTokens ?? 0) + tokenCount(m[4]);
      sys();
    } else if (VERSION.test(t)) sys();
    else if ((m = MODEL.exec(t))) {
      this.run.model = m[1];
      if (m[2]) s.editFormat = m[2];
      sys();
    } else if ((m = GIT_DIR.exec(t))) {
      this.run.projectPath = m[1].trim();
      sys();
    } else if ((m = APPLIED.exec(t))) {
      this.emitSubjects();
      const path = m[1];
      const call = this.takeEdit(path);
      if (call) this.push(ev('tool_result', full, { toolName: 'edit', toolKind: 'edit', toolCallId: call.id }));
      this.push(ev('file_change', full, { toolName: 'edit', filePath: path, fileOp: call?.op ?? 'edit' }));
    } else if ((m = DID_NOT_APPLY.exec(t))) {
      this.emitSubjects();
      const call = this.takeEdit(m[1]);
      if (call) this.push(ev('tool_result', full, { toolName: 'edit', toolKind: 'edit', toolCallId: call.id }));
      else this.push(ev('system', full));
    } else if (COMMIT.test(t)) sys();
    else if ((m = RUNNING.exec(t))) {
      this.emitSubjects();
      this.openShell(m[1].trim());
    } else if (ADDED_OUTPUT.test(t)) {
      if (s.shell) this.closeShell(full);
      else sys();
    } else if (RETRY.test(t)) {
      s.errorFinal = false;
      s.awaitingReply = true;
      sys();
    } else if (CTRL_C_ONCE.test(t)) {
      s.interrupted = true;
      s.awaitingReply = false;
      this.closeShell('Interrupted');
      sys('Interrupted (Ctrl-C)');
    } else if (CTRL_C_EXIT.test(t)) {
      s.interrupted = true;
      s.exited = 'ctrl-c';
      this.closeShell('Interrupted');
      sys('Closed with Ctrl-C');
    } else if (TURN_ERRORS.some((r) => r.test(t))) {
      this.error(full);
      s.errorFinal = true;
      s.awaitingReply = false;
      s.lastError = full;
    } else if (EDIT_ERRORS.some((r) => r.test(t))) {
      this.error(full);
      // Unapplied edits fail together; Aider sends the error back to the model.
      for (const p of s.pendingEdits)
        this.push(ev('tool_result', full, { toolName: 'edit', toolKind: 'edit', toolCallId: p.id, isError: true }));
      s.pendingEdits = [];
      s.awaitingReply = true;
    } else if (OTHER_ERRORS.some((r) => r.test(t))) this.error(full);
    else return false;
    return true;
  }

  private error(text: string): void {
    this.emitSubjects();
    this.push(ev('error', text, { isError: true }));
  }

  private confirm(question: string, answer: string, subject: string): void {
    const s = this.s;
    s.subjects = [];
    const yes = /^(y|yes|a|all)$/i.test(answer);
    this.push(ev('system', `${question} ${answer}${subject ? `\n${subject}` : ''}`));
    if (SHELL_OUTPUT_CONFIRM.test(question)) {
      this.closeShell(`Finished; output ${yes ? 'added to the chat' : 'not added'} (Aider does not record it in the log)`);
      return;
    }
    if (/^(Create new file|Allow edits to)/i.test(question) && !yes) {
      const call = subject ? this.takeEdit(subject.trim()) : undefined;
      if (call) this.push(ev('tool_result', 'Declined', { toolName: 'edit', toolKind: 'edit', toolCallId: call.id }));
    }
    if (yes && /^Edit the files\?/i.test(question)) s.handoff = true;
    if (yes && REFLECTING_CONFIRMS.test(question)) s.awaitingReply = true;
  }

  // ---- end of input -------------------------------------------------------------------------

  /**
   * Flushes the pending block and works out the turn. `live` is false when a later session
   * started in the same file (so this one is certainly over).
   */
  finish(info: FinishInfo): void {
    this.flush();
    const s = this.s;
    const run = this.run;
    const waitingOn = s.subjects.join('\n');
    this.emitSubjects();
    if (!run.model && s.argvModel) run.model = s.argvModel;
    run.openTool = undefined;
    run.turnDetail = undefined;
    const set = (turn: TurnState, detail?: string) => {
      run.turn = turn;
      run.turnDetail = detail;
    };
    if (!s.headerSeen) return set('unknown');
    if (s.exited === 'exit') return set('completed');
    if (s.exited === 'ctrl-c') return set('aborted', 'Closed with Ctrl-C');
    if (s.errorFinal) return set('error', s.lastError?.split('\n').pop() || 'Aider reported an error');
    if (s.ended) {
      if (s.interrupted) return set('aborted', 'Interrupted');
      if (s.awaitingReply) return set('aborted', 'Ended before the reply arrived');
      return set('completed');
    }
    if (waitingOn) {
      if (info.stale) return set('aborted', 'Closed at an approval prompt');
      return set('waiting_input', `Waiting for approval: ${waitingOn.split('\n')[0]}`);
    }
    if (s.shell) {
      set('in_progress');
      run.openTool = { name: 'shell', kind: 'run', since: info.fileMtime };
      return;
    }
    // Proposed edits with no "Applied edit" yet are not a running tool: Aider applies them within
    // milliseconds of writing the reply, so leftovers were never going to be applied (ask-style
    // replies, examples in prose). An approval for them shows up as a subject above.
    if (s.awaitingReply) return set('in_progress', 'Waiting for the model');
    if (s.interrupted) return set('aborted', 'Interrupted');
    set('completed');
  }
}

/**
 * Whether an unclassified line could be an approval subject (a path, URL or command, written just
 * before the prompt). Status lines such as "Repo-map: using 4096 tokens" or sentences are not.
 */
function looksLikeSubject(full: string): boolean {
  // confirm_ask writes a multi-line subject (several shell commands) as one message.
  const lines = full.split('\n').map((l) => l.trim());
  return lines.length <= 50 && lines.every(subjectLine);
}

function subjectLine(t: string): boolean {
  if (!t || t.length >= 300 || /[!:]$/.test(t)) return false;
  // A sentence ("Scanning repo files..."), but not a command such as "git add .".
  if (/\.$/.test(t) && /^[A-Z]/.test(t)) return false;
  if (/^[A-Z][\w ()/-]*: /.test(t)) return false;
  return !/^(Added|Removed|Dropped|Moved) .* (to|from) the chat/.test(t);
}

/** Lines Aider itself writes that can follow a reply, used to end a reply with an open fence. */
function isAiderLine(t: string): boolean {
  return (
    TOKENS.test(t) ||
    CTRL_C_ONCE.test(t) ||
    CTRL_C_EXIT.test(t) ||
    APPLIED.test(t) ||
    DID_NOT_APPLY.test(t) ||
    RETRY.test(t) ||
    CONFIRM_FULL.test(t) ||
    TURN_ERRORS.some((r) => r.test(t)) ||
    EDIT_ERRORS.some((r) => r.test(t))
  );
}

/** True when a tool message has text past its first line. */
function rest(full: string): boolean {
  return full.includes('\n');
}
