// Cursor agent transcripts: ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl (older
// builds: <id>.jsonl directly), sub-agents in <id>/subagents/<agentId>.jsonl. Written by the IDE
// (3.x) and by cursor-agent. Append-only JSONL, read incrementally.
//
// Provenance (research notes; NOT verified against a real installation):
// - Records {role, message:{content:[text | tool_use{name, input}]}} and {type:"turn_ended", status}:
//   several readers agree, one measured 5,246 real lines. tool_use has no id and there are no tool
//   results, timestamps, tokens or model in this format.
// - {type:"error", error} lines and turn_ended.error (cursor-agent 2026.10.22+): single source.
// - <timestamp> tag in user prompts: single source. Slug = sanitised absolute path, lossy.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env, ParseState, SessionRef } from '../../adapter';
import { emptyRun, freshState } from '../../adapter';
import { pushChange } from '../../changes';
import { isObj, pushEvent, textOf } from '../../events';
import { readJsonl } from '../../jsonl';
import {
  cleanPrompt,
  cursorEditDiff,
  cursorFilePath,
  cursorInputSummary,
  cursorToolKind,
  fileOpFor,
  parseTimestampTag,
  projectNameOf,
  stripRedacted,
  workspacePathFrom,
} from './common';
import { NO_RECORDS } from './composer';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// ---------- discovery ----------

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The slug Cursor would build from an absolute path: `/home/alex` -> `home-alex`, `C:\Users\alex` -> `c-Users-alex`. */
export function slugOf(p: string): string {
  const s = p.replace(/^([a-zA-Z]):/, (_, d: string) => d.toLowerCase()).replace(/[:\\/]+/g, '-');
  return s.replace(/^-+|-+$/g, '');
}

/**
 * The slug is lossy (a dash may have been a slash), so only accept a folder when exactly one real
 * folder under home spells it. readdir only; results cached per discover call.
 */
async function resolveSlug(home: string, rest: string, depth = 0): Promise<string[]> {
  if (!rest) return [home];
  if (depth > 12) return [];
  const found: string[] = [];
  for (const e of await entries(home)) {
    if (!e.isDirectory()) continue;
    if (rest === e.name || rest.startsWith(`${e.name}-`)) {
      found.push(...(await resolveSlug(join(home, e.name), rest.slice(e.name.length + 1), depth + 1)));
      if (found.length > 1) break;
    }
  }
  return found;
}

async function projectFromSlug(slug: string, env: Env, cache: Map<string, Record<string, string>>): Promise<Record<string, string>> {
  const hit = cache.get(slug);
  if (hit) return hit;
  const homeSlug = slugOf(env.home);
  let out: Record<string, string> = { project: slug };
  if (homeSlug && slug.toLowerCase().startsWith(`${homeSlug.toLowerCase()}-`)) {
    const rest = slug.slice(homeSlug.length + 1);
    out = { project: rest };
    const found = await resolveSlug(env.home, rest);
    if (found.length === 1) out = { project: projectNameOf(found[0]), projectPath: found[0] };
  }
  cache.set(slug, out);
  return out;
}

export async function discoverTranscripts(root: string, since: number, env: Env, seen: Set<string>): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  const slugCache = new Map<string, Record<string, string>>();
  const add = async (file: string, id: string, hint: Record<string, string>) => {
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) return false;
    if (since > 0 && st.mtimeMs < since) return true; // exists, just too old
    refs.push({ agent: 'cursor', path: file, mtimeMs: st.mtimeMs, size: st.size, hint: { kind: 'transcript', session: id, ...hint } });
    return true;
  };
  for (const p of await entries(join(root, 'projects'))) {
    if (!p.isDirectory()) continue;
    const dir = join(root, 'projects', p.name, 'agent-transcripts');
    const list = await entries(dir);
    if (!list.length) continue;
    const project = await projectFromSlug(p.name, env, slugCache);
    for (const e of list) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const id = e.name.slice(0, -'.jsonl'.length);
        if (!seen.has(id)) await add(join(dir, e.name), id, project);
        continue;
      }
      if (!e.isDirectory()) continue;
      const id = e.name;
      const main = join(dir, id, `${id}.jsonl`);
      // Sessions the Composer store or the CLI store already show (richer data) are skipped.
      const mainListed = !seen.has(id) && (await add(main, id, project));
      if (!seen.has(id)) seen.add(id);
      for (const s of await entries(join(dir, id, 'subagents'))) {
        if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
        const sub = s.name.slice(0, -'.jsonl'.length);
        if (seen.has(sub)) continue;
        await add(join(dir, id, 'subagents', s.name), sub, mainListed ? { ...project, parent: main } : project);
      }
    }
  }
  return refs;
}

// ---------- parsing ----------

interface Extra {
  [k: string]: unknown;
  recognised: number;
  toolSeq: number;
  /** The tool call at the very end of the file, if nothing followed it yet. */
  open: { name: string; since: number } | null;
}

