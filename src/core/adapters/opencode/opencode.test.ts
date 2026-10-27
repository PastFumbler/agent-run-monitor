// OpenCode adapter tests. Databases are built at runtime in os.tmpdir() from the .sql fixtures in
// test/fixtures/opencode with node:sqlite; the JSON-tree fixtures are copied
// into a fake home there. Nothing outside os.tmpdir() is written.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env, ParseContext, ParseState, SessionRef } from '../../adapter';
import { runId, safeParse, toSummary } from '../../build';
import type { NewEvent } from '../../events';
import { limits } from '../../sqlite';
import { judgeStatus } from '../../status';
import { adapter, closeAllSnapshots, defaultRoots, isRelevantChange } from './index';

const require = createRequire(import.meta.url);
// Every database read copies the file into a temp folder first: on a busy machine a test that builds
// and reads several databases can pass the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
const FIX = resolve(__dirname, '../../../../test/fixtures/opencode');
const V2_DONE = 'ses_ea76b08fffe5y6mJwxNH1lbw4Q';
const V2_LIVE = 'ses_ea7341a7ffe4AUsuosYaBtwpYw';
const V1_ID = 'ses_3e154120fffehqoEpQu8qH1U19';
const V1_END = 1770041122200;

let work: string;
let n = 0;
const ctx = (): ParseContext => ({ env: envFor(work), tempDir: join(work, 'tmp') });
const envFor = (home: string): Env => ({ platform: process.platform, home, vars: {} });

const counts = (events: NewEvent[]) => events.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});

/** A fake home with <home>/.local/share/opencode, returned with that data folder. */
function fakeHome(): { home: string; data: string } {
  const home = join(work, `home${n++}`);
  const data = join(home, '.local', 'share', 'opencode');
  mkdirSync(data, { recursive: true });
  return { home, data };
}

interface Writer {
  run(sql: string, params?: SQLInputValue[]): void;
}

/** Writes a fresh rollback-journal database (no -wal left behind) with node:sqlite. */
function writeDb(file: string, sql: string, extra?: (db: Writer) => void) {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
    extra?.({ run: (q, params = []) => void db.prepare(q).run(...params) });
  } finally {
    db.close();
  }
}

const fixtureSql = (name: string) => readFileSync(join(FIX, name), 'utf8');

async function discoverIn(home: string, since = 0): Promise<SessionRef[]> {
  const env = envFor(home);
  return adapter.discover(defaultRoots(env), { env, since, projectRoots: [] });
}

async function parseRef(ref: SessionRef, prev?: ParseState): Promise<ParseState> {
  return safeParse(adapter, ref, prev, ctx());
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'arm-opencode-'));
});

afterAll(async () => {
  await closeAllSnapshots();
  rmSync(work, { recursive: true, force: true });
});

describe('defaultRoots', () => {
  it('uses XDG data paths on every OS', () => {
    expect(defaultRoots({ platform: 'linux', home: '/home/alex', vars: {} })).toEqual(['/home/alex/.local/share/opencode']);
    expect(defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: {} })).toEqual(['/Users/alex/.local/share/opencode']);
    expect(defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' } })).toEqual([
      'C:\\Users\\alex\\.local\\share\\opencode',
    ]);
    expect(defaultRoots({ platform: 'linux', home: '/home/alex', vars: { XDG_DATA_HOME: '/data/xdg' } })).toEqual(['/data/xdg/opencode']);
  });

  it('adds $OPENCODE_DB when it points somewhere the folder listing would miss', () => {
    const base = { platform: 'linux' as const, home: '/home/alex' };
    expect(defaultRoots({ ...base, vars: { OPENCODE_DB: '/srv/oc/custom.db' } })).toEqual(['/home/alex/.local/share/opencode', '/srv/oc/custom.db']);
    expect(defaultRoots({ ...base, vars: { OPENCODE_DB: 'mine.sqlite' } })).toEqual([
      '/home/alex/.local/share/opencode',
      '/home/alex/.local/share/opencode/mine.sqlite',
    ]);
    expect(defaultRoots({ ...base, vars: { OPENCODE_DB: 'opencode-dev.db' } })).toEqual(['/home/alex/.local/share/opencode']);
    expect(defaultRoots({ ...base, vars: { OPENCODE_DB: ':memory:' } })).toEqual(['/home/alex/.local/share/opencode']);
  });
});

