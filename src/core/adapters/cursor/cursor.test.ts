// Cursor adapter tests. SQLite databases are built at runtime with node:sqlite in os.tmpdir() from
// the JSON fixtures in test/fixtures/cursor; nothing else is written.

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscoverContext, Env, ParseContext, ParseState, SessionRef } from '../../adapter';
import { runId, safeParse, toSummary } from '../../build';
import type { NewEvent } from '../../events';
import { judgeStatus } from '../../status';
import { adapter, closeAllSnapshots, defaultRoots } from './index';
import { parseTimestampTag, uriToPath } from './common';
import { fallbackTempRoot, limits } from '../../sqlite';

const FIX = resolve(__dirname, '../../../../test/fixtures/cursor');
const env: Env = { platform: 'linux', home: '/home/alex', vars: {} };
/** Where discovery copies databases when DiscoverContext has no tempDir: see src/core/sqlite.ts. */
const FALLBACK_TEMP = fallbackTempRoot;

const ID_A = '3f6c1a2e-8b4d-4e7a-9c15-2d7e8f0a1b34'; // completed agent run
const ID_B = '7a2e9d41-5c3b-4f86-a0e2-91c4b7d3e5f6'; // waiting for approval
const ID_C = 'c4d8e2f1-6a9b-4c3d-8e7f-0a1b2c3d4e5f'; // stopped by the user
const ID_LEGACY = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STORE_ID = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091';
const TRANSCRIPT_ID = 'e8f7a6b5-c4d3-4e2f-9a1b-0c9d8e7f6a5b';
const SUB_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

let work: string;
let ctx: ParseContext;
let userDir: string;
let dotDir: string;

const counts = (events: NewEvent[]) => events.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
const kv = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { key: string; value: string }];
      } catch {
        return []; // the corrupt fixture's garbage and cut lines cannot be rows
      }
    });

interface Writer {
  run(sql: string, params?: unknown[]): void;
}

/** Writes a fresh rollback-journal database (no -wal left behind) with node:sqlite. */
function writeDb(file: string, build: (db: Writer) => void) {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  try {
    const bind = (v: unknown): SQLInputValue => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : (v as SQLInputValue));
    build({ run: (sql, params = []) => void db.prepare(sql).run(...params.map(bind)) });
  } finally {
    db.close();
  }
}

