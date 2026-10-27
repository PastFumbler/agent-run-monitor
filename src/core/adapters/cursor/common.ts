// Helpers shared by the three Cursor stores: tool names, prompt wrappers, paths and URIs.

import type { FileOp, ToolKind } from '@shared/schema';
import { baseName, isObj, toolFilePath, toolInputSummary, toolKind } from '../../events';

/** Cursor tool names the shared classifier does not know. Names may carry a `_v2` suffix. */
const CURSOR_KINDS: Record<string, ToolKind> = {
  strreplace: 'edit',
  delete: 'edit',
  delete_file: 'edit',
  edit_file: 'edit',
  write: 'edit',
  ripgrep_raw_search: 'search',
  glob_file_search: 'search',
  semanticsearch: 'search',
  readlints: 'read',
  read_lints: 'read',
  run_terminal_command: 'run',
  run_terminal_cmd: 'run',
  task: 'agent',
  subagent: 'agent',
};

export function baseToolName(name: string): string {
  return name.replace(/_v\d+$/i, '');
}

export function cursorToolKind(name: string | undefined): ToolKind {
  if (!name) return 'other';
  const base = baseToolName(name);
  return CURSOR_KINDS[base.toLowerCase()] ?? toolKind(base);
}

/** What an edit-family tool did to its file. */
export function fileOpFor(name: string): FileOp {
  const n = baseToolName(name).toLowerCase();
  if (n === 'delete' || n === 'delete_file') return 'delete';
  if (n === 'write' || n === 'create_file' || n === 'write_file') return 'create';
  return 'edit';
}

/** The file a Cursor tool call points at (IDE params use relativeWorkspacePath / targetFile). */
export function cursorFilePath(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  for (const k of ['relativeWorkspacePath', 'targetFile', 'target_file', 'file_path', 'path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return toolFilePath(input);
}

/** One line describing a tool call's input. */
export function cursorInputSummary(input: unknown): string {
  if (isObj(input)) {
    for (const k of ['command', 'relativeWorkspacePath', 'targetFile', 'target_file', 'glob_pattern', 'query', 'pattern']) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return toolInputSummary(input);
}

/** Params, rawArgs and result fields are JSON inside a string: parse, else keep the raw text. */
export function jsonString(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p);
}

/** IDE tools log workspace-relative paths: anchor them to the project so the files table agrees. */
export function resolveIn(projectPath: string | undefined, p: string): string {
  if (!projectPath || isAbsolute(p)) return p;
  // A multi-root workspace is a .code-workspace file: anchor to the folder it sits in (best guess).
  if (/\.code-workspace$/i.test(projectPath)) projectPath = projectPath.replace(/[\\/][^\\/]*$/, '');
  const win = /^[a-zA-Z]:\\/.test(projectPath) || projectPath.includes('\\');
  const sep = win ? '\\' : '/';
  const rel = win ? p.replace(/\//g, '\\') : p;
  return `${projectPath.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^\.[\\/]/, '')}`;
}

/** Project name from a folder or a .code-workspace file. */
export function projectNameOf(p: string | undefined): string {
  return baseName(p).replace(/\.code-workspace$/i, '');
}

/**
 * VS Code stores folders as URIs: file:///home/alex/x, file:///c%3A/Users/alex/x,
 * vscode-remote://wsl+Ubuntu/home/alex/x. Returns a plain path, or undefined.
 */
export function uriToPath(uri: unknown): string | undefined {
  if (isObj(uri)) {
    if (typeof uri.fsPath === 'string' && uri.fsPath) return uri.fsPath;
    if (typeof uri.path === 'string' && uri.path) return uriToPath(`${uri.scheme ?? 'file'}://${uri.path}`);
    if (typeof uri.external === 'string') return uriToPath(uri.external);
    return undefined;
  }
  if (typeof uri !== 'string' || !uri) return undefined;
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/i.exec(uri);
  if (!m) return isAbsolute(uri) ? uri : undefined;
  let p: string;
  try {
    p = decodeURIComponent(m[1]);
  } catch {
    p = m[1];
  }
  const drive = /^\/([a-zA-Z]):(\/.*)?$/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  return p;
}

// ---------- prompts ----------

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Transcripts carry no timestamps except a human-readable tag in user prompts:
 * `<timestamp>Monday, Sep 21, 2026, 7:03 AM (UTC-7)</timestamp>` ([SINGLE] vibe-replay).
 */
export function parseTimestampTag(text: string): number | undefined {
  const m =
    /<timestamp>[^<]*?([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)?[^<(]*(?:\(UTC([+-]\d{1,2})(?::?(\d{2}))?\))?[^<]*<\/timestamp>/i.exec(
      text,
    );
  if (!m) return undefined;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return undefined;
  let hour = Number(m[4]) % 12;
  if (!m[7]) hour = Number(m[4]);
  else if (m[7].toUpperCase() === 'PM') hour += 12;
  const offH = m[8] ? Number(m[8]) : 0;
  const offM = m[9] ? Number(m[9]) * Math.sign(offH || 1) : 0;
  const utc = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]), Number(m[6] ?? 0));
  return utc - (offH * 60 + offM) * 60_000;
}

/** `Workspace Path: /home/alex/x` inside a CLI `<user_info>` block ([SINGLE] cppa-cursor-browser). */
export function workspacePathFrom(text: string): string | undefined {
  const m = /<user_info>[\s\S]*?Workspace Path:\s*([^\n<]+)/i.exec(text);
  return m ? m[1].trim() : undefined;
}

/**
 * The prompt as the user typed it: drops `<timestamp>`, `<user_info>` and similar context blocks
 * and unwraps `<user_query>`. Returns '' for records that are only injected context.
 */
export function cleanPrompt(text: string): string {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text);
  if (q) return q[1].trim();
  return text
    .replace(/<(timestamp|user_info|system_reminder|additional_data|attached_files|rules)>[\s\S]*?<\/\1>/gi, '')
    .trim();
}

export function stripRedacted(text: string): string {
  return text.replace(/\s*\[REDACTED\]/g, '').trim();
}