describe('discover', () => {
  it('returns nothing for a missing root', async () => {
    const env = envFor(join(work, 'nobody'));
    expect(await adapter.discover([join(work, 'nobody', 'nope')], { env, since: 0, projectRoots: [] })).toEqual([]);
  });

  it('finds 2.x database sessions and JSON-tree sessions, one run each', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'));
    cpSync(join(FIX, 'v1-json', 'storage'), join(data, 'storage'), { recursive: true });
    writeFileSync(join(data, 'opencode.db-shm'), ''); // sidecars are not databases
    const refs = await discoverIn(home);
    expect(refs.map((r) => r.subId ?? r.hint?.session).sort()).toEqual([V1_ID, V2_LIVE, V2_DONE].sort());
    const done = refs.find((r) => r.subId === V2_DONE)!;
    expect(done.hint?.kind).toBe('v2');
    expect(done.mtimeMs).toBe(1792487604707);
    expect(done.size).toBe(12);
    const legacy = refs.find((r) => r.hint?.kind === 'legacy')!;
    expect(legacy.path).toBe(join(data, 'storage', 'session', '98ebcb82034fba541edd74d0cfc15a048c48098a', `${V1_ID}.json`));
  });

  it('prefers the database copy of a session over the stale JSON tree, and honours since', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode-local.db'), fixtureSql('v1-sqlite.sql'));
    cpSync(join(FIX, 'v1-json', 'storage'), join(data, 'storage'), { recursive: true });
    const refs = await discoverIn(home);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ subId: V1_ID, hint: { kind: 'v1' }, mtimeMs: V1_END });
    expect(await discoverIn(home, V1_END + 1)).toEqual([]);
    expect(await discoverIn(home, V1_END)).toHaveLength(1);
  });

  it('reads 1.x sessions the 2.x import has not copied yet, and keeps the newest copy across databases', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql') + fixtureSql('v1-sqlite.sql').replace(/CREATE TABLE migration[^;]*;|CREATE TABLE project[^;]*;|INSERT INTO migration[^;]*;|INSERT INTO project[^;]*;/g, ''));
    writeDb(join(data, 'opencode-next.db'), fixtureSql('v2.sql').replace("1792487604707, 1792487604707, 1792487530105", "1792487600000, 1792487604707, 1792487530105"));
    const refs = await discoverIn(home);
    expect(refs.map((r) => `${r.subId}:${r.hint?.kind}`).sort()).toEqual([`${V1_ID}:v1`, `${V2_LIVE}:v2`, `${V2_DONE}:v2`].sort());
  });

  it('reads $OPENCODE_DB whatever its file name', async () => {
    const { home } = fakeHome();
    const file = join(work, `custom${n++}`, 'sessions.sqlite');
    writeDb(file, fixtureSql('v2.sql'));
    const env: Env = { platform: process.platform, home, vars: { OPENCODE_DB: file } };
    const refs = await adapter.discover(defaultRoots(env), { env, since: 0, projectRoots: [] });
    expect(refs.map((r) => r.subId).sort()).toEqual([V2_LIVE, V2_DONE].sort());
    expect(refs.every((r) => r.path === file)).toBe(true);
  });

  it('ignores churn in snapshot/, log/ and other non-session folders', () => {
    const d = '/home/alex/.local/share/opencode';
    for (const p of [`${d}/opencode.db`, `${d}/opencode.db-wal`, `${d}/opencode-dev.db-shm`, `${d}/storage/part/msg_1/prt_1.json`, `${d}/storage/session/global`, `${d}/storage`, d, 'C:\\Users\\alex\\.local\\share\\opencode\\opencode.db-wal'])
      expect(isRelevantChange(p), p).toBe(true);
    for (const p of [`${d}/snapshot/abc/objects/12/3456`, `${d}/log/2026-10-27.log`, `${d}/bin/rg`, `${d}/tool-output/x.txt`, `${d}/storage/todo/ses_1.json`])
      expect(isRelevantChange(p), p).toBe(false);
  });

  it('turns an unreadable database into one run that says so', async () => {
    const { home, data } = fakeHome();
    writeFileSync(join(data, 'opencode.db'), 'this is not a database at all, just text that is long enough '.repeat(40));
    const refs = await discoverIn(home);
    expect(refs).toHaveLength(1);
    expect(refs[0].hint?.kind).toBe('db-error');
    const st = await parseRef(refs[0]);
    expect(st.run.readError).toBeTruthy();
    expect(judgeStatus(st.run, refs[0].mtimeMs, Date.now()).status).toBe('unreadable');
  });

  it('copies databases into DiscoverContext.tempDir and the parse temp folder, never next to the source', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'));
    await closeAllSnapshots();
    const scratch = join(work, `scratch${n++}`);
    const env = envFor(home);
    const refs = await adapter.discover(defaultRoots(env), { env, since: 0, projectRoots: [], tempDir: scratch });
    expect(refs).toHaveLength(2);
    expect(readdirSync(scratch)).toHaveLength(1); // one cached snapshot subfolder
    expect(readdirSync(join(scratch, readdirSync(scratch)[0]))).toContain('snapshot.db');
    expect(readdirSync(data)).toEqual(['opencode.db']);
    await closeAllSnapshots();
    expect(readdirSync(scratch)).toEqual([]);
    // parse copies into ParseContext.tempDir.
    const st = await parseRef(refs.find((r) => r.subId === V2_DONE)!);
    expect(st.run.readError).toBeUndefined();
    expect(readdirSync(ctx().tempDir)).toHaveLength(1);
    await closeAllSnapshots();
    expect(readdirSync(ctx().tempDir)).toEqual([]);
    expect(existsSync(join(data, 'opencode.db-shm'))).toBe(false);
  });

  it('refuses databases over the size limit with a reason', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'));
    const old = limits.maxDbBytes;
    limits.maxDbBytes = 1024;
    try {
      const refs = await discoverIn(home);
      expect(refs).toHaveLength(1);
      expect(refs[0].hint?.kind).toBe('db-error');
      const st = await parseRef(refs[0]);
      expect(st.run.readError).toMatch(/OpenCode database is .* GB, more than the .* GB this app will copy/);
    } finally {
      limits.maxDbBytes = old;
    }
  });

  it('sees rows that are still only in the -wal file', async () => {
    const { home, data } = fakeHome();
    const file = join(data, 'opencode.db');
    const live = new DatabaseSync(file);
    try {
      live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      live.exec(fixtureSql('v2.sql').split('\n').filter((l) => l.startsWith('CREATE')).join('\n'));
      live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      live.exec(fixtureSql('v2.sql').split('\n').filter((l) => l.startsWith('INSERT')).join('\n'));
      const refs = await discoverIn(home);
      expect(refs.map((r) => r.subId).sort()).toEqual([V2_LIVE, V2_DONE].sort());
      const st = await parseRef(refs.find((r) => r.subId === V2_DONE)!);
      expect(st.run.title).toBe('Fix single-digit due dates');
    } finally {
      live.close();
    }
  });
});

