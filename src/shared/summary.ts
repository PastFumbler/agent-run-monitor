// The local run summary at the top of Overview: one or two plain sentences built from the run's own
// data (its request, status, current or last tool, edits, files and commands). Pure, no network.
// Counts of edits and files are run totals; commands are counted in the loaded events.

import type { RunDetail, RunEvent, RunStatus, RunSummary } from './schema';

const MAX_REQUEST = 90;

/** The request as a short quote, or undefined when the run has none. */
function quoted(title: string): string | undefined {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const short = t.length > MAX_REQUEST ? `${t.slice(0, MAX_REQUEST - 1).trimEnd()}…` : t;
  return `“${short}”`;
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a.ts", "a.ts and b.ts", "a.ts, b.ts and c.ts", "a.ts, b.ts and 3 more files". */
export function filesPhrase(paths: string[]): string {
  const names = paths.map(baseName);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more files`;
}

/** What a tool call is doing, in a few words: "editing cli.ts", "running a command". */
function toolPhrase(e: RunEvent): string {
  const file = e.filePath ? baseName(e.filePath) : undefined;
  switch (e.toolKind) {
    case 'edit':
      return file ? `editing ${file}` : 'editing files';
    case 'read':
      return file ? `reading ${file}` : 'reading files';
    case 'run':
      return 'running a command';
    case 'search':
      return 'searching the code';
    case 'web':
      return 'looking something up on the web';
    case 'agent':
      return 'running a sub-agent';
    default:
      return e.toolName ? `using ${e.toolName}` : 'using a tool';
  }
}

function firstSentence(status: RunStatus, request: string | undefined, now: string | undefined): string {
  const req = request ?? 'its request';
  switch (status) {
    case 'running':
      return now ? `Working on ${req}, now ${now}.` : `Working on ${req}.`;
    case 'waiting':
      return `Waiting for you on ${req}.`;
    case 'idle':
      return `Paused after working on ${req}.`;
    case 'done':
      return request ? `Finished ${request}.` : 'Finished.';
    case 'failed':
      return `Stopped with an error while working on ${req}.`;
    case 'stuck':
      return `Seems stuck on ${req}: nothing has happened for a while.`;
    default:
      return "This run couldn't be read.";
  }
}

/**
 * One plain sentence: what the run is doing now ("Working on “…”, now editing cli.ts."). Works from
 * the summary alone; the loaded events, when given, name the file or command behind the open tool.
 * The Simple display tier shows this line for each running run.
 */
export function doingSentence(s: RunSummary, events: RunEvent[] = []): string {
  if (s.status === 'unreadable') return firstSentence('unreadable', undefined, undefined);
  let last: RunEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !last; i--) if (events[i].kind === 'tool_call') last = events[i];
  const now = s.status === 'running' && s.currentTool ? (last && last.toolName === s.currentTool ? toolPhrase(last) : `using ${s.currentTool}`) : undefined;
  return firstSentence(s.status, quoted(s.title), now);
}

/** One or two plain sentences describing what the run is doing or did. */
export function localSummary(d: RunDetail): string {
  const s = d.summary;
  if (s.status === 'unreadable') return firstSentence('unreadable', undefined, undefined);
  const calls = d.events.filter((e) => e.kind === 'tool_call');
  const last = calls[calls.length - 1];
  const live = s.status === 'running';
  const first = doingSentence(s, d.events);

  const edits = d.totalChanges;
  const files = d.files.map((f) => f.path);
  const commands = calls.filter((e) => e.toolKind === 'run').length;
  // Ongoing runs read "has made"; finished ones "made".
  const ongoing = live || s.status === 'waiting' || s.status === 'idle';
  const parts: string[] = [];
  if (edits > 0 && files.length) parts.push(`made ${plural(edits, 'edit')} to ${filesPhrase(files)}`);
  else if (edits > 0) parts.push(`made ${plural(edits, 'edit')}`);
  else if (files.length) parts.push(`changed ${filesPhrase(files)}`);
  if (commands > 0) parts.push(`${ongoing ? 'run' : 'ran'} ${plural(commands, 'command')}`);
  const lastTool = !live && last?.toolName ? `; the last tool it used was ${last.toolName}` : '';

  let second: string;
  // "made 4 edits to a.ts and b.ts, and run 2 commands": a comma when the first part has its own "and".
  const joined = parts.length > 1 && parts[0].includes(' and ') ? parts.join(', and ') : parts.join(' and ');
  if (parts.length) second = `${ongoing ? 'So far it has' : 'It'} ${joined}${lastTool}.`;
  else if (calls.length) second = `${ongoing ? 'So far it has' : 'It'} made ${plural(calls.length, 'tool call')} and changed no files${lastTool}.`;
  else second = ongoing ? 'No edits or commands yet.' : 'It made no edits and ran no commands.';
  return `${first} ${second}`;
}
