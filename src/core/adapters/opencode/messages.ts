// Run building for OpenCode 1.x messages and parts, shared by the JSON-file layout (G1, <= 1.1.x)
// and the V1 SQLite tables `message` / `part` (G2, 1.2 - 1.19), whose `data` columns hold the same
// objects minus their ids. [SRC sst/opencode v1.1.65 session/message-v2.ts, v1.19.4 core/src/session/sql.ts]
//
// Message: user {role, time{created}, agent, model{providerID, modelID}} or assistant {role, modelID,
// providerID, path{cwd, root}, tokens, cost, finish?, error?, time{created, completed?}}.
// Parts: text, reasoning, tool {callID, tool, state{status, input, output | error, metadata, time}},
// patch {files[]}, step-start, step-finish, snapshot, file, agent, subtask, compaction, retry.
// The live session status (busy | idle | retry) is in memory only, so the turn is inferred from
// the last message [INFERRED-SRC].

import type { FileOp, ParsedRun, TurnState } from '../../adapter';
import { isObj, pushEvent, toMs } from '../../events';
import { NO_RECORDS, addTokens, emitStepFiles, emitTool, errorInfo, modelName, newBuilder, num, opOf, settle, str, type Builder, type ToolInfo } from './common';
import { resolveIn } from './paths';