describe('parent links', () => {
  it('links a 2.x sub-agent session to its parent session in the same database', async () => {
    const { home, data } = fakeHome();
    const file = join(data, 'opencode.db');
    writeDb(file, fixtureSql('v2.sql'), (db) => db.run('UPDATE session_v2 SET parent_id = ? WHERE id = ?', [V2_DONE, V2_LIVE]));
    const refs = await discoverIn(home);
    const child = refs.find((r) => r.subId === V2_LIVE)!;
    const parent = refs.find((r) => r.subId === V2_DONE)!;
    expect(child.hint?.parent).toBe(V2_DONE);
    const st = await parseRef(child);
    expect(st.run.parentPath).toBe(file);
    expect(st.run.parentSubId).toBe(V2_DONE);
    const summary = toSummary(child, st, Date.now(), false);
    expect(summary.parentId).toBe(runId(parent));
    expect(summary.parentId).not.toBe(runId({ ...parent, subId: undefined }));
    // The parent itself has no parent.
    expect(toSummary(parent, await parseRef(parent), Date.now(), false).parentId).toBeUndefined();
  });

  it('links a 1.x sub-agent session to its parent session', async () => {
    const { home, data } = fakeHome();
    const file = join(data, 'opencode.db');
    writeDb(file, fixtureSql('v1-sqlite.sql'), (db) => db.run('UPDATE session SET parent_id = ? WHERE id = ?', ['ses_parent', V1_ID]));
    const [ref] = await discoverIn(home);
    const st = await parseRef(ref);
    expect(st.run.parentSubId).toBe('ses_parent');
    expect(toSummary(ref, st, Date.now(), false).parentId).toBe(runId({ agent: 'opencode', path: file, subId: 'ses_parent', mtimeMs: 0, size: 0 }));
  });
});