function writeGlobalDb(file: string, kvFile: string) {
  writeDb(file, (db) => {
    db.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.run('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.run(
      'CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT)',
    );
    for (const r of kv(kvFile)) db.run('INSERT INTO cursorDiskKV VALUES (?, ?)', [r.key, r.value]);
    const headers = readFileSync(join(FIX, 'composer/globalStorage.ItemTable.composer.composerHeaders.json'), 'utf8');
    db.run('INSERT INTO ItemTable VALUES (?, ?)', ['composer.composerHeaders', headers]);
    for (const line of readFileSync(join(FIX, 'composer/globalStorage.composerHeaders-table.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const h = JSON.parse(line);
      db.run('INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?,?,?,?)', [
        h.composerId, h.workspaceId, h.createdAt, h.lastUpdatedAt, h.isArchived, h.isSubagent, h.recency, h.checkpointAt, h.value, h.subagentTypeName,
      ]);
    }
  });
}

function writeStoreDb(file: string) {
  const rows = JSON.parse(readFileSync(join(FIX, 'store-db/chats/df103048433a3561eb31c18898184d2b', STORE_ID, 'store.db.rows.json'), 'utf8'));
  writeDb(file, (db) => {
    db.run('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    for (const m of rows.meta) db.run('INSERT INTO meta VALUES (?, ?)', [m.key, m.value]);
    for (const b of rows.blobs) {
      const data = b.data_hex ? Buffer.from(b.data_hex, 'hex') : Buffer.from(JSON.stringify(b.data_utf8_json), 'utf8');
      db.run('INSERT INTO blobs VALUES (?, ?)', [b.id, new Uint8Array(data)]);
    }
  });
}

/** A fake Linux home: ~/.config/Cursor/User (Composer store) and ~/.cursor (CLI + transcripts). */
function buildHome(root: string) {
  userDir = join(root, '.config/Cursor/User');
  dotDir = join(root, '.cursor');
  writeGlobalDb(join(userDir, 'globalStorage/state.vscdb'), join(FIX, 'composer/globalStorage.cursorDiskKV.jsonl'));
  const ws = join(userDir, 'workspaceStorage/9b1d4f6e2a7c3e58b0d1f2a3c4e5d6f7');
  mkdirSync(ws, { recursive: true });
  cpSync(join(FIX, 'composer/workspaceStorage/9b1d4f6e2a7c3e58b0d1f2a3c4e5d6f7/workspace.json'), join(ws, 'workspace.json'));
  const items = JSON.parse(readFileSync(join(FIX, 'composer/workspaceStorage/9b1d4f6e2a7c3e58b0d1f2a3c4e5d6f7/ItemTable.legacy-2.x.json'), 'utf8'));
  writeDb(join(ws, 'state.vscdb'), (db) => {
    db.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    for (const [k, v] of Object.entries(items)) db.run('INSERT INTO ItemTable VALUES (?, ?)', [k, JSON.stringify(v)]);
  });
  const sess = join(dotDir, 'chats/df103048433a3561eb31c18898184d2b', STORE_ID);
  mkdirSync(sess, { recursive: true });
  cpSync(join(FIX, 'store-db/chats/df103048433a3561eb31c18898184d2b', STORE_ID, 'meta.json'), join(sess, 'meta.json'));
  writeStoreDb(join(sess, 'store.db'));
  cpSync(join(FIX, 'transcripts'), join(dotDir, 'projects'), { recursive: true });
}

const dctx = (since = 0): DiscoverContext => ({ env, since, projectRoots: [] });

async function refs(since = 0) {
  return adapter.discover([userDir, dotDir], dctx(since));
}

async function parseRef(match: (r: SessionRef) => boolean, prev?: ParseState) {
  const ref = (await refs()).find(match);
  if (!ref) throw new Error('ref not found');
  return { ref, st: await safeParse(adapter, ref, prev, ctx) };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'arm-cursor-test-'));
  ctx = { env, tempDir: join(work, 'scratch') };
  mkdirSync(ctx.tempDir);
  buildHome(join(work, 'home'));
});

afterAll(async () => {
  await closeAllSnapshots();
  rmSync(work, { recursive: true, force: true });
});

describe('defaultRoots', () => {
  it('follows each OS layout and XDG_CONFIG_HOME', () => {
    expect(defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' } })).toEqual([
      'C:\\Users\\alex\\AppData\\Roaming\\Cursor\\User',
      'C:\\Users\\alex\\.cursor',
    ]);
    expect(defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: {} })).toEqual(['/Users/alex/Library/Application Support/Cursor/User', '/Users/alex/.cursor']);
    expect(defaultRoots({ platform: 'linux', home: '/home/alex', vars: { XDG_CONFIG_HOME: '/home/alex/.cfg' } })).toEqual([
      '/home/alex/.cfg/Cursor/User',
      '/home/alex/.cursor',
      '/home/alex/.cfg/cursor',
    ]);
  });
});

