// Read-only SQLite snapshots for the Cursor adapter, using Node's built-in node:sqlite.
//
// The original database is never opened by a SQLite engine (that could create a -shm file next to
// the user's database, or checkpoint its WAL). Instead the db and its -wal (never -shm) are copied
// into a fresh subfolder of a temp folder, the copy is opened with { readOnly: true }, and the
// whole subfolder (copy, -wal, and the -shm SQLite creates next to the copy) is deleted when the
// snapshot is closed. SQLite itself reads the copied -wal, so rows still only in the WAL are seen.
//
// Copying a multi-GB database on every change is too expensive, so databases (db + -wal) over
// limits.maxDbBytes (2 GB) are refused with a DbTooLargeError that says why. Large databases
// (over BIG_DB_BYTES) also reuse a recent snapshot for a few seconds instead of re-copying on
// every write. Callers query with key ranges, never LIKE, so the key index is used.
//
// node:sqlite is loaded lazily (await import) so importing this adapter never fails on a Node
// without it; reading a database then fails with a clear message instead.

import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type Database = DatabaseSync;
export type SqlValue = SQLOutputValue;

/** Every read copies the database first: refuse anything bigger than this (db + -wal). */
export const MAX_DB_BYTES = 2 * 1024 ** 3;
/** Mutable so tests can exercise the guard without a 2 GB file. */
export const limits = { maxDbBytes: MAX_DB_BYTES };
/** Above this size a recent snapshot may be reused for a while instead of re-copying on every write. */
const BIG_DB_BYTES = 256 * 1024 ** 2;
const BIG_DB_REUSE_MS = 15_000;
/** Snapshots are closed (and their temp copy deleted) after this long without use. */
const IDLE_CLOSE_MS = 20_000;
const MAX_CACHED = 4;

export class DbTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(
      `This Cursor database is ${gb(bytes)} GB, more than the ${gb(limits.maxDbBytes)} GB this app will copy to read it safely, so its chats are skipped.`,
    );
  }
}

function gb(n: number): string {
  return (n / 1024 ** 3).toFixed(1);
}

// ---------- node:sqlite loading ----------

type SqliteModule = typeof import('node:sqlite');
let sqlitePromise: Promise<SqliteModule> | undefined;

function sqlite(): Promise<SqliteModule> {
  if (!sqlitePromise) {
    sqlitePromise = import('node:sqlite').catch(() => {
      sqlitePromise = undefined;
      throw new Error('This build of Node has no SQLite support');
    });
  }
  return sqlitePromise;
}

// ---------- stamps ----------

export interface DbStamp {
  /** Changes whenever the db or its -wal changes. */
  key: string;
  size: number;
  walSize: number;
  /** The newer of the db and -wal mtimes. */
  mtimeMs: number;
  mainMtimeMs: number;
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** Size and mtime of the database and its -wal: cheap change detection without opening anything. */
export async function dbStamp(dbPath: string): Promise<DbStamp> {
  const db = await stat(dbPath);
  const wal = await statOrNull(`${dbPath}-wal`);
  const walSize = wal?.size ?? 0;
  const mtimeMs = Math.max(db.mtimeMs, wal?.mtimeMs ?? 0);
  return { key: `${db.size}:${db.mtimeMs}:${walSize}:${wal?.mtimeMs ?? 0}`, size: db.size, walSize, mtimeMs, mainMtimeMs: db.mtimeMs };
}

// ---------- temp copies ----------

/**
 * Discovery gets no ParseContext.tempDir, so it copies into a per-process folder under the OS temp
 * folder instead; that folder is removed again once its last snapshot is closed (and at exit).
 */
const fallbackRoot = join(tmpdir(), `agent-run-monitor-cursor-${process.pid}`);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Streams src to dest. createReadStream opens the source read-only and shares it with the writer
 * (CopyFile on Windows may refuse a file another process has open for writing).
 */
async function copyOne(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createWriteStream(dest, { flags: 'wx' }));
}

async function removeCopyDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  if (dir.startsWith(fallbackRoot)) await rmdir(fallbackRoot).catch(() => undefined); // only if empty
}

/** A non-empty rollback journal means a write is half done: give it a moment. */
async function waitForJournal(dbPath: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const journal = await statOrNull(`${dbPath}-journal`);
    if (!journal || journal.size === 0) return;
    await delay(100 * (i + 1));
  }
}

interface Copy {
  dir: string;
  file: string;
  stamp: DbStamp;
}

/**
 * Copies db (+ -wal, never -shm) into a fresh subfolder of tempRoot. If the source changed while
 * it was copied, the copy is thrown away and made again once. If it changed again, the copy is
 * kept only when the main file did not change: a -wal that grew is still a valid WAL (SQLite stops
 * at the first incomplete or foreign frame), but a main file caught mid-checkpoint is not.
 */