export interface V1Session {
  title?: string;
  directory?: string;
  projectName?: string;
  model?: string;
  created?: number;
  updated?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface V1Message {
  info: Record<string, unknown>;
  parts: Record<string, unknown>[];
  /** Newest write time of the message or its parts, when the store records it (G2 columns). */
  updated?: number;
}

export function buildV1Run(session: V1Session, messages: V1Message[], unreadable = 0): ParsedRun {
  const b = newBuilder(session.directory, session.projectName, session.title);
  const run = b.run;
  run.model = session.model;
  run.skipped += unreadable;
  if (session.inputTokens || session.outputTokens) {
    run.inputTokens = session.inputTokens ?? 0;
    run.outputTokens = session.outputTokens ?? 0;
  }
  let lastAt = session.updated ?? 0;
  let last: Record<string, unknown> | undefined;
  for (const m of messages) {
    lastAt = Math.max(lastAt, m.updated ?? 0);
    const role = m.info.role;
    if (role === 'user') userMessage(b, m);
    else if (role === 'assistant') assistantMessage(b, m);
    else {
      run.skipped++;
      continue;
    }
    b.recognised++;
    last = m.info;
  }
  const { turn, detail } = turnOf(last);
  settle(b, turn, detail, turn === 'in_progress' || turn === 'unknown');
  if (messages.length + unreadable > 0 && !b.recognised) run.readError = NO_RECORDS;
  if (session.created && (!run.startedAt || session.created < run.startedAt)) run.startedAt = session.created;
  if (lastAt && (!run.lastEventAt || lastAt > run.lastEventAt)) run.lastEventAt = lastAt;
  return run;
}

function turnOf(last: Record<string, unknown> | undefined): { turn: TurnState; detail?: string } {
  if (!last) return { turn: 'unknown' };
  if (last.role === 'user') return { turn: 'in_progress' };
  const time = isObj(last.time) ? last.time : {};
  const err = errorInfo(last.error);
  if (err) return err.aborted ? { turn: 'aborted', detail: 'Interrupted' } : { turn: 'error', detail: err.text };
  if (time.completed == null) return { turn: 'in_progress' };
  if (last.finish === 'error') return { turn: 'error', detail: 'The model stopped with an error' };
  // The 1.x prompt loop starts another step after 'tool-calls' and 'unknown' and stops on any other
  // finish (stop, length, content-filter, other) [INFERRED-SRC session/prompt.ts]. Older builds may
  // not record `finish` at all; a completed message without one ended its turn.
  if (last.finish === 'tool-calls' || last.finish === 'unknown') return { turn: 'in_progress' };
  return { turn: 'completed' };
}

function userMessage(b: Builder, m: V1Message): void {
  const time = isObj(m.info.time) ? m.info.time : {};
  const ts = toMs(time.created);
  const texts: string[] = [];
  b.open.clear(); // a new prompt: anything left open earlier was never answered
  for (const p of m.parts) {
    if (p.type === 'text') {
      if (!str(p.text)) continue;
      // Synthetic text is injected by OpenCode itself (file contents, reminders), not typed by the user.
      if (p.synthetic) pushEvent(b.run, { kind: 'system', text: p.text as string, ts });
      else texts.push(p.text as string);
    } else if (p.type === 'file') {
      pushEvent(b.run, { kind: 'system', text: `Attached ${str(p.filename) ?? str(p.url) ?? 'a file'}`, ts });
    } else if (p.type === 'agent' || p.type === 'subtask' || p.type === 'compaction') {
      pushEvent(b.run, { kind: 'system', text: `${p.type}: ${str(p.name) ?? str(p.description) ?? str(p.agent) ?? ''}`.trim(), ts });
    } else b.run.skipped++;
  }
  if (texts.length) pushEvent(b.run, { kind: 'user', text: texts.join('\n'), ts });
  if (isObj(m.info.model)) b.run.model = modelName(m.info.model) ?? b.run.model;
}

function assistantMessage(b: Builder, m: V1Message): void {
  const run = b.run;
  const info = m.info;
  const time = isObj(info.time) ? info.time : {};
  const ts = toMs(time.created);
  const path = isObj(info.path) ? info.path : {};
  // The message's cwd is the session folder when the session row did not give one.
  if (!run.projectPath && str(path.cwd)) {
    run.projectPath = path.cwd as string;
    b.dir = run.projectPath;
  }
  run.model = str(info.modelID) ?? run.model;
  // Usage: each step-finish part carries its own step's tokens, while the message's tokens may hold
  // only the last step's [INFERRED-SRC session/processor.ts], so sum the steps when they are there.
  const steps = m.parts.filter((p) => p.type === 'step-finish' && isObj(p.tokens));
  if (steps.length) for (const p of steps) addTokens(b, p.tokens);
  else addTokens(b, info.tokens);
  b.open.clear(); // tools of an earlier step still open were cut off
  const touched = new Set<string>();
  for (const p of m.parts) {
    const pts = isObj(p.time) ? toMs(p.time.start) : undefined;
    switch (p.type) {
      case 'text':
        if (str(p.text)) pushEvent(run, { kind: 'assistant', text: p.text as string, ts: pts ?? ts });
        break;
      case 'reasoning':
        if (str(p.text)) pushEvent(run, { kind: 'reasoning', text: p.text as string, ts: pts ?? ts });
        break;
      case 'tool':
        emitTool(b, v1Tool(b, p), ts, touched);
        break;
      case 'patch':
        emitStepFiles(b, p.files, toMs(time.completed) ?? ts, touched);
        break;
      case 'retry': {
        const e = errorInfo(p.error);
        pushEvent(run, { kind: 'system', text: `Retrying (attempt ${num(p.attempt) ?? '?'})${e ? `: ${e.text}` : ''}`, ts });
        break;
      }
      case 'agent':
      case 'subtask':
      case 'compaction':
      case 'file':
        pushEvent(run, { kind: 'system', text: `${p.type}: ${str(p.name) ?? str(p.description) ?? str(p.filename) ?? ''}`.trim(), ts });
        break;
      case 'step-start':
      case 'step-finish':
      case 'snapshot':
        break; // bookkeeping: snapshots and per-step usage (the message carries the totals)
      default:
        run.skipped++;
    }
  }
  const err = errorInfo(info.error);
  if (err) {
    const ets = toMs(time.completed) ?? ts;
    pushEvent(run, err.aborted ? { kind: 'system', text: 'Interrupted', ts: ets } : { kind: 'error', text: err.text, isError: true, ts: ets });
  }
}

/** G1/G2 tool part: state.status pending | running | completed | error; input.filePath is absolute. */
function v1Tool(b: Builder, p: Record<string, unknown>): ToolInfo {
  const st = isObj(p.state) ? p.state : {};
  const time = isObj(st.time) ? st.time : {};
  const meta = isObj(st.metadata) ? st.metadata : {};
  const name = str(p.tool) ?? 'tool';
  const files: { path: string; op: FileOp; text: string }[] = [];
  const fd = isObj(meta.filediff) ? meta.filediff : undefined;
  if (fd && str(fd.file)) {
    const op: FileOp = fd.before === '' ? 'create' : fd.after === '' && fd.status === 'deleted' ? 'delete' : opOf(fd.status);
    files.push({ path: resolveIn(b.dir, fd.file as string), op, text: str(meta.diff) ?? '' });
  }
  // The write tool is believed to record metadata.exists (whether the file was there before) [UNVERIFIED].
  const op: FileOp | undefined = name === 'write' ? (meta.exists === false ? 'create' : 'edit') : undefined;
  return {
    id: str(p.callID),
    name,
    status: str(st.status) ?? 'pending',
    input: st.input ?? {},
    output: str(st.output) ?? '',
    error: str(st.error),
    start: toMs(time.start),
    end: toMs(time.end),
    files,
    op,
  };
}