describe('discover', () => {
  it('finds composers, legacy tabs, CLI sessions and transcripts, without throwing on missing roots', async () => {
    const found = await adapter.discover([userDir, dotDir, join(work, 'nope')], dctx());
    const composer = found.filter((r) => r.hint?.kind === 'composer').map((r) => r.subId).sort();
    expect(composer).toEqual([ID_LEGACY, ID_A, ID_B, ID_C].sort());
    expect(found.filter((r) => r.hint?.kind === 'aichat')).toHaveLength(1);
    expect(found.filter((r) => r.hint?.kind === 'store').map((r) => r.hint?.session)).toEqual([STORE_ID]);
    const transcripts = found.filter((r) => r.hint?.kind === 'transcript').map((r) => r.hint?.session).sort();
    expect(transcripts).toEqual(['agent-transcript-corrupt', SUB_ID, TRANSCRIPT_ID].sort());
    expect(found).toHaveLength(9);
    const a = found.find((r) => r.subId === ID_A)!;
    expect(a.hint?.projectPath).toBe('/home/alex/todo-cli');
    expect(a.mtimeMs).toBe(1789999408000);
    // Pre-3.0 composer: project comes from the workspace that listed it.
    expect(found.find((r) => r.subId === ID_LEGACY)?.hint?.projectPath).toBe('/home/alex/todo-cli');
    expect(await adapter.discover([join(work, 'missing')], dctx())).toEqual([]);
  });

  it('honours since', async () => {
    const found = await refs(1789999425000);
    expect(found.filter((r) => r.hint?.kind === 'composer').map((r) => r.subId)).toEqual([ID_C]);
    expect(found.some((r) => r.hint?.kind === 'aichat')).toBe(false);
    expect(found.some((r) => r.hint?.kind === 'transcript')).toBe(true); // written just now
    expect((await refs(Date.now() + 60_000)).length).toBe(0);
  });

  it('skips transcripts whose chat the Composer store already shows', async () => {
    const home = join(work, 'dupe');
    cpSync(join(work, 'home'), home, { recursive: true });
    const dir = join(home, '.cursor/projects/home-alex-todo-cli/agent-transcripts', ID_A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID_A}.jsonl`), '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    const found = await adapter.discover([join(home, '.config/Cursor/User'), join(home, '.cursor')], dctx());
    expect(found.filter((r) => r.subId === ID_A || r.hint?.session === ID_A)).toHaveLength(1);
  });
});

describe('composer store', () => {
  it('parses a completed agent run', async () => {
    const { ref, st } = await parseRef((r) => r.subId === ID_A);
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add --done flag to list command'); // Cursor's own chat name, not the prompt
    expect(r.projectName).toBe('todo-cli');
    expect(r.projectPath).toBe('/home/alex/todo-cli');
    expect(r.gitBranch).toBe('feature/done-flag');
    expect(r.model).toBe('claude-4.5-sonnet');
    expect(r.inputTokens).toBe(21877);
    expect(r.outputTokens).toBe(412);
    expect(counts(r.events)).toEqual({ user: 1, reasoning: 1, assistant: 2, tool_call: 5, tool_result: 5 });
    expect(r.events.some((e) => e.text.includes('regenerated'))).toBe(false); // orphan bubble ignored
    for (const call of r.events.filter((e) => e.kind === 'tool_call')) {
      expect(r.events.filter((e) => e.kind === 'tool_result' && e.toolCallId === call.toolCallId)).toHaveLength(1);
    }
    const failed = r.events.find((e) => e.kind === 'tool_result' && e.isError);
    expect(failed?.toolCallId).toBe('toolu_01SYNTHterminal0000000003');
    expect(failed?.text).toContain('Command exited with code 1');
    expect(r.tally.errors).toBe(1);
    expect(Object.keys(r.files)).toEqual(['/home/alex/todo-cli/todo/cli.py']);
    expect(r.files['/home/alex/todo-cli/todo/cli.py']).toMatchObject({ ops: ['edit'], count: 2 });
    expect(r.events.find((e) => e.toolName === 'run_terminal_cmd')?.toolKind).toBe('run');
    expect(r.turn).toBe('completed');
    expect(r.openTool).toBeUndefined();
    expect(r.startedAt).toBe(Date.parse('2026-09-21T14:03:00.000Z'));
    const last = Math.max(r.lastEventAt!, ref.mtimeMs);
    expect(judgeStatus(r, ref.mtimeMs, last + 60_000).status).toBe('idle');
    expect(judgeStatus(r, ref.mtimeMs, last + 10 * 60_000).status).toBe('done');
  });

  it('reads a pending tool that needs approval as waiting', async () => {
    const { ref, st } = await parseRef((r) => r.subId === ID_B);
    expect(st.run.turn).toBe('waiting_input');
    expect(st.run.turnDetail).toContain('rm -rf migrations');
    expect(st.run.openTool).toEqual({ name: 'run_terminal_cmd', kind: 'run', since: Date.parse('2026-09-21T14:03:43.000Z') });
    expect(st.run.model).toBe('auto');
    expect(judgeStatus(st.run, ref.mtimeMs, ref.mtimeMs + 30_000).status).toBe('waiting');
  });

  it('reads a user abort as aborted, not as an error', async () => {
    const { st } = await parseRef((r) => r.subId === ID_C);
    expect(st.run.turn).toBe('aborted');
    expect(st.run.tally.errors).toBe(0);
    expect(counts(st.run.events)).toEqual({ user: 1, system: 1 });
    expect(st.run.model).toBe('gpt-5');
  });

  it('parses legacy inline composers and chat-panel tabs', async () => {
    const legacy = (await parseRef((r) => r.subId === ID_LEGACY)).st.run;
    expect(legacy.title).toBe('What does store.load() return?');
    expect(legacy.projectName).toBe('todo-cli');
    expect(counts(legacy.events)).toEqual({ user: 1, assistant: 1 });
    expect(legacy.turn).toBe('completed');
    const tab = (await parseRef((r) => r.hint?.kind === 'aichat')).st.run;
    expect(tab.title).toBe('store.load return type'); // the tab's chatTitle
    expect(counts(tab.events)).toEqual({ user: 1, assistant: 1 });
  });

  it('returns prev unchanged when the database did not change, and leaves no temp files', async () => {
    const { ref, st } = await parseRef((r) => r.subId === ID_A);
    const again = await adapter.parse(ref, st, ctx);
    expect(again).toBe(st);
    // Cached snapshots are temp copies; closing them deletes the copies (with their -wal/-shm).
    await closeAllSnapshots();
    expect(readdirSync(ctx.tempDir)).toEqual([]);
    expect(existsSync(FALLBACK_TEMP)).toBe(false);
    // A parse with nothing cached copies into ctx.tempDir, one fresh subfolder per snapshot.
    expect((await adapter.parse(ref, undefined, ctx)).run.title).toBe(st.run.title);
    const [sub] = readdirSync(ctx.tempDir);
    expect(readdirSync(join(ctx.tempDir, sub))).toEqual(['snapshot.db']);
    await closeAllSnapshots();
    expect(readdirSync(ctx.tempDir)).toEqual([]);
    expect(readdirSync(join(userDir, 'globalStorage')).sort()).toEqual(['state.vscdb']); // no -shm/-wal created
  });

  it('survives the corrupt fixture: bad rows are skipped, good bubbles kept', async () => {
    const dir = join(work, 'corrupt/User');
    writeGlobalDb(join(dir, 'globalStorage/state.vscdb'), join(FIX, 'composer/globalStorage.cursorDiskKV-corrupt.jsonl'));
    const found = await adapter.discover([dir], dctx());
    const ref = found.find((r) => r.subId === ID_A)!;
    const st = await safeParse(adapter, ref, undefined, ctx);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(5); // bubble 5 truncated, bubbles 6-9 missing
    expect(counts(st.run.events)).toEqual({ user: 1, reasoning: 1, assistant: 1, tool_call: 1, tool_result: 1 });
  });

  it('turns a database that is not SQLite into one unreadable run', async () => {
    const dir = join(work, 'garbage/User/globalStorage');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.vscdb'), 'this is not a database at all, just text '.repeat(200));
    const found = await adapter.discover([join(work, 'garbage/User')], dctx());
    expect(found).toHaveLength(1);
    const st = await safeParse(adapter, found[0], undefined, ctx);
    expect(st.run.readError).toBeTruthy();
    // A composer ref pointing at it also degrades instead of throwing.
    const bad = await safeParse(adapter, { ...found[0], subId: ID_A, hint: { kind: 'composer' } }, undefined, ctx);
    expect(bad.run.readError).toBeTruthy();
  });

  it('refuses databases above the memory limit with a reason', async () => {
    const old = limits.maxDbBytes;
    limits.maxDbBytes = 1024;
    try {
      const dir = join(work, 'big/User');
      writeGlobalDb(join(dir, 'globalStorage/state.vscdb'), join(FIX, 'composer/globalStorage.cursorDiskKV.jsonl'));
      const found = await adapter.discover([dir], dctx());
      expect(found).toHaveLength(1);
      const st = await safeParse(adapter, found[0], undefined, ctx);
      expect(st.run.readError).toMatch(/more than the .* GB this app will copy/);
    } finally {
      limits.maxDbBytes = old;
    }
  });

  it('sets readError when no bubble is recognisable', async () => {
    const dir = join(work, 'unknown/User');
    const file = join(work, 'unknown-kv.jsonl');
    const cd = { _v: 99, fullConversationHeadersOnly: [{ bubbleId: 'x1' }, { bubbleId: 'x2' }], createdAt: 1789999380000 };
    writeFileSync(
      file,
      [
        { key: 'composerData:u1', value: JSON.stringify(cd) },
        { key: 'bubbleId:u1:x1', value: JSON.stringify({ type: 7, payload: 'new' }) },
        { key: 'bubbleId:u1:x2', value: JSON.stringify({ kind: 'hologram' }) },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    writeGlobalDb(join(dir, 'globalStorage/state.vscdb'), file);
    const ref = (await adapter.discover([dir], dctx())).find((r) => r.subId === 'u1')!;
    const st = await safeParse(adapter, ref, undefined, ctx);
    expect(st.run.readError).toMatch(/No records this app recognises/);
    expect(st.run.skipped).toBe(2);
  });

  it('treats a rejected call as finished, falls back to the prompt for placeholder names, and anchors relative paths', async () => {
    const dir = join(work, 'reject/User');
    const file = join(work, 'reject-kv.jsonl');
    const cd = {
      _v: 13,
      name: 'New Chat',
      gitWorktree: { worktreePath: '/home/alex/todo-cli', branchName: 'tidy' },
      createdAt: 1789999380000,
      lastUpdatedAt: 1789999390000,
      fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }],
    };
    const edit = (id: string, extra: object) => ({
      type: 2,
      bubbleId: id,
      toolFormerData: { toolCallId: `call-${id}`, name: 'edit_file', params: JSON.stringify({ relativeWorkspacePath: 'src/app.ts' }), ...extra },
    });
    writeFileSync(
      file,
      [
        { key: 'composerData:r1', value: JSON.stringify(cd) },
        { key: 'bubbleId:r1:b1', value: JSON.stringify({ type: 1, bubbleId: 'b1', text: 'Tidy up src/app.ts please' }) },
        { key: 'bubbleId:r1:b2', value: JSON.stringify(edit('b2', { result: JSON.stringify({ diff: { chunks: [] } }), status: 'completed' })) },
        { key: 'bubbleId:r1:b3', value: JSON.stringify(edit('b3', { additionalData: { userDecision: 'rejected' } })) },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    writeGlobalDb(join(dir, 'globalStorage/state.vscdb'), file);
    const ref = (await adapter.discover([dir], dctx())).find((r) => r.subId === 'r1')!;
    expect(ref.hint?.title).toBeUndefined(); // "New Chat" is a placeholder, not a name
    expect(ref.hint?.projectPath).toBe('/home/alex/todo-cli'); // gitWorktree, pulled out by the listing query
    const r = (await safeParse(adapter, ref, undefined, ctx)).run;
    expect(r.title).toBe('Tidy up src/app.ts please');
    expect(r.turn).toBe('completed'); // the rejected edit is not left open
    expect(r.openTool).toBeUndefined();
    expect(r.events.filter((e) => e.kind === 'tool_result').map((e) => e.text)).toContain('Rejected by you');
    // Only the applied edit counts as a file change; the relative path is anchored to the project.
    expect(r.files).toEqual({ '/home/alex/todo-cli/src/app.ts': expect.objectContaining({ count: 1 }) });
  });

  it('sees rows that are still only in the -wal file', async () => {
    const dir = join(work, 'wal/User/globalStorage');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.vscdb');
    const live = new DatabaseSync(file);
    try {
      live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      live.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
      live.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // the table is in the main file; rows go to the WAL
      const ins = live.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
      for (const r of kv(join(FIX, 'composer/globalStorage.cursorDiskKV.jsonl'))) ins.run(r.key, r.value);
      expect(readdirSync(dir)).toContain('state.vscdb-wal');
      const found = await adapter.discover([join(work, 'wal/User')], dctx());
      expect(found.filter((r) => r.hint?.kind === 'composer')).toHaveLength(4);
      const st = await safeParse(adapter, found.find((r) => r.subId === ID_A)!, undefined, ctx);
      expect(st.run.tally.toolCalls).toBe(5);
      // Read-only: nothing appeared next to the live database, and the temp copies go on close.
      expect(readdirSync(dir).sort()).toEqual(['state.vscdb', 'state.vscdb-shm', 'state.vscdb-wal']);
      await closeAllSnapshots();
      expect(readdirSync(ctx.tempDir)).toEqual([]);
      expect(existsSync(FALLBACK_TEMP)).toBe(false);
    } finally {
      live.close();
    }
  });
});

describe('composer sub-agents', () => {
  it('links a sub-agent composer to its parent composer in the same database', async () => {
    const SUB = 'task-toolu_01SYNTHsubagent000000007'; // its header names ID_A as parentComposerId
    const dir = join(work, 'subagents/User');
    const file = join(work, 'subagents-kv.jsonl');
    const sub = (id: string, extra: object) => [
      { key: `composerData:${id}`, value: JSON.stringify({ _v: 13, createdAt: 1789999385000, lastUpdatedAt: 1789999388000, fullConversationHeadersOnly: [{ bubbleId: 's1', type: 1 }], ...extra }) },
      { key: `bubbleId:${id}:s1`, value: JSON.stringify({ type: 1, bubbleId: 's1', text: 'Explore the test layout' }) },
    ];
    const rows = [
      ...kv(join(FIX, 'composer/globalStorage.cursorDiskKV.jsonl')),
      ...sub(SUB, {}),
      // No header: the parent comes from composerData.subagentInfo.
      ...sub('sub-2', { subagentInfo: { parentComposerId: ID_B, toolCallId: 'toolu_2' } }),
    ];
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
    writeGlobalDb(join(dir, 'globalStorage/state.vscdb'), file);
    const found = await adapter.discover([dir], dctx());
    const byId = (id: string) => found.find((r) => r.subId === id)!;
    expect(byId(SUB).hint).toMatchObject({ subagent: '1', parent: ID_A });
    for (const [child, parent] of [[SUB, ID_A], ['sub-2', ID_B]]) {
      const st = await safeParse(adapter, byId(child), undefined, ctx);
      expect(st.run.parentPath).toBe(byId(child).path);
      expect(st.run.parentSubId).toBe(parent);
      expect(toSummary(byId(child), st, Date.now(), false).parentId).toBe(runId(byId(parent)));
    }
    const top = await safeParse(adapter, byId(ID_A), undefined, ctx);
    expect(top.run.parentSubId).toBeUndefined();
    expect(toSummary(byId(ID_A), top, Date.now(), false).parentId).toBeUndefined();
  });
});

describe('cursor-agent CLI store', () => {
  it('walks the blob tree and reads meta.json', async () => {
    const { ref, st } = await parseRef((r) => r.hint?.kind === 'store');
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add done flag'); // meta.name
    expect(r.projectPath).toBe('/home/alex/todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.model).toBe('gpt-5.4-high');
    expect(counts(r.events)).toEqual({ user: 1, assistant: 1, tool_call: 2, tool_result: 1, reasoning: 1 });
    expect(r.events.find((e) => e.kind === 'tool_result')?.toolCallId).toBe('call_SYNTH0001');
    expect(Object.keys(r.files)).toEqual(['/home/alex/todo-cli/todo/cli.py']);
    expect(r.turn).toBe('in_progress');
    expect(r.openTool).toEqual({ name: 'StrReplace', kind: 'edit', since: 1790000655000 });
    expect(r.startedAt).toBe(1790000590000);
    // In progress and recently written: running.
    const quiet = { ...ref, mtimeMs: 1790000655000 };
    expect(judgeStatus(r, quiet.mtimeMs, 1790000655000 + 60_000).status).toBe('running');
  });
});

describe('cursor-agent CLI store, other shapes', () => {
  it('reads AI SDK error outputs as failed results and does not scan JSON leaves for refs', async () => {
    const sess = join(work, 'store2/chats/abc/s2');
    mkdirSync(sess, { recursive: true });
    const sha = (n: number) => n.toString(16).padStart(64, '0');
    const node = Buffer.concat([1, 2, 3, 4].map((n) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(sha(n), 'hex')])));
    // A non-message JSON leaf whose text happens to contain 0x0a 0x20 sequences (pretty-printed).
    const odd = Buffer.from(JSON.stringify({ kind: 'checkpoint', note: 'x' }, null, 1));
    const blobs: [string, Buffer][] = [
      [sha(99), node],
      [sha(1), Buffer.from(JSON.stringify({ role: 'user', content: 'Run the tests' }))],
      [sha(2), Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'Shell', args: { command: 'npm test' } }] }))],
      [sha(3), Buffer.from(JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Shell', output: { type: 'error-text', value: 'exit 1' } }] }))],
      [sha(4), odd],
    ];
    const meta = Buffer.from(JSON.stringify({ agentId: 's2', latestRootBlobId: sha(99), name: 'New Agent', createdAt: 1790000000000 })).toString('hex');
    writeDb(join(sess, 'store.db'), (db) => {
      db.run('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
      db.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      db.run('INSERT INTO meta VALUES (?, ?)', ['0', meta]);
      for (const [id, d] of blobs) db.run('INSERT INTO blobs VALUES (?, ?)', [id, new Uint8Array(d)]);
    });
    const ref = (await adapter.discover([join(work, 'store2')], dctx()))[0];
    const r = (await safeParse(adapter, ref, undefined, ctx)).run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Run the tests'); // "New Agent" is a placeholder
    const res = r.events.find((e) => e.kind === 'tool_result');
    expect(res).toMatchObject({ toolCallId: 'c1', isError: true, text: 'exit 1' });
    expect(r.tally.errors).toBe(1);
    expect(r.skipped).toBe(1); // the checkpoint leaf, counted once, not walked
    expect(r.turn).toBe('in_progress'); // last message is a tool result: the agent should go on
  });
});

describe('agent transcripts', () => {
  const MAIN = join(FIX, 'transcripts/home-alex-todo-cli/agent-transcripts', TRANSCRIPT_ID, `${TRANSCRIPT_ID}.jsonl`);

  it('parses a two-turn transcript that ends in a provider error', async () => {
    const { ref, st } = await parseRef((r) => r.hint?.session === TRANSCRIPT_ID);
    const r = st.run;
    expect(r.title).toBe('Add a --done flag to the `todo list` command so finished items can be hidden.');
    expect(r.projectName).toBe('todo-cli');
    expect(counts(r.events)).toEqual({ user: 2, assistant: 4, tool_call: 7, error: 1 });
    expect(r.events.some((e) => e.text.includes('[REDACTED]'))).toBe(false);
    expect(r.files).toMatchObject({
      '/home/alex/todo-cli/todo/cli.py': { ops: ['edit'], count: 1 },
      '/home/alex/todo-cli/tests/test_done_flag.py': { ops: ['create'], count: 1 },
    });
    expect(r.events.find((e) => e.toolName === 'Shell')?.toolKind).toBe('run');
    expect(r.events.find((e) => e.kind === 'user')?.ts).toBe(Date.parse('2026-09-21T14:03:00Z'));
    expect(r.turn).toBe('error');
    expect(r.turnDetail).toContain('Provider Error');
    expect(r.openTool).toBeUndefined();
    expect(judgeStatus(r, ref.mtimeMs, ref.mtimeMs + 1000).status).toBe('failed');
  });

  it('links sub-agent transcripts to their parent', async () => {
    const { ref, st } = await parseRef((r) => r.hint?.session === SUB_ID);
    expect(st.run.parentPath).toMatch(new RegExp(`${TRANSCRIPT_ID}\\.jsonl$`));
    expect(st.run.turn).toBe('completed');
    expect(st.run.title).toBe('List every test module under tests/ and summarise what each covers.');
    expect(st.run.events.find((e) => e.kind === 'tool_call')?.toolKind).toBe('search');
    expect(judgeStatus(st.run, ref.mtimeMs, ref.mtimeMs + 10 * 60_000).status).toBe('done');
  });

  it('skips garbage lines in the corrupt fixture and keeps the good ones', async () => {
    const { st } = await parseRef((r) => r.hint?.session === 'agent-transcript-corrupt');
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(1);
    expect(counts(st.run.events)).toEqual({ user: 1, assistant: 1, tool_call: 2 });
    expect(st.offset).toBeLessThan(st.size); // the cut last line waits for the rest
    // Two tool calls in a row, the last one not followed by anything yet: open, so running.
    expect(st.run.openTool?.name).toBe('Grep');
    expect(judgeStatus(st.run, st.mtimeMs, st.mtimeMs + 1000).status).toBe('running');
  });

  it('flags a file with only unknown record types', async () => {
    const file = join(work, 'only-unknown.jsonl');
    writeFileSync(file, '{"type":"hologram","x":1}\n{"kind":"mystery"}\n');
    const st = await safeParse(adapter, { agent: 'cursor', path: file, mtimeMs: 0, size: 10, hint: { kind: 'transcript' } }, undefined, ctx);
    expect(st.run.readError).toMatch(/No records this app recognises/);
    expect(st.run.skipped).toBe(2);
  });

  it('continues from the previous offset, across a split line', async () => {
    const text = readFileSync(MAIN, 'utf8');
    const lines = text.split('\n').filter(Boolean).map((l) => `${l}\n`);
    const file = join(work, 'grow.jsonl');
    const ref: SessionRef = { agent: 'cursor', path: file, mtimeMs: 0, size: 0, hint: { kind: 'transcript', project: 'todo-cli' } };
    writeFileSync(file, lines.slice(0, 6).join(''));
    const first = await adapter.parse(ref, undefined, ctx);
    expect(first.run.events.length).toBeGreaterThan(0);
    const middle = lines.slice(6, 10).join('') + lines[10].slice(0, 15);
    appendFileSync(file, middle);
    const second = await adapter.parse(ref, first, ctx);
    expect(second.offset).toBe(Buffer.byteLength(lines.slice(0, 10).join('')));
    appendFileSync(file, lines[10].slice(15) + lines.slice(11).join(''));
    const third = await adapter.parse(ref, second, ctx);

    const full = await adapter.parse({ ...ref, path: MAIN }, undefined, ctx);
    expect(third.run.events).toEqual(full.run.events);
    expect(third.run.tally).toEqual(full.run.tally);
    expect(third.run.files).toEqual(full.run.files);
    expect(third.run.turn).toBe(full.run.turn);
    expect(third.offset).toBe(Buffer.byteLength(text));

    // A rewritten (shrunk) file starts over.
    writeFileSync(file, lines.slice(0, 2).join(''));
    const again = await adapter.parse(ref, third, ctx);
    expect(again.run.events).toHaveLength(2);
  });
});

describe('format helpers', () => {
  it('decodes VS Code folder URIs', () => {
    expect(uriToPath('file:///home/alex/todo-cli')).toBe('/home/alex/todo-cli');
    expect(uriToPath('file:///c%3A/Users/alex/todo-cli')).toBe('C:\\Users\\alex\\todo-cli');
    expect(uriToPath('vscode-remote://wsl%2BUbuntu/home/alex/todo-cli')).toBe('/home/alex/todo-cli');
    expect(uriToPath({ fsPath: '/home/alex/x', scheme: 'file' })).toBe('/home/alex/x');
  });

  it('reads the transcript timestamp tag with its UTC offset', () => {
    expect(parseTimestampTag('<timestamp>Monday, Sep 21, 2026, 7:03 PM (UTC+2)</timestamp>')).toBe(Date.parse('2026-09-21T17:03:00Z'));
    expect(parseTimestampTag('no tag')).toBeUndefined();
  });
});
