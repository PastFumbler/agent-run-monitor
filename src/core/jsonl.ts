// Incremental, read-only JSONL reading. Agents append to their session files while we read them,
// so we remember the byte offset of the last complete line and continue from there next time.
// A last line without a newline is only consumed if it is already complete JSON.

import { open, stat } from 'node:fs/promises';

const CHUNK = 1 << 20;

export interface JsonlReadResult {
  /** Offset just past the last consumed line. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** Lines that were not valid JSON (corrupt or truncated in the middle of the file). */
  bad: number;
  /** Records delivered. */
  good: number;
}

/**
 * Reads complete JSONL records from `offset` to the end of the file, calling `onRecord` for each.
 * If the file shrank below `offset` (rewritten or rotated), reading restarts at 0 and `restarted`
 * is reported through `restarted`. `skipLine` sees the first 256 characters of lines over 4 KB and
 * may return true to skip them unparsed.
 */
export async function readJsonl(
  path: string,
  offset: number,
  onRecord: (rec: unknown) => void,
  opts: { skipLine?: (head: string) => boolean } = {},
): Promise<JsonlReadResult & { restarted: boolean }> {
  const st = await stat(path);
  let restarted = false;
  if (st.size < offset) {
    offset = 0;
    restarted = true;
  }
  const fh = await open(path, 'r');
  let good = 0;
  let bad = 0;
  try {
    let pos = offset;
    let carry: Buffer = Buffer.alloc(0);
    let consumed = offset;
    const buf = Buffer.alloc(CHUNK);
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue;
        // An adapter can skip huge records it never shows (e.g. raw API request blobs) by looking
        // at the first bytes only, without decoding or parsing the whole line.
        if (opts.skipLine && i - start > 4096 && opts.skipLine(data.toString('utf8', start, start + 256))) {
          start = i + 1;
          continue;
        }
        const line = data.toString('utf8', start, i).trim();
        if (line) {
          try {
            onRecord(JSON.parse(line));
            good++;
          } catch (e) {
            if (e instanceof SyntaxError) bad++;
            else throw e;
          }
        }
        start = i + 1;
      }
      carry = data.subarray(start);
      consumed = pos - carry.length;
    }
    // A final line with no newline: take it only if it is already complete JSON.
    const tail = carry.toString('utf8').trim();
    if (tail) {
      try {
        const rec = JSON.parse(tail);
        onRecord(rec);
        good++;
        consumed = pos;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        // Probably still being written: leave it for the next read.
      }
    }
    return { offset: consumed, size: st.size, mtimeMs: st.mtimeMs, bad, good, restarted };
  } finally {
    await fh.close();
  }
}

/** Reads a whole JSON file read-only. Throws on invalid JSON (safeParse reports it). */
export async function readJson(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