describe('parse: OpenCode 2.x (session_v2)', () => {
  let refs: SessionRef[];
  beforeAll(async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'));
    refs = await discoverIn(home);
  });

  it('reads a finished session that ended in an API error', async () => {
    const ref = refs.find((r) => r.subId === V2_DONE)!;
    const st = await parseRef(ref);
    const run = st.run;
    expect(run.readError).toBeUndefined();
    expect(run.title).toBe('Fix single-digit due dates');
    expect(run.projectName).toBe('todo-cli');
    expect(run.projectPath).toBe('C:\\Users\\alex\\code\\todo-cli');
    expect(run.model).toBe('claude-sonnet-4-5');
    expect(counts(run.events)).toEqual({ system: 2, user: 2, reasoning: 2, assistant: 2, tool_call: 6, tool_result: 6, error: 1 });
    expect(run.skipped).toBe(0);
    expect(run.tally).toMatchObject({ toolCalls: 6, errors: 2, messages: 4 });
    // Calls and results pair by id; the failed edit is an error result and changes no file.
    const calls = run.events.filter((e) => e.kind === 'tool_call');
    const results = run.events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => e.toolCallId)).toEqual(calls.map((e) => e.toolCallId));
    expect(calls.map((e) => e.toolName)).toEqual(['read', 'edit', 'edit', 'shell', 'shell', 'write']);
    expect(results[1]).toMatchObject({ isError: true, text: expect.stringContaining('Could not find oldString') });
    expect(calls[3]).toMatchObject({ toolKind: 'run', text: 'python -m pytest -q' });
    expect(calls[4]).toMatchObject({ toolCallId: 'sh_HJWnLwECf4', text: 'git status --short' }); // the user's own !command
    expect(results[3].durationMs).toBe(2100);
    expect(Object.keys(run.files).sort()).toEqual(['C:\\Users\\alex\\code\\todo-cli\\tests\\test_single_digit_due.py', 'C:\\Users\\alex\\code\\todo-cli\\todo_cli\\dates.py']);
    expect(run.files['C:\\Users\\alex\\code\\todo-cli\\tests\\test_single_digit_due.py'].ops).toEqual(['create']);
    expect(run.files['C:\\Users\\alex\\code\\todo-cli\\todo_cli\\dates.py']).toMatchObject({ ops: ['edit'], count: 1 });
    expect(run.events.find((e) => e.kind === 'error')!.text).toBe('API error 529: Overloaded');
    expect(run.turn).toBe('error');
    expect(run.turnDetail).toBe('API error 529: Overloaded');
    expect(run.openTool).toBeUndefined();
    // The session totals, cache apart (OpenCode keeps it out of input); reasoning counts as output.
    expect(run.usage).toMatchObject({ input: 6125, cacheRead: 56810, cacheWrite: 2610, output: 590 + 118 });
    // The applied edit and the new file, with their patches; the failed edit is not a change.
    expect(run.changes!.map((c) => [c.filePath, c.op, c.linesAdded, c.linesRemoved])).toEqual([
      ['C:\\Users\\alex\\code\\todo-cli\\todo_cli\\dates.py', 'edit', 1, 1],
      ['C:\\Users\\alex\\code\\todo-cli\\tests\\test_single_digit_due.py', 'create', 4, 0],
    ]);
    expect(run.changes![0].diff!.startsWith('@@ -1,2 +1,2 @@')).toBe(true);
    expect(run.startedAt).toBe(1792487520000);
    expect(run.lastEventAt).toBe(1792487604707);
    expect(judgeStatus(run, ref.mtimeMs, 1792487604707 + 3600_000)).toMatchObject({ status: 'failed', detail: 'API error 529: Overloaded' });
  });

  it('reads a session that is still running a shell tool', async () => {
    const ref = refs.find((r) => r.subId === V2_LIVE)!;
    const run = (await parseRef(ref)).run;
    expect(run.title).toBe('Add CSV export');
    expect(counts(run.events)).toEqual({ user: 1, assistant: 1, tool_call: 1 });
    expect(run.turn).toBe('in_progress');
    expect(run.openTool).toEqual({ name: 'shell', kind: 'run', since: 1792491121900 });
    expect(judgeStatus(run, ref.mtimeMs, 1792491124000 + 60_000)).toMatchObject({ status: 'running', detail: 'Running shell' });
  });

  it('returns the previous state when nothing changed, and rebuilds when the session did', async () => {
    const { home, data } = fakeHome();
    const file = join(data, 'opencode.db');
    writeDb(file, fixtureSql('v2.sql'));
    const ref = (await discoverIn(home)).find((r) => r.subId === V2_LIVE)!;
    const first = await parseRef(ref);
    expect(await parseRef(ref, first)).toBe(first);
    // The other session changes: this one keeps its state object.
    writeDb(file, fixtureSql('v2.sql'), (db) =>
      db.run("UPDATE session_v2 SET title = 'Renamed' WHERE id = ?", [V2_DONE]),
    );
    expect(await parseRef(ref, first)).toBe(first);
    // This session finishes its tool and its turn.
    writeDb(file, fixtureSql('v2.sql'), (db) => {
      db.run(
        "UPDATE session_message SET data = replace(replace(data, '\"status\":\"running\"', '\"status\":\"completed\",\"content\":[{\"type\":\"text\",\"text\":\"3 items\"}]'), '\"ran\":1792491121910}', '\"ran\":1792491121910,\"completed\":1792491125000}') WHERE session_id = ? AND seq = 1",
        [V2_LIVE],
      );
      db.run("INSERT INTO session_message VALUES ('msg_x', ?, 'idle', 2, 1792491126000, 1792491126000, '{\"outcome\":\"interrupted\"}')", [V2_LIVE]);
      db.run('UPDATE session_v2 SET time_suspended = NULL WHERE id = ?', [V2_LIVE]);
    });
    const next = await parseRef(ref, first);
    expect(next).not.toBe(first);
    expect(counts(next.run.events)).toEqual({ user: 1, assistant: 1, tool_call: 1, tool_result: 1, system: 1 });
    expect(next.run.turn).toBe('aborted');
    expect(next.run.openTool).toBeUndefined();
  });

  it('skips rows with unreadable data and keeps the rest', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'), (db) => {
      db.run("UPDATE session_message SET data = '{\"text\":\"cut off' WHERE session_id = ? AND seq = 5", [V2_DONE]);
      db.run("INSERT INTO session_message VALUES ('msg_y', ?, 'hologram', 99, 1792487604800, 1792487604800, '{}')", [V2_DONE]);
    });
    const ref = (await discoverIn(home)).find((r) => r.subId === V2_DONE)!;
    const run = (await parseRef(ref)).run;
    expect(run.readError).toBeUndefined();
    expect(run.skipped).toBe(2);
    expect(counts(run.events).assistant).toBe(1);
    expect(run.turn).toBe('error');
  });

  it('flags a session whose rows are all of unknown types', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'), (db) => {
      db.run("UPDATE session_message SET type = 'teleport-' || seq WHERE session_id = ?", [V2_LIVE]);
    });
    const ref = (await discoverIn(home)).find((r) => r.subId === V2_LIVE)!;
    const st = await parseRef(ref);
    expect(st.run.readError).toMatch(/No records this app recognises/);
    expect(st.run.skipped).toBe(2);
  });

  it('fails the turn on an API error with no retry pending, even before the step is marked complete', async () => {
    const withError = async (extra: string) => {
      const { home, data } = fakeHome();
      writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'), (db) => {
        db.run(
          `UPDATE session_message SET data = replace(data, '"time":{"created":1792491121600}}', '"error":{"type":"APIError","message":"Bad gateway","status":502}${extra},"time":{"created":1792491121600}}') WHERE session_id = ? AND seq = 1`,
          [V2_LIVE],
        );
      });
      const ref = (await discoverIn(home)).find((r) => r.subId === V2_LIVE)!;
      return (await parseRef(ref)).run;
    };
    // time_suspended is still set on this session (the claim outlived the failure): the error wins.
    const failed = await withError('');
    expect(failed.turn).toBe('error');
    expect(failed.turnDetail).toBe('API error 502: Bad gateway');
    expect(judgeStatus(failed, 1792491124000, 1792491124000 + 60_000).status).toBe('failed');
    // With a retry scheduled, the turn is still going.
    const retrying = await withError(',"retry":{"attempt":2,"at":1792491126000}');
    expect(retrying.turn).toBe('in_progress');
    expect(retrying.turnDetail).toBe('Retrying after an error (attempt 2)');
  });

  it('drops a tool left open by an earlier step once a later step starts', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'), (db) => {
      db.run(
        `INSERT INTO session_message VALUES ('msg_z', ?, 'assistant', 2, 1792491130000, 1792491130000, '{"content":[{"type":"text","text":"Resuming."}],"time":{"created":1792491130000}}')`,
        [V2_LIVE],
      );
    });
    const run = (await parseRef((await discoverIn(home)).find((r) => r.subId === V2_LIVE)!)).run;
    expect(run.turn).toBe('in_progress');
    expect(run.openTool).toBeUndefined();
  });

  it('names the project after the repo root, not the sub-folder the session ran in', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'), (db) => {
      db.run("UPDATE session_v2 SET directory = 'C:/Users/alex/code/todo-cli/docs' WHERE id = ?", [V2_DONE]);
      // A non-git folder belongs to the "global" project, whose worktree is "/".
      db.run("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 0, 0, '[]')");
      db.run("UPDATE session_v2 SET project_id = 'global', directory = 'C:/Users/alex/scratch' WHERE id = ?", [V2_LIVE]);
    });
    const refs = await discoverIn(home);
    const done = (await parseRef(refs.find((r) => r.subId === V2_DONE)!)).run;
    expect(done.projectName).toBe('todo-cli');
    expect(done.projectPath).toBe('C:\\Users\\alex\\code\\todo-cli\\docs');
    const live = (await parseRef(refs.find((r) => r.subId === V2_LIVE)!)).run;
    expect(live.projectName).toBe('scratch');
  });

  it('marks an open question tool as waiting for the user', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v2.sql'), (db) => {
      db.run("UPDATE session_message SET data = replace(data, '\"name\":\"shell\"', '\"name\":\"question\"') WHERE session_id = ? AND seq = 1", [V2_LIVE]);
    });
    const ref = (await discoverIn(home)).find((r) => r.subId === V2_LIVE)!;
    const run = (await parseRef(ref)).run;
    expect(run.turn).toBe('waiting_input');
    expect(judgeStatus(run, ref.mtimeMs, 1792491124000 + 60_000).status).toBe('waiting');
  });
});

