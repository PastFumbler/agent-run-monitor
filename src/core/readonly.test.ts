// Read-only guard (docs/PLAN.md 3.4). Two checks:
//  1. A source scan: no non-test file under src/core may call (or import) a writing fs API, open a
//     file with a flag other than 'r', or open a SQLite database itself. The single exception is
//     src/core/sqlite.ts, which copies databases into a temp folder to read them. (Settings are
//     written in src/main.)
//  2. A behaviour check of that exception: snapshotting a database writes only under the temp folder
//     it is given, creates nothing next to the source database, and leaves nothing behind on close.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { all, closeAllSnapshots, closeSnapshot, DbTooLargeError, each, one, openSnapshot, readOnce, snapshotDb, tableNames } from './sqlite';

const CORE = resolve(__dirname);
const ALLOWED = new Set(['sqlite.ts']); // relative to src/core, forward slashes

/** Writing fs APIs; each also matches its Sync variant, and fs.x / fsp.x / fs.promises.x calls. */
const WRITERS = [
  'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp', 'copyFile', 'cp',
  'createWriteStream', 'truncate', 'ftruncate', 'chmod', 'lchmod', 'fchmod', 'chown', 'lchown', 'fchown',
  'utimes', 'lutimes', 'futimes', 'symlink', 'link',
];
// Not listed: write / writev. They need a descriptor or FileHandle opened for writing, which the
// open() flag check below catches, and the bare names collide with StringDecoder.write and streams.
const WRITER_NAME = new RegExp(`^(?:${WRITERS.join('|')})(?:Sync)?$`);
const WRITER_CALL = new RegExp(`(?<![\\w$])(?:${WRITERS.join('|')})(?:Sync)?\\s*\\(`, 'g');
/** open / openSync / fs.promises.open, with its argument list (one level of nested parentheses). */
const OPEN_CALL = /(?<![\w$])open(?:Sync)?\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
/** { flags: 'w' } and the like on streams. */
const FLAGS_OPTION = /\bflags\s*:\s*(['"`])([^'"`]*)\1/g;
/** import { a, b as c } from 'fs' | 'node:fs' | 'fs/promises' | 'node:fs/promises'. */
const FS_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g;
const READ_FLAG = /^(['"`])r\1$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...sourceFiles(p));
    else if (d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') && !d.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Drops comments and blanks parentheses inside string, template and regex literals, so prose and
 * patterns never trip the scan while string values (flags, import sources) stay readable.
 */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  const literal = (body: string, q: string) => q + body.replace(/[()]/g, ' ') + q;
  /** Whether a '/' here starts a regex literal (rather than dividing), from what came before it. */
  const regexCanStart = () => {
    const before = out.trimEnd();
    const c = before.slice(-1);
    if (c === '' || '([{,;:=!&|?+-*%<>~^}'.includes(c)) return true;
    return /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(before);
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += literal(src.slice(i + 1, j), c);
      i = j + 1;
    } else if (c === '/' && regexCanStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      out += literal(src.slice(i + 1, j), '/');
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Splits a call's argument list at top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of args) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every writing fs use in a TypeScript source text. */
function findWrites(code: string): string[] {
  const src = codeOnly(code);
  const hits: string[] = [];
  for (const m of src.matchAll(WRITER_CALL)) hits.push(m[0].replace(/\s*\($/, ''));
  for (const m of src.matchAll(OPEN_CALL)) {
    const flag = splitArgs(m[1])[1];
    if (flag && !READ_FLAG.test(flag)) hits.push(`open(${flag})`);
  }
  for (const m of src.matchAll(FLAGS_OPTION)) if (m[2] !== 'r') hits.push(`flags: '${m[2]}'`);
  // A writer imported from fs counts even when it is only passed around, never called by name.
  for (const m of src.matchAll(FS_IMPORT))
    for (const spec of m[1].split(',')) {
      const name = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (WRITER_NAME.test(name)) hits.push(`import ${name}`);
    }
  if (/\bnew\s+DatabaseSync\s*\(/.test(src)) hits.push('new DatabaseSync');
  return hits;
}

describe('read-only guard: src/core never writes outside src/core/sqlite.ts', () => {
  it('the scanner catches the patterns it is meant to catch', () => {
    expect(findWrites("await writeFile(p, 'x');")).toEqual(['writeFile']);
    expect(findWrites('fs.renameSync(a, b); fsp.rm(dir, { recursive: true });')).toEqual(['renameSync', 'rm']);
    expect(findWrites("const fh = await open(p, 'w');")).toEqual(["open('w')"]);
    expect(findWrites("const fh = await open(join(dir, name), 'a+');")).toEqual(["open('a+')"]);
    expect(findWrites("createReadStream(p, { flags: 'a' })")).toEqual(["flags: 'a'"]);
    expect(findWrites('const db = new DatabaseSync(file);')).toEqual(['new DatabaseSync']);
    expect(findWrites('fs.linkSync(a, b); symlink(a, b); unlink(a)')).toEqual(['linkSync', 'symlink', 'unlink']);
    expect(findWrites("import { readFile, writeFile as wf } from 'node:fs/promises';")).toEqual(['import writeFile']);
    expect(findWrites("const re = /['\"]/; mkdirSync(dir);")).toEqual(['mkdirSync']);
    // Reads, look-alikes, comments, strings and regex literals are fine.
    expect(findWrites("await open(p, 'r'); await open(join(a, b), 'r'); await open(p); readFile(p); confirm(x); perform(y); format(z)")).toEqual([]);
    expect(findWrites("// writeFile(p)\n/* rm(dir) */ const s = 'never rename(x)';")).toEqual([]);
    expect(findWrites('const ok = /rename\\(x\\)/.test(s); const half = a / 2 / b;')).toEqual([]);
    expect(findWrites("stream.on('data', f); arr.copyWithin(0, 1); isOpen(x); import { readFile } from 'node:fs';")).toEqual([]);
  });

  it('finds no writing call in any non-test source file but src/core/sqlite.ts', () => {
    const files = sourceFiles(CORE);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(CORE, f).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const hits = findWrites(readFileSync(f, 'utf8'));
      if (hits.length) offenders.push(`src/core/${rel}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('src/core/sqlite.ts is the one exception and does write (so the scan is not vacuous)', () => {
    const hits = findWrites(readFileSync(join(CORE, 'sqlite.ts'), 'utf8'));
    expect(hits).toEqual(expect.arrayContaining(['mkdtemp', 'createWriteStream', 'rm', 'new DatabaseSync']));
  });
});

// ---------- src/core/sqlite.ts writes only under the temp folder it is given ----------

/** Every file and folder under root, with size and mtime, as a sorted list of lines. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      const rel = relative(root, p).split(sep).join('/');
      if (d.isDirectory()) {
        out.push(`${rel}/`);
        walk(p);
      } else {
        const s = statSync(p);
        out.push(`${rel} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('src/core/sqlite.ts snapshots', () => {
  let work: string;
  let dbFile: string;
  let live: DatabaseSync;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'arm-readonly-'));
    const srcDir = join(work, 'agent-data');
    mkdirSync(srcDir);
    dbFile = join(srcDir, 'state.db');
    // A live WAL database with rows still only in the -wal (as an agent leaves it while running).
    live = new DatabaseSync(dbFile);
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    live.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
    live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const ins = live.prepare('INSERT INTO kv VALUES (?, ?)');
    for (let i = 0; i < 50; i++) ins.run(`k${String(i).padStart(2, '0')}`, `value ${i}`);
  });

  afterAll(async () => {
    await closeAllSnapshots();
    live.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('writes only under the given temp folder, nothing next to the source, and nothing after close', async () => {
    const temp = join(work, 'temp');
    const before = tree(work);
    expect(before.some((l) => l.startsWith('agent-data/state.db-wal '))).toBe(true);

    const snap = await snapshotDb(dbFile, { tempDir: temp });
    expect(one(snap.db, 'SELECT COUNT(*) AS n FROM kv')?.n).toBe(50); // rows only in the -wal are seen
    const during = tree(work);
    // Nothing next to the source changed (names, sizes, mtimes); everything new is under temp/.
    expect(before.filter((l) => !during.includes(l))).toEqual([]);
    const added = during.filter((l) => !before.includes(l));
    expect(added.filter((l) => !l.startsWith('temp/'))).toEqual([]);
    expect(added.some((l) => /^temp\/sqlite-[^/]+\/snapshot\.db /.test(l))).toBe(true);
    expect(added.some((l) => /^temp\/sqlite-[^/]+\/snapshot\.db-wal /.test(l))).toBe(true); // the -wal was copied too

    await closeSnapshot(snap);
    expect(tree(work)).toEqual([...before, 'temp/'].sort());
  });

  it('caches snapshots per database and deletes them on closeAllSnapshots', async () => {
    const temp = join(work, 'temp-cache');
    const a = await openSnapshot(dbFile, { tempDir: temp });
    const b = await openSnapshot(dbFile, { tempDir: temp });
    expect(b).toBe(a);
    expect(readdirSync(temp)).toHaveLength(1);
    // The source changes: a new snapshot is copied and sees the new row.
    live.prepare('INSERT INTO kv VALUES (?, ?)').run('new', 'row');
    const c = await openSnapshot(dbFile, { tempDir: temp });
    expect(c).not.toBe(a);
    expect(one(c.db, 'SELECT value FROM kv WHERE key = ?', ['new'])?.value).toBe('row');
    await closeAllSnapshots();
    expect(readdirSync(temp)).toEqual([]);
  });

  it('readOnce cleans up after itself, and the query helpers work', async () => {
    const temp = join(work, 'temp-once');
    const res = await readOnce(
      dbFile,
      (db) => {
        const keys: string[] = [];
        each(db, 'SELECT key FROM kv WHERE key < ? ORDER BY key', ['k03'], (r) => keys.push(String(r.key)));
        return { tables: [...tableNames(db)], rows: all(db, 'SELECT key FROM kv ORDER BY key LIMIT 2').map((r) => r.key), keys };
      },
      { tempDir: temp },
    );
    expect(res).toEqual({ tables: ['kv'], rows: ['k00', 'k01'], keys: ['k00', 'k01', 'k02'] });
    expect(readdirSync(temp)).toEqual([]);
  });

  it('refuses a database over the size limit with a plain message, copying nothing', async () => {
    const temp = join(work, 'temp-big');
    const err = await snapshotDb(dbFile, { tempDir: temp, maxBytes: 1024, label: 'This test database' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbTooLargeError);
    expect((err as Error).message).toBe('This test database is 0.0 GB, more than the 0.0 GB this app will copy to read it safely, so it is skipped.');
    expect(readdirSync(temp)).toEqual([]);
  });
});