/** Applies one record. Returns false for a record type this adapter does not know. */
function applyRecord(st: ParseState, rec: unknown, mtime: number): boolean {
  const run = st.run;
  const x = st.extra as Extra;
  if (!isObj(rec)) return false;
  const type = str(rec.type);
  if (type === 'turn_ended') {
    x.open = null;
    const status = (str(rec.status) ?? '').toLowerCase();
    const err = rec.error == null ? undefined : textOf(rec.error);
    if (status === 'success' || status === 'completed' || status === 'ok') {
      run.turn = 'completed';
      run.turnDetail = undefined;
    } else if (status === 'error' || status === 'failed') {
      const last = run.events[run.events.length - 1];
      // A {type:"error"} line usually precedes this with the same text: don't count it twice.
      if (err && !(last?.kind === 'error' && last.text === err)) pushEvent(run, { kind: 'error', text: err, isError: true });
      run.turn = 'error';
      run.turnDetail = err ?? 'The turn ended with an error';
    } else if (/abort|cancel|interrupt|stop/.test(status)) {
      run.turn = 'aborted';
      run.turnDetail = 'Stopped by you';
    } else run.turn = 'unknown';
    return true;
  }
  if (type === 'error') {
    x.open = null;
    const text = textOf(rec.error ?? rec.message) || 'Error';
    pushEvent(run, { kind: 'error', text, isError: true });
    run.turn = 'error';
    run.turnDetail = text;
    return true;
  }
  if (type === 'progress') return true; // streaming chunks: known, not shown
  const role = str(rec.role);
  if (role !== 'user' && role !== 'assistant') return false;
  const msg = isObj(rec.message) ? rec.message : {};
  const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
  x.open = null;
  run.turn = 'in_progress';
  run.turnDetail = undefined;
  if (role === 'user') {
    for (const c of content) {
      const raw = str(c.text);
      if (c.type !== 'text' || !raw) continue;
      const wp = workspacePathFrom(raw);
      if (wp && !run.projectPath) {
        run.projectPath = wp;
        run.projectName = projectNameOf(wp);
      }
      const text = cleanPrompt(raw);
      if (text) pushEvent(run, { kind: 'user', text, ts: parseTimestampTag(raw) });
    }
    return true;
  }
  for (const c of content) {
    const t = str(c.type);
    if (t === 'text' && str(c.text)) {
      const text = stripRedacted(c.text as string);
      if (text) pushEvent(run, { kind: 'assistant', text });
    } else if ((t === 'thinking' || t === 'reasoning') && (str(c.thinking) ?? str(c.text))) {
      pushEvent(run, { kind: 'reasoning', text: (str(c.thinking) ?? str(c.text)) as string });
    } else if (t === 'tool_use') {
      const name = str(c.name) ?? 'tool';
      const id = str(c.id) ?? `t${++x.toolSeq}`; // transcripts give tool calls no id
      const kind = cursorToolKind(name);
      const filePath = cursorFilePath(c.input);
      pushEvent(run, {
        kind: 'tool_call',
        text: cursorInputSummary(c.input),
        toolName: name,
        toolCallId: id,
        toolKind: kind,
        filePath,
        fileOp: kind === 'edit' && filePath ? fileOpFor(name) : undefined,
      });
      // Counted at the call, like the files table: transcripts give results no call id and no time.
      if (kind === 'edit' && filePath) {
        const d = cursorEditDiff(name, c.input);
        pushChange(run, { filePath, op: fileOpFor(name), diff: d?.diff, linesAdded: d?.added, linesRemoved: d?.removed, toolCallId: id });
      }
      x.open = { name, since: mtime };
    } else if (t === 'tool_result') {
      pushEvent(run, { kind: 'tool_result', text: textOf(c.content), toolCallId: str(c.tool_use_id), isError: c.is_error === true || undefined });
      x.open = null;
    } else if (t !== 'text' && t !== 'image') run.skipped++;
  }
  return true;
}

export async function parseTranscript(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const now = await stat(ref.path);
  const size = now.size;
  if (prev && prev.extra.kind === 'transcript' && size === prev.size && now.mtimeMs === prev.mtimeMs) return prev;
  // A shrunk file was rewritten: start over. Clone prev so a failed read never corrupts it.
  let st: ParseState;
  if (prev && prev.extra.kind === 'transcript' && size >= prev.offset) st = structuredClone(prev);
  else {
    st = freshState();
    st.run = emptyRun(ref.hint?.project ?? 'Unknown project');
    if (ref.hint?.projectPath) st.run.projectPath = ref.hint.projectPath;
    if (ref.hint?.parent) st.run.parentPath = ref.hint.parent;
    st.extra = { kind: 'transcript', recognised: 0, toolSeq: 0, open: null } satisfies Extra;
  }
  const mtimeNow = now.mtimeMs;
  const x = st.extra as Extra;
  const res = await readJsonl(ref.path, st.offset, (rec) => {
    if (applyRecord(st, rec, mtimeNow)) x.recognised++;
    else st.run.skipped++;
  });
  if (res.restarted) return parseTranscript(ref, undefined);
  st.offset = res.offset;
  st.size = res.size;
  st.mtimeMs = res.mtimeMs;
  st.run.skipped += res.bad;
  st.run.openTool = x.open ? { name: x.open.name, kind: cursorToolKind(x.open.name), since: x.open.since } : undefined;
  st.run.readError = x.recognised === 0 && res.size > 0 && (res.good > 0 || res.bad > 0) ? NO_RECORDS : undefined;
  return st;
}