/** The same 1.x session is stored in the V1 SQLite fixture and the JSON-tree fixture. */
function expectV1Session(st: ParseState, projectPath: string) {
  const run = st.run;
  expect(run.readError).toBeUndefined();
  expect(run.title).toBe('Add priority flag to todo add');
  expect(run.projectName).toBe('todo-cli');
  expect(run.projectPath).toBe(projectPath);
  expect(run.model).toBe('claude-sonnet-4-5');
  expect(counts(run.events)).toEqual({ user: 2, reasoning: 1, assistant: 2, tool_call: 5, tool_result: 5, system: 1 });
  const calls = run.events.filter((e) => e.kind === 'tool_call');
  const results = run.events.filter((e) => e.kind === 'tool_result');
  expect(results.map((e) => e.toolCallId)).toEqual(calls.map((e) => e.toolCallId));
  expect(calls.map((e) => `${e.toolName}:${e.toolKind}`)).toEqual(['read:read', 'edit:edit', 'edit:edit', 'bash:run', 'read:read']);
  expect(results.map((e) => !!e.isError)).toEqual([false, true, false, false, true]);
  expect(results[3].durationMs).toBe(1900);
  expect(run.files).toEqual({ '/home/alex/code/todo-cli/todo_cli/cli.py': { ops: ['edit'], count: 1, lastTs: 1770041114700 } });
  expect(run.events.at(-1)).toMatchObject({ kind: 'system', text: 'Interrupted' });
  expect(run.turn).toBe('aborted');
  expect(run.usage).toMatchObject({ input: 5970, cacheRead: 46460, cacheWrite: 2400, output: 511 + 96 });
  expect(run.changes!.map((c) => [c.filePath, c.op, c.linesAdded, c.linesRemoved, c.ts])).toEqual([['/home/alex/code/todo-cli/todo_cli/cli.py', 'edit', 1, 1, expect.any(Number)]]);
  expect(run.changes![0].diff).toBe(['@@ -2,3 +2,3 @@', ' ', ' def add(args):', '-    store.add(args.title)', '+    store.add(args.title, priority=args.priority)'].join('\n'));
  expect(run.startedAt).toBe(1770041110000);
  expect(run.lastEventAt).toBe(V1_END);
  expect(judgeStatus(run, V1_END, V1_END + 600_000).status).toBe('done');
  expect(judgeStatus(run, V1_END, V1_END + 60_000).status).toBe('idle');
}

