import { describe, expect, it } from 'vitest';
import {
  applyFolderOp,
  cleanFolderName,
  folderCounts,
  folderOfRun,
  MAX_FILED_RUNS,
  MAX_FOLDER_NAME,
  MAX_FOLDERS,
  newFolderId,
  normalizeFolders,
  parseFolderOp,
} from './folders';
import { defaultSettings, normalizeSettings, type Settings } from './settings';

const RUN_A = 'claude-code:aaaa';
const RUN_B = 'codex:bbbb';
let n = 0;
const ids = () => `f_test${++n}`;

function withFolders(): Settings {
  return {
    ...defaultSettings(),
    folders: [
      { id: 'f_work', name: 'Work' },
      { id: 'f_home', name: 'Home' },
    ],
    runFolders: { [RUN_A]: 'f_work', [RUN_B]: 'f_home' },
  };
}

describe('folder settings', () => {
  it('default to no folders and every run unfiled', () => {
    const d = defaultSettings();
    expect(d.folders).toEqual([]);
    expect(d.runFolders).toEqual({});
    expect(normalizeSettings({}).folders).toEqual([]);
  });

  it('survive a round trip through normalizeSettings', () => {
    const s = withFolders();
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('drop bad folders and assignments instead of failing', () => {
    const { folders, runFolders } = normalizeFolders(
      [
        { id: 'f_ok', name: '  Client \n work  ' },
        { id: 'f_ok', name: 'Duplicate id' },
        { id: 'bad id!', name: 'Bad id' },
        { id: 'f_blank', name: '   ' },
        { id: 'f_num', name: 42 },
        'not an object',
        null,
      ],
      { [RUN_A]: 'f_ok', [RUN_B]: 'f_missing', '': 'f_ok', 'x:y': 7, ['z'.repeat(300)]: 'f_ok' },
    );
    expect(folders).toEqual([{ id: 'f_ok', name: 'Client work' }]);
    expect(runFolders).toEqual({ [RUN_A]: 'f_ok' });
    expect(normalizeFolders('nope', [1, 2])).toEqual({ folders: [], runFolders: {} });
    expect(normalizeSettings({ folders: 'x', runFolders: null }).runFolders).toEqual({});
  });

  it('keep a "__proto__" run id as plain data', () => {
    const raw = JSON.parse('{"__proto__": "f_a", "codex:1": "f_a"}');
    const { runFolders } = normalizeFolders([{ id: 'f_a', name: 'A' }], raw);
    expect(Object.getPrototypeOf(runFolders)).toBe(Object.prototype);
    expect(Object.keys(runFolders).sort()).toEqual(['__proto__', 'codex:1']);
  });

  it('cap the number of folders and assignments', () => {
    const many = Array.from({ length: MAX_FOLDERS + 5 }, (_, i) => ({ id: `f_${i}`, name: `F${i}` }));
    const runs = Object.fromEntries(Array.from({ length: MAX_FILED_RUNS + 5 }, (_, i) => [`codex:${i}`, 'f_0']));
    const r = normalizeFolders(many, runs);
    expect(r.folders).toHaveLength(MAX_FOLDERS);
    expect(Object.keys(r.runFolders)).toHaveLength(MAX_FILED_RUNS);
  });
});

describe('cleanFolderName', () => {
  it('collapses whitespace, strips control characters and caps the length', () => {
    expect(cleanFolderName('  a\t\tb\u0000c ')).toBe('a b c');
    expect(cleanFolderName('x'.repeat(200))).toHaveLength(MAX_FOLDER_NAME);
    expect(cleanFolderName(undefined)).toBe('');
  });
});

describe('applyFolderOp', () => {
  it('creates a folder with a new id at the end', () => {
    const s = withFolders();
    const r = applyFolderOp(s, { kind: 'create', name: ' Side  projects ' }, ids);
    expect(r.error).toBeUndefined();
    expect(r.folderId).toMatch(/^f_test/);
    expect(r.settings.folders.at(-1)).toEqual({ id: r.folderId, name: 'Side projects' });
    expect(s.folders).toHaveLength(2); // never mutates its input
  });

  it('refuses empty and duplicate names in plain words', () => {
    const s = withFolders();
    expect(applyFolderOp(s, { kind: 'create', name: '   ' }, ids).error).toBe('Give the folder a name.');
    const dup = applyFolderOp(s, { kind: 'create', name: 'work' }, ids);
    expect(dup.error).toBe('There is already a folder called "Work".');
    expect(dup.settings).toBe(s);
    expect(applyFolderOp(s, { kind: 'rename', id: 'f_home', name: 'WORK' }).error).toMatch(/already a folder/);
  });

  it('refuses a folder past the cap', () => {
    const s = { ...defaultSettings(), folders: Array.from({ length: MAX_FOLDERS }, (_, i) => ({ id: `f_${i}`, name: `F${i}` })) };
    expect(applyFolderOp(s, { kind: 'create', name: 'One more' }, ids).error).toMatch(/up to 100 folders/);
  });

  it('renames in place and keeps the id and the runs in it', () => {
    const r = applyFolderOp(withFolders(), { kind: 'rename', id: 'f_work', name: 'Client work' });
    expect(r.settings.folders[0]).toEqual({ id: 'f_work', name: 'Client work' });
    expect(folderOfRun(r.settings, RUN_A)?.name).toBe('Client work');
    // Renaming to the same name with different case is allowed for the folder itself.
    expect(applyFolderOp(withFolders(), { kind: 'rename', id: 'f_work', name: 'WORK' }).settings.folders[0].name).toBe('WORK');
    expect(applyFolderOp(withFolders(), { kind: 'rename', id: 'f_gone', name: 'X' }).error).toBe('That folder no longer exists.');
  });

  it('deletes a folder and returns its runs to Unfiled, leaving other folders alone', () => {
    const r = applyFolderOp(withFolders(), { kind: 'delete', id: 'f_work' });
    expect(r.error).toBeUndefined();
    expect(r.settings.folders.map((f) => f.id)).toEqual(['f_home']);
    expect(folderOfRun(r.settings, RUN_A)).toBeUndefined();
    expect(folderOfRun(r.settings, RUN_B)?.id).toBe('f_home');
    // Deleting a folder that is already gone is a no-op, not an error.
    expect(applyFolderOp(r.settings, { kind: 'delete', id: 'f_work' })).toEqual({ settings: r.settings });
  });

  it('moves runs into a folder, between folders and back to Unfiled', () => {
    const s = withFolders();
    const moved = applyFolderOp(s, { kind: 'move', runIds: [RUN_A, 'gemini:c'], folderId: 'f_home' }).settings;
    expect(moved.runFolders).toEqual({ [RUN_A]: 'f_home', [RUN_B]: 'f_home', 'gemini:c': 'f_home' });
    expect(folderCounts(moved).get('f_home')).toBe(3);
    const unfiled = applyFolderOp(moved, { kind: 'move', runIds: [RUN_A, RUN_B], folderId: null }).settings;
    expect(unfiled.runFolders).toEqual({ 'gemini:c': 'f_home' });
    expect(applyFolderOp(s, { kind: 'move', runIds: [RUN_A], folderId: 'f_gone' }).error).toBe('That folder no longer exists.');
  });

  it('refuses a move that would go past the stored-assignment cap', () => {
    const s = { ...withFolders(), runFolders: {} };
    const runIds = Array.from({ length: MAX_FILED_RUNS + 1 }, (_, i) => `codex:${i}`);
    const r = applyFolderOp(s, { kind: 'move', runIds, folderId: 'f_work' });
    expect(r.error).toMatch(/runs can be in folders/);
    expect(r.settings).toBe(s);
  });

  it('results normalise to themselves (what main saves is what loads back)', () => {
    let s = withFolders();
    s = applyFolderOp(s, { kind: 'create', name: 'New' }, ids).settings;
    s = applyFolderOp(s, { kind: 'move', runIds: ['aider:z'], folderId: s.folders[2].id }).settings;
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('newFolderId', () => {
  it('makes ids normalizeFolders accepts and avoids taken ones', () => {
    const a = newFolderId();
    expect(normalizeFolders([{ id: a, name: 'A' }], {}).folders).toHaveLength(1);
    expect(newFolderId(new Set([a]))).not.toBe(a);
  });
});

describe('parseFolderOp', () => {
  it('accepts well-formed changes', () => {
    expect(parseFolderOp({ kind: 'create', name: 'A' })).toEqual({ kind: 'create', name: 'A' });
    expect(parseFolderOp({ kind: 'rename', id: 'f_a', name: 'B' })).toEqual({ kind: 'rename', id: 'f_a', name: 'B' });
    expect(parseFolderOp({ kind: 'delete', id: 'f_a' })).toEqual({ kind: 'delete', id: 'f_a' });
    expect(parseFolderOp({ kind: 'move', runIds: [RUN_A], folderId: null })).toEqual({ kind: 'move', runIds: [RUN_A], folderId: null });
  });

  it('rejects anything else', () => {
    for (const bad of [
      null,
      'create',
      { kind: 'explode' },
      { kind: 'create' },
      { kind: 'create', name: 'x'.repeat(2000) },
      { kind: 'delete', id: 7 },
      { kind: 'move', runIds: 'codex:1', folderId: null },
      { kind: 'move', runIds: [1], folderId: null },
      { kind: 'move', runIds: [RUN_A] },
      { kind: 'move', runIds: [RUN_A], folderId: '' },
    ]) {
      expect(parseFolderOp(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
