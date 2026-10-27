// Read-only, byte-exact line scanning for Aider's append-only Markdown log.
// Offsets are counted on the raw bytes, so CRLF files (Aider on Windows writes text mode, so every
// "\n" becomes "\r\n") and LF files both give stable session offsets. A last line without "\n" is
// never delivered: Aider may still be writing it.

import { open } from 'node:fs/promises';

const CHUNK = 1 << 20;

export interface ScanResult {
  /** Offset just past the last line delivered (or of the line the callback stopped at). */
  consumed: number;
  size: number;
  mtimeMs: number;
  /** True when the callback asked to stop. */
  stopped: boolean;
}

/**
 * Calls `onLine(bytes, lineStart)` for every complete line from `from` to the end of the file,
 * without the trailing "\r\n" / "\n". Returning false stops before that line is consumed.
 */
export async function scanLines(
  path: string,
  from: number,
  onLine: (bytes: Buffer, lineStart: number) => boolean | void,
): Promise<ScanResult> {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    let pos = from;
    let consumed = from;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (bytesRead <= 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
      const dataStart = pos - carry.length;
      pos += bytesRead;
      let s = 0;
      for (let i = data.indexOf(0x0a, s); i !== -1; i = data.indexOf(0x0a, s)) {
        const e = i > s && data[i - 1] === 0x0d ? i - 1 : i;
        if (onLine(data.subarray(s, e), dataStart + s) === false) {
          return { consumed: dataStart + s, size: st.size, mtimeMs: st.mtimeMs, stopped: true };
        }
        s = i + 1;
        consumed = dataStart + s;
      }
      carry = data.subarray(s);
    }
    return { consumed, size: st.size, mtimeMs: st.mtimeMs, stopped: false };
  } finally {
    await fh.close();
  }
}
