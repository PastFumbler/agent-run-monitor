// Helpers every adapter uses to build a run: push events (with caps and tallies), classify tools,
// and make titles. Keeping this in one place means every agent's runs count the same way.

import type { EventKind, FileOp, RunEvent, ToolKind } from '@shared/schema';
import type { ParsedRun } from './adapter';
import { addUsage, cleanUsage } from './usage';

/** The newest events kept in memory per run. Older ones are counted, not kept. */
export const MAX_EVENTS = 5000;
/** Longest text kept per event; the UI truncates further. */
export const MAX_TEXT = 20000;

export type NewEvent = Omit<RunEvent, 'seq'>;

export function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/**
 * Adds an event to the run, keeping tallies and the changed-files table current. An event's
 * `usage` is added to the run's token totals here, so adapters must not add it again.
 */
export function pushEvent(run: ParsedRun, e: NewEvent): void {
  const event: NewEvent = { ...e, text: clip(e.text ?? '') };
  const usage = event.usage && cleanUsage(event.usage);
  if (usage) addUsage(run, (event.usage = usage), event.ts);
  else delete event.usage;
  if (event.kind === 'reasoning' && !event.placeholder && event.text.trim()) run.hasReasoning = true;
  run.events.push(event);
  run.tally.events++;
  if (event.kind === 'user' || event.kind === 'assistant') run.tally.messages++;
  if (event.kind === 'tool_call') run.tally.toolCalls++;
  if (event.kind === 'error' || (event.kind === 'tool_result' && event.isError)) run.tally.errors++;
  if (event.filePath && (event.kind === 'file_change' || (event.kind === 'tool_call' && event.toolKind === 'edit'))) {
    const op: FileOp = event.fileOp ?? 'edit';
    const f = (run.files[event.filePath] ??= { ops: [], count: 0 });
    if (!f.ops.includes(op)) f.ops.push(op);
    f.count++;
    if (event.ts) f.lastTs = event.ts;
  }
  if (event.ts && (!run.lastEventAt || event.ts > run.lastEventAt)) run.lastEventAt = event.ts;
  if (event.ts && (!run.startedAt || event.ts < run.startedAt)) run.startedAt = event.ts;
  if (!run.title && event.kind === 'user') run.title = makeTitle(event.text);
  if (run.events.length > MAX_EVENTS) {
    const extra = run.events.length - MAX_EVENTS;
    run.events.splice(0, extra);
    run.dropped += extra;
  }
}

/** The first line of a prompt, without markup noise, at most 120 characters. */
export function makeTitle(text: string): string {
  const line =
    text
      .replace(/<[^>]{1,40}>/g, ' ')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const t = line.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

const RUN = /^(bash|powershell|pwsh|shell|sh|cmd|exec|exec_command|local_shell|local_shell_call|run_shell_command|run_terminal_cmd|run_in_terminal|runterminal|terminal|execute_command|run_command|container\.exec)$/i;
const EDIT = /^(edit|multiedit|write|notebookedit|apply_patch|applypatch|str_replace|str_replace_editor|str_replace_based_edit_tool|write_file|write_to_file|create_file|replace|replace_in_file|insert_edit_into_file|edit_file|search_replace|insert_content|patch|edit_notebook|delete_file|create|update_file)$/i;
const READ = /^(read|read_file|view|cat|readfile|read_many_files|open_file|get_file|notebookread|read_notebook)$/i;
const SEARCH = /^(grep|glob|ls|list|list_dir|list_directory|list_files|search|search_files|file_search|grep_search|codebase_search|find|find_files|semantic_search|toolsearch|search_file_content|list_code_definition_names)$/i;
const WEB = /^(webfetch|websearch|web_search|google_web_search|web_fetch|fetch|fetch_webpage|browser_action|open_url|use_browser)$/i;
const AGENT = /^(task|agent|subagent|dispatch_agent|spawn_agent|new_task|delegate)$/i;

/** Sorts a tool by what it does, from its name. Unknown tools are 'other'. */
export function toolKind(name: string | undefined): ToolKind {
  if (!name) return 'other';
  const n = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/^functions\./, '');
  if (RUN.test(n)) return 'run';
  if (EDIT.test(n)) return 'edit';
  if (READ.test(n)) return 'read';
  if (SEARCH.test(n)) return 'search';
  if (WEB.test(n)) return 'web';
  if (AGENT.test(n)) return 'agent';
  return 'other';
}

/** Turns any value into readable text: strings as-is, objects as compact JSON. */
export function textOf(v: unknown, max = MAX_TEXT): string {
  if (v == null) return '';
  if (typeof v === 'string') return clip(v, max);
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === 'string' ? x : isObj(x) && typeof x.text === 'string' ? x.text : textOf(x, max)));
    return clip(parts.filter(Boolean).join('\n'), max);
  }
  try {
    return clip(JSON.stringify(v), max);
  } catch {
    return '';
  }
}

/** A short one-line summary of a tool's input: the command, the path, the pattern. */
export function toolInputSummary(input: unknown): string {
  if (typeof input === 'string') return clip(input, 2000);
  if (!isObj(input)) return textOf(input, 2000);
  for (const k of ['command', 'cmd', 'file_path', 'path', 'filePath', 'absolute_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(v, 2000);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return clip(v.join(' '), 2000);
  }
  return textOf(input, 2000);
}

/** The file a tool input points at, if any. */
export function toolFilePath(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  for (const k of ['file_path', 'path', 'filePath', 'absolute_path', 'notebook_path', 'target_file', 'filename']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses an ISO date or epoch (s or ms) into epoch ms; undefined when it is not a date. */
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** The last path segment, for project names; works with / and \ separators. */
export function baseName(p: string | undefined): string {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export type { EventKind };