describe('parse: OpenCode 1.2 - 1.19 (session / message / part tables)', () => {
  it('reads the session', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v1-sqlite.sql'));
    const [ref] = await discoverIn(home);
    const st = await parseRef(ref);
    expectV1Session(st, '/home/alex/code/todo-cli');
    expect(await parseRef(ref, st)).toBe(st);
  });

  it('reads a session still in progress after a tool-calls step', async () => {
    const { home, data } = fakeHome();
    writeDb(join(data, 'opencode.db'), fixtureSql('v1-sqlite.sql'), (db) => {
      db.run("DELETE FROM message WHERE id IN ('msg_c1eac11180112A4ukNvrZLt0rk', 'msg_c1eac18840153d11YJ7TzjSpnT', 'msg_c1eac1ba4017tuy8iHR1iUulGa')");
    });
    const [ref] = await discoverIn(home);
    const run = (await parseRef(ref)).run;
    expect(run.turn).toBe('in_progress');
  });

  it('ends the turn on any finish but tool-calls and unknown', async () => {
    const turnWith = async (finish: string) => {
      const { home, data } = fakeHome();
      writeDb(join(data, 'opencode.db'), fixtureSql('v1-sqlite.sql'), (db) => {
        // Drop the interrupted second prompt; the first turn's last step ended with finish "stop".
        db.run("DELETE FROM message WHERE id IN ('msg_c1eac18840153d11YJ7TzjSpnT', 'msg_c1eac1ba4017tuy8iHR1iUulGa')");
        db.run(`UPDATE message SET data = replace(data, '"finish":"stop"', '"finish":"${finish}"') WHERE id = 'msg_c1eac11180112A4ukNvrZLt0rk'`);
      });
      const [ref] = await discoverIn(home);
      return (await parseRef(ref)).run.turn;
    };
    expect(await turnWith('stop')).toBe('completed');
    expect(await turnWith('other')).toBe('completed');
    expect(await turnWith('length')).toBe('completed');
    expect(await turnWith('unknown')).toBe('in_progress');
  });
});

