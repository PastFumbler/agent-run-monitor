// Read-only snapshots of opencode.db, through the shared helper in src/core/sqlite.ts.
//
// The database is never opened by a SQLite engine in place: the db and its -wal (never -shm) are
// copied into a fresh subfolder of the app's temp folder and the copy is opened read-only with
// node:sqlite, which replays the copied -wal itself. OpenCode runs in WAL mode (busy_timeout 5000,
// synchronous NORMAL) [SRC], so recent rows often live only in the -wal file. Snapshots are cached
// per file while its size and mtime stay the same, so listing sessions and parsing each of them
// copies the database once.

import { all, openSnapshot, type Database, type DbStamp, type SqlValue } from '../../sqlite';

export { all, asText, closeAllSnapshots, each, one, parseJson, tableNames, type Database, type DbStamp, type Row, type SqlValue } from '../../sqlite';

/**
 * Runs `fn` on a read-only snapshot of the database, copied into tempDir (a per-process folder
 * under the OS temp folder when not given). `fn` must be synchronous: the snapshot may be closed
 * once a newer one replaces it.
 */
export async function withDb<T>(dbPath: string, tempDir: string | undefined, fn: (db: Database, stamp: DbStamp) => T): Promise<T> {
  const snap = await openSnapshot(dbPath, { tempDir, label: 'This OpenCode database' });
  return fn(snap.db, snap.stamp);
}

/**
 * The wanted columns that exist in `table`, as a SELECT list. Column sets differ between OpenCode
 * releases (early 1.2.x had no per-session token totals [UNVERIFIED which version]), and SELECT *
 * would drag large columns such as summary_diffs along.
 */
export function pick(db: Database, table: string, wanted: readonly string[]): string {
  const have = new Set(all(db, `PRAGMA table_info(${table})`).map((r) => String(r.name)));
  const cols = wanted.filter((c) => have.has(c));
  return cols.length ? cols.join(', ') : 'NULL AS none';
}

export function asNum(v: SqlValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
