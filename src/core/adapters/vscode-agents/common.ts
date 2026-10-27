// Small helpers shared by the Cline, Roo Code and Continue parsers: read-only file access,
// a salvaging JSON reader for files caught mid-rewrite, tool classification and path decoding.

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import type { FileOp, ToolKind } from '@shared/schema';
import type { ParseState, SessionRef } from '../../adapter';
import { isObj, toolKind } from '../../events';

export type Obj = Record<string, unknown>;

export const UNRECOGNISED = "No records this app recognises; the agent may have changed its format.";

/** Whole-file transcripts larger than this are not parsed (base64 images can make them huge). */
export const MAX_FILE = 64 * 1024 * 1024;
/** History indexes read during discovery are capped lower. */
export const MAX_INDEX = 16 * 1024 * 1024;

// ---------------------------------------------------------------- fs (read-only)

export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // missing root or no permission: nothing to list
  }
}

export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Reads a small JSON file, or undefined when it is missing, too big or not valid JSON. */
export async function readJsonQuiet(path: string, max = MAX_INDEX): Promise<unknown> {
  try {
    const st = await stat(path);
    if (st.size > max) return undefined;
    return JSON.parse(stripBom(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}

export interface JsonRead {
  value: unknown;
  /** True when the file was cut off and only the complete leading elements were recovered. */
  salvaged: boolean;
}

/**
 * Reads a whole-file JSON transcript. These agents rewrite the file on every message, sometimes
 * non-atomically, so a reader can catch it cut off. Then the complete leading elements of the
 * transcript array (the top-level array, or the array under `arrayKey`) are recovered.
 * Throws the original SyntaxError when nothing can be recovered.
 */
export async function readTranscript(path: string, arrayKey?: string): Promise<JsonRead> {
  const st = await stat(path);
  if (st.size > MAX_FILE) throw new Error(`The file is too large to read (${Math.round(st.size / 1048576)} MB).`);
  const text = stripBom(await readFile(path, 'utf8'));
  try {
    return { value: JSON.parse(text), salvaged: false };
  } catch (e) {
    const start = arrayStart(text, arrayKey);
    const items = start >= 0 ? salvageArray(text, start) : [];
    if (!items.length) throw e;
    return { value: arrayKey ? { [arrayKey]: items } : items, salvaged: true };
  }
}

function arrayStart(text: string, key?: string): number {
  if (!key) {
    const i = text.search(/\S/);
    return i >= 0 && text[i] === '[' ? i : -1;
  }
  // The key may also appear as a value earlier on; take the first `"key": [` occurrence.
  const needle = `"${key}"`;
  for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) {
    const m = /^\s*:\s*\[/.exec(text.slice(k + needle.length, k + needle.length + 64));
    if (m) return k + needle.length + m[0].length - 1;
  }
  return -1;
}

/** Parses each complete `{...}` element of the array opening at `start`; stops at the cut. */
export function salvageArray(text: string, start: number): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') {
      depth++;
      if (depth === 2 && c === '{') elemStart = i;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 1 && c === '}' && elemStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(elemStart, i + 1)));
        } catch {
          return out;
        }
        elemStart = -1;
      }
      if (depth <= 0) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- incremental helpers

/** Whole-file formats: unchanged when the main file and every sibling stat match what we saw. */
export function unchanged(ref: SessionRef, prev: ParseState | undefined, siblings: Record<string, number> = {}): boolean {
  if (!prev || prev.run.readError) return false;
  if (prev.size !== ref.size || prev.mtimeMs !== ref.mtimeMs) return false;
  const seen = (prev.extra.siblings ?? {}) as Record<string, number>;
  return Object.keys(siblings).every((k) => seen[k] === siblings[k]) && Object.keys(seen).length === Object.keys(siblings).length;
}

/** A cheap fingerprint (size:mtime) of a sibling file, 0 when it is missing. */
export async function fingerprint(path: string): Promise<number> {
  const st = await statOrNull(path);
  return st ? st.size * 1e3 + Math.floor(st.mtimeMs) : 0;
}

// ---------------------------------------------------------------- tools

/** Tool names these agents use that the shared classifier does not know. */
const EXTRA_KINDS: Record<string, ToolKind> = {
  // API tool names (Cline 3.x, Roo, Cline SDK, Continue)
  apply_diff: 'edit',
  search_and_replace: 'edit',
  editor: 'edit',
  edit_existing_file: 'edit',
  single_find_and_replace: 'edit',
  multi_edit: 'edit',
  create_new_file: 'edit',
  read_files: 'read',
  read_file_range: 'read',
  read_currently_open_file: 'read',
  read_command_output: 'read',
  run_commands: 'run',
  run_terminal_command: 'run',
  execute_command: 'run',
  search_codebase: 'search',
  file_glob_search: 'search',
  codebase: 'search',
  fetch_web_content: 'web',
  search_web: 'web',
  fetch_url_content: 'web',
  use_subagents: 'agent',
  // ui_messages tool names (ClineSayTool.tool)
  editedexistingfile: 'edit',
  applieddiff: 'edit',
  newfilecreated: 'edit',
  filedeleted: 'edit',
  readfile: 'read',
  listfilestoplevel: 'search',
  listfilesrecursive: 'search',
  listcodedefinitionnames: 'search',
  searchfiles: 'search',
  codebasesearch: 'search',
  webfetch: 'web',
  websearch: 'web',
  newtask: 'agent',
};