describe('parse: OpenCode <= 1.1 (storage/ JSON files)', () => {
  async function legacyRef(fixture: string): Promise<SessionRef> {
    const { home, data } = fakeHome();
    cpSync(join(FIX, fixture, 'storage'), join(data, 'storage'), { recursive: true });
    const refs = await discoverIn(home);
    expect(refs).toHaveLength(1);
    return refs[0];
  }

  it('reads the session', async () => {
    const ref = await legacyRef('v1-json');
    const st = await parseRef(ref);
    expectV1Session(st, '/home/alex/code/todo-cli');
    expect(st.run.skipped).toBe(0);
  });

  it('sums per-step usage when one message holds several steps', async () => {
    const ref = await legacyRef('v1-json');
    const msg = 'msg_c1eac03d000df8lZ1o6Bos5yLe';
    const step = { id: 'prt_c1eac0df8010zzzzzzzzzzzzzz', type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 0 } } };
    writeFileSync(join(ref.hint!.storage, 'part', msg, `${step.id}.json`), JSON.stringify(step));
    const run = (await parseRef(ref)).run;
    expect(run.usage).toMatchObject({ input: 5970 + 100, cacheRead: 46460 + 1000, cacheWrite: 2400, output: 511 + 96 + 10 + 5 });
  });

  it('re-reads only when its files change', async () => {
    const ref = await legacyRef('v1-json');
    const first = await parseRef(ref);
    expect(await parseRef(ref, first)).toBe(first);
    const storage = ref.hint!.storage;
    const msg = 'msg_c1eac1ba4017tuy8iHR1iUulGz';
    writeFileSync(join(storage, 'message', V1_ID, `${msg}.json`), JSON.stringify({ id: msg, sessionID: V1_ID, role: 'user', time: { created: V1_END + 1000 } }));
    mkdirSync(join(storage, 'part', msg), { recursive: true });
    writeFileSync(join(storage, 'part', msg, 'prt_1.json'), JSON.stringify({ id: 'prt_1', type: 'text', text: 'Try again please' }));
    const next = await parseRef(ref, first);
    expect(next).not.toBe(first);
    expect(next.run.events.at(-1)).toMatchObject({ kind: 'user', text: 'Try again please' });
    expect(next.run.turn).toBe('in_progress');
  });

  it('survives the corrupt tree: bad files are skipped, good ones kept', async () => {
    const ref = await legacyRef('v1-json-corrupt');
    const st = await parseRef(ref);
    const run = st.run;
    expect(run.readError).toBeUndefined();
    expect(run.skipped).toBe(3); // garbage message, truncated part, empty part
    expect(run.title).toBe('Add priority flag to todo add');
    // The last message's tool part was the truncated one; everything else is there.
    expect(counts(run.events)).toEqual({ user: 2, reasoning: 1, assistant: 2, tool_call: 4, tool_result: 4, system: 1 });
    expect(run.turn).toBe('aborted');
  });

  it('marks a run unreadable when the session file itself is broken', async () => {
    const ref = await legacyRef('v1-json');
    writeFileSync(ref.path, '{"id": "ses_');
    const st = await parseRef(ref);
    expect(st.run.readError).toBeTruthy();
  });

  it('flags a session whose messages are all of unknown kinds', async () => {
    const ref = await legacyRef('v1-json');
    const dir = join(ref.hint!.storage, 'message', V1_ID);
    for (const f of require('node:fs').readdirSync(dir) as string[]) {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      writeFileSync(join(dir, f), JSON.stringify({ ...m, role: 'narrator' }));
    }
    const st = await parseRef(ref);
    expect(st.run.readError).toMatch(/No records this app recognises/);
  });
});