async function copyDb(dbPath: string, tempRoot: string | undefined): Promise<Copy> {
  const root = tempRoot || fallbackRoot;
  await mkdir(root, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    await waitForJournal(dbPath);
    const before = await dbStamp(dbPath);
    if (before.size + before.walSize > limits.maxDbBytes) throw new DbTooLargeError(dbPath, before.size + before.walSize);
    const dir = await mkdtemp(join(root, 'cursor-db-'));
    const file = join(dir, 'snapshot.db');
    try {
      await copyOne(dbPath, file);
      if (before.walSize > 0) await copyOne(`${dbPath}-wal`, `${file}-wal`).catch(() => undefined); // checkpointed away meanwhile
    } catch (e) {
      await removeCopyDir(dir);
      throw e;
    }
    const after = await dbStamp(dbPath).catch(() => null);
    if (after && after.key === before.key) return { dir, file, stamp: before };
    const mainSame = after != null && after.size === before.size && after.mainMtimeMs === before.mainMtimeMs;
    if (attempt >= 1 && mainSame) return { dir, file, stamp: before };
    await removeCopyDir(dir);
    if (attempt >= 1) throw new Error("Cursor's chat database changed while it was being copied; it will be read again on its next change.");
    await delay(100);
  }
}

// ---------- snapshot cache ----------

export interface Snapshot {
  db: Database;
  stamp: DbStamp;
  /** The temp subfolder holding the copy: deleted when the snapshot is closed. */
  dir: string;
}

/** Every snapshot still open (cached, closing, or in a readOnce): closed at shutdown and exit. */
const live = new Set<Snapshot>();

function closeSnapshot(s: Snapshot): Promise<void> {
  live.delete(s);
  try {
    s.db.close();
  } catch {
    /* already closed */
  }
  return removeCopyDir(s.dir);
}

async function load(dbPath: string, tempRoot: string | undefined): Promise<Snapshot> {
  const { DatabaseSync } = await sqlite();
  const copy = await copyDb(dbPath, tempRoot);
  try {
    const snap: Snapshot = { db: new DatabaseSync(copy.file, { readOnly: true }), stamp: copy.stamp, dir: copy.dir };
    live.add(snap);
    return snap;
  } catch (e) {
    await removeCopyDir(copy.dir);
    throw e;
  }
}

interface CacheEntry {
  promise: Promise<Snapshot>;
  stampKey: string;
  loadedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, CacheEntry>();
/** Snapshots already dropped from the cache whose delayed close has not run yet. */
const closing = new Map<Snapshot, ReturnType<typeof setTimeout>>();

function closeEntry(path: string, entry: CacheEntry, delayMs = 1000): Promise<void> {
  if (entry.timer) clearTimeout(entry.timer);
  if (cache.get(path) === entry) cache.delete(path);
  // Close on a later macrotask by default: a caller that was just handed this snapshot uses it
  // synchronously after its await resumes, which always happens before timers run.
  return entry.promise.then(
    (s) => {
      if (delayMs <= 0) return closeSnapshot(s);
      if (closing.has(s)) return;
      const t = setTimeout(() => {
        closing.delete(s);
        void closeSnapshot(s);
      }, delayMs);
      t.unref?.();
      closing.set(s, t);
    },
    () => undefined,
  );
}

function touch(path: string, entry: CacheEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => void closeEntry(path, entry), IDLE_CLOSE_MS);
  entry.timer.unref?.();
  // Keep insertion order as recency order for the small LRU below.
  cache.delete(path);
  cache.set(path, entry);
}

/**
 * Returns a read-only snapshot (an open temp copy) of the database, reusing a cached one while the
 * files are unchanged. The copy goes into a fresh subfolder of tempRoot (a per-process folder in
 * the OS temp folder when not given) and is deleted when the snapshot is dropped. Callers must use
 * the Database synchronously (no awaits) after getting it: a later call may close a stale snapshot.
 */
export async function openSnapshot(dbPath: string, tempRoot?: string): Promise<Snapshot> {
  const now = await dbStamp(dbPath);
  const hit = cache.get(dbPath);
  if (hit) {
    const reuseBig = now.size > BIG_DB_BYTES && Date.now() - hit.loadedAt < BIG_DB_REUSE_MS;
    if (hit.stampKey === now.key || reuseBig) {
      touch(dbPath, hit);
      try {
        return await hit.promise;
      } catch {
        void closeEntry(dbPath, hit); // a failed load is not cached; fall through and retry once
      }
    } else {
      void closeEntry(dbPath, hit);
    }
  }
  const entry: CacheEntry = { promise: load(dbPath, tempRoot), stampKey: now.key, loadedAt: Date.now() };
  cache.set(dbPath, entry);
  touch(dbPath, entry);
  while (cache.size > MAX_CACHED) {
    const [oldest, e] = cache.entries().next().value as [string, CacheEntry];
    void closeEntry(oldest, e);
  }
  try {
    const snap = await entry.promise;
    entry.stampKey = snap.stamp.key;
    return snap;
  } catch (e) {
    void closeEntry(dbPath, entry);
    throw e;
  }
}