export function kindOf(name: string | undefined): ToolKind {
  if (!name) return 'other';
  return EXTRA_KINDS[name] ?? EXTRA_KINDS[name.toLowerCase()] ?? toolKind(name);
}

export function fileOpOf(name: string): FileOp {
  if (/^(newFileCreated|create_new_file|create_file)$/i.test(name)) return 'create';
  if (/^(fileDeleted|delete_file)$/i.test(name)) return 'delete';
  return 'edit';
}

/** `*** Update File: x`, `*** Add File: y`, `*** Delete File: z` lines of an apply_patch input. */
export function patchFiles(patch: string): { path: string; op: FileOp }[] {
  const out: { path: string; op: FileOp }[] = [];
  for (const m of patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)) {
    out.push({ path: m[2].trim(), op: m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'edit' });
  }
  return out;
}

/**
 * Tool results these agents mark as failures in text rather than with is_error: Cline's
 * "The tool execution failed with the following error:" and Roo's {"status":"error",...}.
 * Only the head of the result is checked (after Cline's "[tool] Result:" prefix): a successful
 * read of a file that merely contains those words must not count as a failure.
 */
export function looksFailed(text: string): boolean {
  const prefix = /^\s*\[[^\]\n]{1,300}\] Result:\s*/.exec(text);
  const head = text.slice(prefix ? prefix[0].length : 0).trimStart().slice(0, 200);
  if (/^The tool execution failed/.test(head)) return true;
  // Roo's compact JSON.stringify errors. After Cline's prefix the head is the tool's own output
  // (a file that happens to start that way), so only unprefixed results are checked.
  return !prefix && /^\{"status":"error"/.test(head);
}

// ---------------------------------------------------------------- text and paths

/**
 * Readable text of a tool result's content: strings and text blocks; images and documents become
 * a short placeholder instead of their base64 payload (browser screenshots, image reads).
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return isObj(content) ? resultText([content]) : '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!isObj(b)) return '';
      if (typeof b.text === 'string') return b.text;
      if (b.type === 'image' || b.type === 'media') return '[image]';
      if (b.type === 'document' || b.type === 'file') return `[file${typeof b.path === 'string' ? ` ${b.path}` : ''}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Text out of a string or an Anthropic-style block array (text blocks only). */
export function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : typeof b === 'string' ? b : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * VS Code stores folders as URIs (`file:///c%3A/Users/alex/todo-cli`); the CLIs store plain paths.
 * Remote and virtual URIs (vscode-remote://...) are returned as they are.
 */
export function uriToPath(v: string): string {
  if (!/^file:\/\//i.test(v)) return v;
  let p: string;
  try {
    p = decodeURIComponent(v.replace(/^file:\/\/(localhost)?/i, ''));
  } catch {
    return v;
  }
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] ?? '\\').replace(/\//g, '\\')}`;
  return p;
}

/** Cline/Roo environment details write the cwd with forward slashes; give Windows paths back their backslashes. */
export function nativePath(p: string): string {
  return /^[A-Za-z]:\//.test(p) ? p.replace(/\//g, '\\') : p;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseJsonText(text: unknown): Obj | undefined {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return undefined;
  try {
    const v = JSON.parse(text);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Agents' temporary write files: Cline's `x.json.tmp.<ms>.<rand>.json`, Roo's `.x.json.new_*.tmp` / `.bak_*`, proper-lockfile `*.lock`. */
const TEMP_FILE = /\.tmp(?:\.|$)|\.lock$|^\..*\.(?:new|bak)_/i;
/** Folders in the agents' data roots that never hold a transcript (checkpoint repos, caches, logs, SQLite). */
const NOISE_DIRS = new Set(['cache', 'puppeteer', 'logs', 'db', 'teams', 'connectors', 'workspaces', 'settings', 'hooks']);
const ANCHORS = /^(saoudrizwan\.claude-dev|rooveterinaryinc\.roo-cline|\.cline|\.continue)$/i;

/**
 * Watched-path filter: temp files from the agents' atomic writes, lock folders and checkpoint /
 * cache / log / database folders never affect a run, so they must not trigger a re-discovery
 * (Cline writes a temp file on every message; its checkpoints are a shadow git repo).
 */
export function isRelevantChange(p: string): boolean {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.some((seg) => TEMP_FILE.test(seg))) return false;
  let a = -1;
  for (let i = parts.length - 1; i >= 0 && a < 0; i--) if (ANCHORS.test(parts[i])) a = i;
  const inside = (a >= 0 ? parts.slice(a + 1) : parts.slice(-4)).map((s) => s.toLowerCase());
  // Roo keeps a shadow git repo per task (tasks/<id>/checkpoints), Cline one per workspace.
  if (inside.includes('checkpoints')) return false;
  if (a < 0) return true; // a custom root: nothing else is known noise
  // ~/.continue: only sessions/ matters (index/ holds the codebase index and churns constantly).
  if (/^\.continue$/i.test(parts[a])) return inside.length === 0 || inside[0] === 'sessions';
  // ~/.cline/data/<dir>: the folder right under the data dir decides; elsewhere, right under the root.
  if (inside[0] === 'data') inside.shift();
  return !(inside.length > 0 && NOISE_DIRS.has(inside[0]));
}

export { isObj };
