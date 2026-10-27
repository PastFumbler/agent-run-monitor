// Small helpers shared by the two Copilot adapters (VS Code chat and Copilot CLI).
// Everything here only reads: readdir, stat, open 'r', readFile.

import { open, readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { ParseState } from '../../adapter';

/** readdir that never throws: a missing or unreadable folder is just empty. */
export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** stat that never throws. */
export async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number; isDir: boolean } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

/** Reads a small text file; undefined when it is missing or unreadable. */
export async function readSmallText(path: string, max = 256 * 1024): Promise<string | undefined> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > max) return undefined;
    const text = await readFile(path, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

/**
 * A cheap fingerprint of where an incremental read stopped: the first bytes of the file and the
 * bytes just before the offset. Both agents can rewrite a file in place (VS Code compacts its log
 * into one snapshot line; the CLI truncates on rewind), so a grown file is not proof of an append.
 */
export async function readSignature(path: string, offset: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await fh.read(head, 0, 64, 0);
    // The 32 bytes before the offset: a rewritten file rarely repeats them at the same place.
    let tail = '';
    if (offset > 0) {
      const n = Math.min(32, offset);
      const buf = Buffer.alloc(n);
      const r = await fh.read(buf, 0, n, offset - n);
      tail = buf.subarray(0, r.bytesRead).toString('base64');
    }
    return `${head.subarray(0, bytesRead).toString('base64')}:${tail}`;
  } finally {
    await fh.close();
  }
}

/** True when `prev` can be continued: the file did not shrink and was not rewritten. */
export async function canContinue(path: string, prev: ParseState | undefined, size: number, kind: string): Promise<boolean> {
  if (!prev || prev.extra.kind !== kind || prev.offset <= 0 || size < prev.offset) return false;
  const sig = prev.extra.sig;
  if (typeof sig !== 'string') return false;
  try {
    return (await readSignature(path, prev.offset)) === sig;
  } catch {
    return false;
  }
}

/**
 * Turns a VS Code URI (a string like file:///c%3A/x, or a serialized {$mid, fsPath, path, scheme}
 * object) into a plain path. Windows drive paths get backslashes, independent of the host OS, so
 * fixtures read the same everywhere. Remote URIs (vscode-remote://wsl+ubuntu/home/...) keep their
 * POSIX path.
 */
export function uriToPath(u: unknown): string | undefined {
  if (typeof u === 'string') return uriStringToPath(u);
  if (typeof u !== 'object' || u === null) return undefined;
  const o = u as Record<string, unknown>;
  if (typeof o.fsPath === 'string' && o.fsPath) return o.fsPath;
  if (typeof o.external === 'string' && o.external) return uriStringToPath(o.external);
  if (typeof o.path === 'string' && o.path) return drivePath(safeDecode(o.path));
  return undefined;
}

function uriStringToPath(s: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(s.trim());
  if (!m) return s || undefined;
  const path = safeDecode((m[3] ?? '/').replace(/[?#].*$/, ''));
  if (m[1].toLowerCase() === 'file' && m[2] && m[2] !== 'localhost') return `\\\\${m[2]}${path.replace(/\//g, '\\')}`;
  return drivePath(path);
}

/** "/c:/Users/x" -> "c:\Users\x"; other paths unchanged. */
function drivePath(p: string): string {
  if (/^\/[a-zA-Z]:(\/|$)/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return p;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Replaces markdown links to files ("Reading [](file:///c%3A/x/a.py)") with the plain path. */
export function cleanLinks(md: string): string {
  return md.replace(/\[([^\]]*)\]\(([a-z][a-z0-9+.-]*:\/\/[^)\s]+)\)/gi, (_all, label: string, uri: string) => {
    const p = uriToPath(uri);
    return label ? `${label}${p ? ` (${p})` : ''}` : (p ?? uri);
  });
}

/** The first file:// link in a markdown string, as a path. */
export function firstLinkedPath(md: string | undefined): string | undefined {
  if (!md) return undefined;
  const m = /\((file:\/\/[^)\s]+)\)/i.exec(md);
  return m ? uriToPath(m[1]) : undefined;
}

/**
 * A tolerant reader for the flat `key: value` YAML that Copilot CLI writes to workspace.yaml.
 * Only top-level scalars are needed; nested blocks and lists are ignored.
 */
export function parseFlatYaml(text: string): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(raw);
    if (!m || m[2] === undefined) continue;
    let v = m[2].trim();
    if (!v || v === '|' || v === '>' || v === '~' || v === 'null') continue;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
      try {
        out[m[1]] = JSON.parse(v);
        continue;
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1).replace(/''/g, "'");
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    if (v === 'true' || v === 'false') out[m[1]] = v === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[m[1]] = Number(v);
    else out[m[1]] = v;
  }
  return out;
}
