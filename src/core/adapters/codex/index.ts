// OpenAI Codex adapter: the CLI, the IDE extension and the desktop app all write the same rollout
// files under CODEX_HOME (default ~/.codex). Read-only: readdir, stat, open 'r', createReadStream
// and readFile only.
//
// Provenance: Codex was not installed on the machine this adapter was written on, so nothing here was
// checked against a real installation. The format, paths and record types were checked against the
// openai/codex source (main @ 6fe77fc, rust-v0.164.0, plus older tags for the format history), hence
// confidence 'source'. Record handling and its quirks are documented in records.ts.

import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as zlib from 'node:zlib';
import { emptyRun, freshState, type ParseState, type SessionRef, type SourceAdapter } from '../../adapter';
import { baseName, isObj } from '../../events';
import { readJsonl } from '../../jsonl';
import { defaultRoots, discoverRollouts, findThreadFile } from './paths';
import { finish, handleRecord, newState, STATE_VERSION, type CodexState } from './records';

const HEAD_BYTES = 256;

/** The first bytes of the file, to notice an in-place rewrite (Codex's history migration). */
async function readHead(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('latin1');
  } finally {
    await fh.close();
  }
}

function sameHead(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

function startState(ref: SessionRef): { st: ParseState; s: CodexState } {
  const st = freshState();
  st.run = emptyRun(ref.hint?.project ?? 'Unknown project');
  const s = newState();
  st.extra = s as unknown as Record<string, unknown>;
  return { st, s };
}

/** Copies prev so earlier states stay untouched (events are shared; markFailed replaces, never mutates). */
function continueState(prev: ParseState): { st: ParseState; s: CodexState } {
  const r = prev.run;
  const files: ParseState['run']['files'] = {};
  for (const [k, f] of Object.entries(r.files)) files[k] = { ...f, ops: [...f.ops] };
  const run = { ...r, events: [...r.events], tally: { ...r.tally }, files };
  const s = structuredClone(prev.extra) as unknown as CodexState;
  return { st: { ...prev, run, extra: s as unknown as Record<string, unknown> }, s };
}

function usable(prev: ParseState | undefined): prev is ParseState {
  const v = prev?.extra && (prev.extra as Partial<CodexState>).v;
  return !!prev && !prev.run.readError && v === STATE_VERSION;
}

async function resolveParent(ref: SessionRef, st: ParseState, s: CodexState): Promise<void> {
  const home = ref.hint?.home;
  if (s.parentThreadId && s.parentPath === undefined && home) s.parentPath = (await findThreadFile(home, s.parentThreadId, dirname(ref.path))) ?? null;
  st.run.parentPath = s.parentPath ?? undefined;
}

/** Append-only .jsonl: continue from the previous byte offset. */
async function parseJsonl(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const info = await stat(ref.path);
  const head = await readHead(ref.path);
  const resume = usable(prev) && prev.offset <= info.size && sameHead((prev.extra as Partial<CodexState>).head, head);
  let { st, s } = resume ? continueState(prev) : startState(ref);
  if (!s.head || head.length > s.head.length) s.head = head;

  let r = await readJsonl(ref.path, st.offset, (rec) => safeHandle(rec, st, s));
  if (r.restarted && st.offset > 0) {
    // Shrank between our stat and read: start over.
    ({ st, s } = startState(ref));
    s.head = head;
    r = await readJsonl(ref.path, 0, (rec) => safeHandle(rec, st, s));
  }
  s.bad += r.bad;
  st.run.skipped += r.bad;
  st.offset = r.offset;
  st.size = r.size;
  st.mtimeMs = r.mtimeMs;
  await resolveParent(ref, st, s);
  finish(st.run, s, r.mtimeMs);
  return st;
}

function safeHandle(rec: unknown, st: ParseState, s: CodexState): void {
  try {
    handleRecord(rec, st.run, s);
  } catch {
    st.run.skipped++; // an odd shape we did not foresee: count it, keep going
  }
}

/**
 * Streams a .jsonl.zst rollout line by line: decompression runs off the main thread and only one
 * chunk plus the current line is held in memory, however large the rollout.
 */
async function readZstLines(path: string, onLine: (line: string) => void): Promise<void> {
  const create = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
  if (!create) throw new Error('this run is zstd-compressed and this version of Node cannot decompress it');
  const src = createReadStream(path);
  const unz = create();
  src.on('error', (e) => (unz as unknown as { destroy(e: Error): void }).destroy(e));
  const dec = new StringDecoder('utf8');
  let carry = '';
  try {
    for await (const chunk of src.pipe(unz)) {
      // Only the new piece is searched for newlines, so a very long line costs linear time.
      const piece = dec.write(chunk as Buffer);
      const nl = piece.lastIndexOf('\n');
      if (nl < 0) {
        carry += piece;
        continue;
      }
      const text = carry + piece.slice(0, nl);
      carry = piece.slice(nl + 1);
      for (const l of text.split('\n')) onLine(l);
    }
    carry += dec.end();
    if (carry) onLine(carry);
  } finally {
    src.destroy(); // never keep a handle open: it would block Codex's rename / archive on Windows
  }
}

/** Compressed (.jsonl.zst) or legacy .json rollouts: re-read only when size or mtime changed. */
async function parseWhole(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const info = await stat(ref.path);
  if (usable(prev) && prev.size === info.size && prev.mtimeMs === info.mtimeMs) return prev;
  const { st, s } = startState(ref);
  if (ref.path.endsWith('.zst')) {
    await readZstLines(ref.path, (line) => {
      if (!line.trim()) return;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        s.bad++;
        st.run.skipped++;
        return;
      }
      safeHandle(rec, st, s);
    });
  } else {
    const raw = await readFile(ref.path);
    // Pre-Rust TypeScript CLI: {session:{id,timestamp,...}, items:[ResponseItem...]}. [UNVERIFIED]
    const text = raw.toString('utf8');
    const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    if (isObj(doc) && isObj(doc.session)) safeHandle({ timestamp: null, ...doc.session, id: String(doc.session.id ?? '') }, st, s);
    const items = isObj(doc) && Array.isArray(doc.items) ? doc.items : [];
    for (const it of items) safeHandle(it, st, s);
    if (!items.length && !(isObj(doc) && isObj(doc.session))) st.run.skipped++;
  }
  st.offset = info.size;
  st.size = info.size;
  st.mtimeMs = info.mtimeMs;
  await resolveParent(ref, st, s);
  finish(st.run, s, info.mtimeMs);
  return st;
}

export const codexAdapter: SourceAdapter = {
  id: 'codex',
  displayName: 'Codex',
  confidence: 'source',
  note: 'Reads Codex rollouts (CLI, IDE extension, desktop app) from CODEX_HOME/sessions and archived_sessions; checked against the Codex source, not a real install.',
  defaultRoots,
  discover: (roots, ctx) => discoverRollouts(roots, ctx),
  async parse(ref, prev) {
    const st = /\.(zst|json)$/i.test(ref.path) ? await parseWhole(ref, prev) : await parseJsonl(ref, prev);
    if (!st.run.projectPath && st.run.projectName === 'Unknown project' && ref.hint?.project) st.run.projectName = baseName(ref.hint.project);
    return st;
  },
};

export const adapter = codexAdapter;
export const adapters = [codexAdapter];