/** Copies and opens a snapshot outside the cache, runs fn on it, then closes and deletes it (small databases). */
export async function readOnce<T>(dbPath: string, fn: (db: Database) => T, tempRoot?: string): Promise<T> {
  const snap = await load(dbPath, tempRoot);
  try {
    return fn(snap.db);
  } finally {
    await closeSnapshot(snap);
  }
}

/** Closes every cached snapshot and deletes its temp copy (tests, shutdown). */
export async function closeAllSnapshots(): Promise<void> {
  const loading = [...cache.values()].map((e) => {
    if (e.timer) clearTimeout(e.timer);
    return e.promise.catch(() => undefined);
  });
  cache.clear();
  for (const t of closing.values()) clearTimeout(t);
  closing.clear();
  await Promise.all(loading);
  await Promise.all([...live].map(closeSnapshot));
}

// Last resort for snapshots still open at exit: close them (Windows cannot delete an open file),
// then delete their copies and the per-process fallback folder.
process.once('exit', () => {
  for (const s of live) {
    try {
      s.db.close();
    } catch {
      /* already closed */
    }
  }
  for (const p of [...[...live].map((s) => s.dir), fallbackRoot]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  live.clear();
});

// ---------- WAL replay (kept for the OpenCode adapter) ----------
//
// The Cursor adapter no longer uses this: SQLite reads the copied -wal itself. The OpenCode adapter
// (src/core/adapters/opencode/sqlite.ts) still imports it for its sql.js image; remove it once that
// adapter has moved to node:sqlite as well.

/** WAL checksum (sqlite.org/fileformat2.html#walformat): pairs of 32-bit words, native or big-endian. */
function walChecksum(buf: Buffer, start: number, end: number, bigEndian: boolean, s0: number, s1: number): [number, number] {
  for (let i = start; i < end; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

/**
 * Applies every committed, checksum-valid WAL frame to the database image, the way SQLite would
 * see it when reading. Returns the image unchanged when the WAL is empty, foreign or corrupt.
 * The image is patched in place when its size does not change, so pass a buffer you own.
 */
export function applyWal(dbImage: Buffer, wal: Buffer | undefined): Buffer {
  if (!wal || wal.length < 32) return dbImage;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return dbImage;
  const bigEndian = magic === 0x377f0683;
  const pageSize = wal.readUInt32BE(8) === 1 ? 65536 : wal.readUInt32BE(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return dbImage;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let [s0, s1] = walChecksum(wal, 0, 24, bigEndian, 0, 0);
  if (s0 !== wal.readUInt32BE(24) || s1 !== wal.readUInt32BE(28)) return dbImage;

  const pending = new Map<number, number>(); // page number -> frame data offset
  const committed = new Map<number, number>();
  let commitPages = 0;
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
    [s0, s1] = walChecksum(wal, off, off + 8, bigEndian, s0, s1);
    [s0, s1] = walChecksum(wal, off + 24, off + 24 + pageSize, bigEndian, s0, s1);
    if (s0 !== wal.readUInt32BE(off + 16) || s1 !== wal.readUInt32BE(off + 20)) break;
    pending.set(wal.readUInt32BE(off), off + 24);
    const dbPagesAfterCommit = wal.readUInt32BE(off + 4);
    if (dbPagesAfterCommit > 0) {
      for (const [pg, at] of pending) committed.set(pg, at);
      pending.clear();
      commitPages = dbPagesAfterCommit;
    }
  }
  if (!commitPages) return dbImage;

  // Same size (the usual case): patch the image in place instead of holding a second copy.
  let out = dbImage;
  if (dbImage.length !== commitPages * pageSize) {
    out = Buffer.alloc(commitPages * pageSize);
    dbImage.copy(out, 0, 0, Math.min(dbImage.length, out.length));
  }
  for (const [pg, at] of committed) {
    if (pg >= 1 && pg <= commitPages) wal.copy(out, (pg - 1) * pageSize, at, at + pageSize);
  }
  return out;
}

// ---------- query helpers ----------

export type Row = Record<string, SqlValue>;

export function all(db: Database, sql: string, params: SQLInputValue[] = []): Row[] {
  return db.prepare(sql).all(...params);
}

export function one(db: Database, sql: string, params: SQLInputValue[] = []): Row | undefined {
  return db.prepare(sql).get(...params);
}

export function tableNames(db: Database): Set<string> {
  return new Set(all(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name)));
}

/** Values are JSON stored as TEXT or as BLOB depending on the writer: decode both. */
export function asText(v: SqlValue | Uint8Array | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');
  return String(v);
}

/** JSON.parse that returns undefined instead of throwing. */
export function parseJson(v: SqlValue | string | undefined): unknown {
  const t = typeof v === 'string' ? v : asText(v as SqlValue | undefined);
  if (t == null || t === '') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}
