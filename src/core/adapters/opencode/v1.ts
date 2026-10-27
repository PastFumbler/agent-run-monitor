// OpenCode 1.2 - 1.19 storage (G2): opencode.db tables `session`, `message`, `part`.
// [SRC sst/opencode v1.2.27 storage/db.ts, v1.19.4 core/src/session/sql.ts]
// message.data / part.data are the 1.x JSON objects minus id / sessionID / messageID. Ids sort
// chronologically (ascending ids), so ORDER BY id gives message and part order. The 2.x migration
// copies these tables into session_v2 without dropping them, so a session already in session_v2 is
// read from there instead.

import type { ParsedRun } from '../../adapter';
import { isObj } from '../../events';
import { modelName } from './common';
import { buildV1Run, type V1Message } from './messages';
import { nativePath } from './paths';
import { all, asNum, asText, one, parseJson, pick, tableNames, type Database } from './sqlite';
import { projectName as projectNameOf, type SessionListing } from './v2';

const SESSION_COLS = [
  'id', 'project_id', 'parent_id', 'title', 'directory', 'model', 'tokens_input', 'tokens_output', 'tokens_reasoning',
  'tokens_cache_read', 'tokens_cache_write', 'time_created', 'time_updated',
] as const;

/** True when the database has the 1.x session tables. */
export function hasV1(db: Database): boolean {
  const t = tableNames(db);
  return t.has('session') && t.has('message');
}

export function listV1(db: Database): SessionListing[] {
  const last = new Map<string, number>();
  const count = new Map<string, number>();
  const bump = (id: unknown, at: unknown) => {
    const k = String(id);
    last.set(k, Math.max(last.get(k) ?? 0, asNum(at as number) ?? 0));
  };
  for (const r of all(db, 'SELECT session_id, MAX(time_updated) AS last, COUNT(*) AS n FROM message GROUP BY session_id')) {
    bump(r.session_id, r.last);
    count.set(String(r.session_id), asNum(r.n) ?? 0);
  }
  // Parts are rewritten in place while a step streams, so their times are the freshest.
  if (tableNames(db).has('part') && pick(db, 'part', ['session_id']) === 'session_id')
    for (const r of all(db, 'SELECT session_id, MAX(time_updated) AS last FROM part GROUP BY session_id')) bump(r.session_id, r.last);
  const cols = pick(db, 'session', ['id', 'parent_id', 'time_created', 'time_updated']);
  return all(db, `SELECT ${cols} FROM session`)
    .filter((r) => typeof r.id === 'string')
    .map((r) => ({
      id: String(r.id),
      created: asNum(r.time_created),
      updated: Math.max(asNum(r.time_updated) ?? 0, last.get(String(r.id)) ?? 0),
      rows: count.get(String(r.id)) ?? 0,
      parent: asText(r.parent_id),
    }));
}

export function v1Signature(db: Database, id: string): string {
  const s = one(db, `SELECT ${pick(db, 'session', ['time_updated'])} FROM session WHERE id = ?`, [id]);
  const m = one(db, 'SELECT MAX(time_updated) AS last, COUNT(*) AS n FROM message WHERE session_id = ?', [id]);
  const p = tableNames(db).has('part')
    ? one(db, 'SELECT MAX(p.time_updated) AS last, COUNT(*) AS n FROM part p JOIN message m ON p.message_id = m.id WHERE m.session_id = ?', [id])
    : undefined;
  return JSON.stringify([s ?? null, m ?? null, p ?? null]);
}

export function buildV1DbRun(db: Database, id: string): ParsedRun {
  const s = one(db, `SELECT ${pick(db, 'session', SESSION_COLS)} FROM session WHERE id = ?`, [id]);
  if (!s) throw new Error('This session is no longer in the OpenCode database.');
  const dir = asText(s.directory) ? nativePath(asText(s.directory)!) : undefined;
  const projectName = projectNameOf(db, asText(s.project_id), dir);

  let unreadable = 0;
  const messages: V1Message[] = [];
  const byId = new Map<string, V1Message>();
  for (const r of all(db, 'SELECT id, time_updated, data FROM message WHERE session_id = ? ORDER BY id', [id])) {
    const info = parseJson(r.data);
    if (!isObj(info)) {
      unreadable++;
      continue;
    }
    const m: V1Message = { info, parts: [], updated: asNum(r.time_updated) };
    messages.push(m);
    byId.set(String(r.id), m);
  }
  if (tableNames(db).has('part')) {
    const rows = all(db, 'SELECT p.id, p.message_id, p.time_updated, p.data FROM part p JOIN message m ON p.message_id = m.id WHERE m.session_id = ? ORDER BY p.id', [id]);
    for (const r of rows) {
      const m = byId.get(String(r.message_id));
      const part = parseJson(r.data);
      if (!m) continue; // its message row was unreadable (already counted)
      if (!isObj(part)) {
        unreadable++;
        continue;
      }
      m.parts.push(part);
      m.updated = Math.max(m.updated ?? 0, asNum(r.time_updated) ?? 0);
    }
  }

  const tokIn = (asNum(s.tokens_input) ?? 0) + (asNum(s.tokens_cache_read) ?? 0) + (asNum(s.tokens_cache_write) ?? 0);
  const tokOut = (asNum(s.tokens_output) ?? 0) + (asNum(s.tokens_reasoning) ?? 0);
  const run = buildV1Run(
    {
      title: asText(s.title),
      directory: dir,
      projectName,
      model: modelName(asText(s.model)),
      created: asNum(s.time_created),
      updated: asNum(s.time_updated),
      inputTokens: tokIn || undefined,
      outputTokens: tokOut || undefined,
    },
    messages,
    unreadable,
  );
  // A sub-agent (task tool) session: its parent is another session row in this database.
  run.parentSubId = asText(s.parent_id) || undefined;
  return run;
}
