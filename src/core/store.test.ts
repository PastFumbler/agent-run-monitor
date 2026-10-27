// RunStore tests: fake adapters reading a tiny JSONL format from a temp folder, a manual clock
// for batching and status timing, and one real-watcher test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { AgentId } from '@shared/schema';
import type { RunFinishedNotice, RunsUpdate } from '@shared/ipc';
import { defaultSettings, type Settings } from '@shared/settings';
import { emptyRun, freshState, type Env, type ParseState, type SessionRef, type SourceAdapter } from './adapter';
import { pushEvent } from './events';
import { readJsonl } from './jsonl';
import { RunStore, type Clock } from './store';

// ---- manual clock ------------------------------------------------------------------------------

class ManualClock implements Clock {
  t: number;
  private seq = 0;
  private timers = new Map<number, { due: number; fn: () => void; every?: number }>();
  constructor(start: number) {
    this.t = start;
  }
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { due: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  setInterval = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { due: this.t + ms, fn, every: ms });
    return id;
  };
  clearInterval = (h: unknown) => void this.timers.delete(h as number);
  /** Moves time forward, firing due timers in order. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void; every?: number }] | undefined;
      for (const kv of this.timers) if (kv[1].due <= target && (!next || kv[1].due < next[1].due)) next = kv;
      if (!next) break;
      const [id, tm] = next;
      this.t = tm.due;
      if (tm.every) tm.due += tm.every;
      else this.timers.delete(id);
      tm.fn();
    }
    this.t = target;
  }
}

// ---- fake adapter --------------------------------------------------------------------------------
// Format: one JSON object per line: {ts, kind: 'user'|'assistant'|'tool'|'result'|'end'|'error'|'ask'|'boom', text}

interface Calls {
  parses: { path: string; hadPrev: boolean; offset: number }[];
  discovers: number;
}

function fakeAdapter(id: AgentId, opts: { throwOn?: RegExp; discoverThrows?: boolean } = {}): SourceAdapter & { calls: Calls } {
  const calls: Calls = { parses: [], discovers: 0 };
  return {
    id,
    displayName: `Fake ${id}`,
    confidence: 'best-effort',
    note: 'test adapter',
    calls,
    defaultRoots: (env: Env) => [path.join(env.home, id)],
    async discover(roots, ctx) {
      calls.discovers++;
      if (opts.discoverThrows) throw new Error('discover exploded');
      const out: SessionRef[] = [];
      for (const root of roots) {
        let names: string[] = [];
        try {
          names = await readdir(root);
        } catch {
          continue;
        }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue;
          const p = path.join(root, n);
          const st = await stat(p);
          if (st.mtimeMs < ctx.since) continue;
          out.push({ agent: id, path: p, mtimeMs: st.mtimeMs, size: st.size, hint: { project: n.replace(/\.jsonl$/, '') } });
        }
      }
      return out;
    },
    async parse(ref, prev) {
      calls.parses.push({ path: ref.path, hadPrev: !!prev, offset: prev?.offset ?? 0 });
      if (opts.throwOn?.test(ref.path)) throw new Error('this adapter cannot read that');
      const st: ParseState = prev ?? { ...freshState(), run: emptyRun(ref.hint?.project) };
      const r = st.run;
      const res = await readJsonl(ref.path, st.offset, (rec) => {
        const x = rec as { ts: number; kind: string; text?: string };
        if (x.kind === 'boom') throw new Error('boom record');
        if (x.kind === 'user') pushEvent(r, { kind: 'user', text: x.text ?? '', ts: x.ts });
        if (x.kind === 'assistant') pushEvent(r, { kind: 'assistant', text: x.text ?? '', ts: x.ts });
        if (x.kind === 'tool') {
          pushEvent(r, { kind: 'tool_call', text: x.text ?? 'ls', toolName: 'Bash', toolKind: 'run', ts: x.ts });
          r.openTool = { name: 'Bash', kind: 'run', since: x.ts };
        }
        if (x.kind === 'result') {
          pushEvent(r, { kind: 'tool_result', text: 'ok', ts: x.ts });
          r.openTool = undefined;
        }
        r.turn =
          x.kind === 'end' ? 'completed' : x.kind === 'error' ? 'error' : x.kind === 'ask' ? 'waiting_input' : 'in_progress';
        if (x.kind === 'end' || x.kind === 'error' || x.kind === 'ask') r.lastEventAt = Math.max(r.lastEventAt ?? 0, x.ts);
      });
      st.offset = res.offset;
      st.size = res.size;
      st.mtimeMs = res.mtimeMs;
      return st;
    },
  };
}

// ---- helpers ---------------------------------------------------------------------------------------

let home: string;
let clock: ManualClock;
const stores: RunStore[] = [];

function line(o: object) {
  return `${JSON.stringify(o)}\n`;
}

function writeRun(agent: string, name: string, records: object[]) {
  const dir = path.join(home, agent);
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${name}.jsonl`);
  writeFileSync(p, records.map(line).join(''));
  return p;
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), firstRunComplete: true, ...patch };
}

function makeStore(adapters: SourceAdapter[], extra: Partial<ConstructorParameters<typeof RunStore>[0]> = {}) {
  const store = new RunStore({
    adapters,
    env: { platform: process.platform, home, vars: {} },
    tempDir: path.join(home, '.tmp'),
    clock,
    watch: null,
    ...extra,
  });
  const updates: RunsUpdate[] = [];
  const notices: RunFinishedNotice[] = [];
  store.on('runsUpdate', (u) => updates.push(u));
  store.on('runFinished', (n) => notices.push(n));
  stores.push(store);
  return { store, updates, notices };
}

/** Lets pending I/O settle, then fires the flush timer. */
async function settle(store: RunStore, ms = 0) {
  await store.whenIdle();
  clock.advance(ms);
  await store.whenIdle();
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'arm-store-'));
  clock = new ManualClock(Date.now());
});

afterEach(async () => {
  for (const s of stores.splice(0)) await s.stop();
  rmSync(home, { recursive: true, force: true });
});

const T = () => clock.now();

// ---- tests -----------------------------------------------------------------------------------------

describe('RunStore', () => {
  it('loads every discovered run and sends one full update, newest first', async () => {
    writeRun('claude-code', 'alpha', [{ ts: T() - 5000, kind: 'user', text: 'Add a login page' }, { ts: T() - 4000, kind: 'end' }]);
    writeRun('claude-code', 'beta', [{ ts: T() - 3000, kind: 'user', text: 'Fix the tests' }]);
    writeRun('codex', 'gamma', [{ ts: T() - 2000, kind: 'user', text: 'Write docs' }, { ts: T() - 1000, kind: 'error' }]);
    const a = fakeAdapter('claude-code');
    const b = fakeAdapter('codex');
    const { store, updates } = makeStore([a, b]);
    await store.start(settings());
    await settle(store, 1);

    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.full).toBe(true);
    expect(u.upserts.map((r) => r.title).sort()).toEqual(['Add a login page', 'Fix the tests', 'Write docs']);
    expect(u.progress).toEqual({ parsed: 3, total: 3 });
    const byTitle = Object.fromEntries(u.upserts.map((r) => [r.title, r]));
    expect(byTitle['Add a login page'].status).toBe('idle');
    expect(byTitle['Fix the tests'].status).toBe('running');
    expect(byTitle['Write docs'].status).toBe('failed');
    expect(byTitle['Write docs'].agent).toBe('codex');
    const list = store.listRuns();
    expect(list).toHaveLength(3);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].updatedAt).toBeGreaterThanOrEqual(list[i].updatedAt);
  });

  it('sends a full, empty update when nothing is found', async () => {
    const { store, updates } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);
    expect(updates).toEqual([{ upserts: [], removed: [], full: true, progress: { parsed: 0, total: 0 } }]);
  });

  it('parses appended lines incrementally, from the previous offset', async () => {
    const p = writeRun('claude-code', 'live', [{ ts: T(), kind: 'user', text: 'Refactor the parser' }]);
    const a = fakeAdapter('claude-code');
    const { store, updates } = makeStore([a]);
    await store.start(settings());
    await settle(store, 1);
    expect(updates).toHaveLength(1);
    const firstOffset = (await stat(p)).size;

    appendFileSync(p, line({ ts: T(), kind: 'assistant', text: 'On it' }) + line({ ts: T(), kind: 'tool', text: 'npm test' }));
    store.notifyChanged('claude-code', [p]);
    clock.advance(100); // change debounce
    await settle(store, 1000);

    expect(updates).toHaveLength(2);
    const u = updates[1];
    expect(u.full).toBe(false);
    expect(u.upserts).toHaveLength(1);
    expect(u.upserts[0].counts.events).toBe(3);
    expect(u.upserts[0].currentTool).toBe('Bash');
    const last = a.calls.parses.at(-1)!;
    expect(last.hadPrev).toBe(true);
    expect(last.offset).toBe(firstOffset);
  });

  it('picks up new and changed runs on the slow poll', async () => {
    const p = writeRun('claude-code', 'one', [{ ts: T(), kind: 'user', text: 'First' }]);
    const { store, updates } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);

    appendFileSync(p, line({ ts: T(), kind: 'end' }));
    writeRun('claude-code', 'two', [{ ts: T(), kind: 'user', text: 'Second' }]);
    await store.pollNow();
    await settle(store, 1000);

    expect(updates).toHaveLength(2);
    expect(updates[1].upserts.map((r) => r.title).sort()).toEqual(['First', 'Second']);
    expect(store.listRuns()).toHaveLength(2);
  });

  it('reports runs whose file disappeared as removed', async () => {
    const p = writeRun('claude-code', 'gone', [{ ts: T(), kind: 'user', text: 'Temporary' }]);
    writeRun('claude-code', 'kept', [{ ts: T(), kind: 'user', text: 'Kept' }]);
    const { store, updates } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);
    const goneId = updates[0].upserts.find((r) => r.title === 'Temporary')!.id;

    rmSync(p);
    await store.pollNow();
    await settle(store, 1000);

    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ upserts: [], removed: [goneId], full: false });
    expect(store.listRuns().map((r) => r.title)).toEqual(['Kept']);
    expect(await store.getDetail(goneId)).toBeNull();
  });

  it('honours the flush interval: one batched update per interval, 5 s while hidden', async () => {
    const p1 = writeRun('claude-code', 'a', [{ ts: T(), kind: 'user', text: 'A' }]);
    const p2 = writeRun('claude-code', 'b', [{ ts: T(), kind: 'user', text: 'B' }]);
    const { store, updates } = makeStore([fakeAdapter('claude-code')]);
    store.setUpdateInterval(1000);
    await store.start(settings());
    await settle(store, 1);
    expect(updates).toHaveLength(1);

    appendFileSync(p1, line({ ts: T(), kind: 'assistant', text: 'x' }));
    await store.pollNow();
    await settle(store, 300);
    appendFileSync(p2, line({ ts: T(), kind: 'assistant', text: 'y' }));
    await store.pollNow();
    await settle(store, 300);
    expect(updates).toHaveLength(1); // still inside the 1000 ms window
    await settle(store, 400);
    expect(updates).toHaveLength(2);
    expect(updates[1].upserts.map((r) => r.title).sort()).toEqual(['A', 'B']);

    // The renderer cannot push the interval below 250 ms.
    store.setUpdateInterval(10);
    expect(store.flushInterval).toBe(250);

    store.setHidden(true);
    expect(store.flushInterval).toBe(5000);
    appendFileSync(p1, line({ ts: T(), kind: 'assistant', text: 'z' }));
    await store.pollNow();
    await settle(store, 4000);
    expect(updates).toHaveLength(2);
    await settle(store, 1100);
    expect(updates).toHaveLength(3);

    store.setHidden(false);
    expect(store.flushInterval).toBe(250);
  });

  it('fires a finish notice only for a transition seen live', async () => {
    const live = writeRun('claude-code', 'live', [{ ts: T(), kind: 'user', text: 'Build it' }, { ts: T(), kind: 'tool', text: 'make' }]);
    writeRun('claude-code', 'old-done', [{ ts: T() - 600_000, kind: 'user', text: 'Old' }, { ts: T() - 590_000, kind: 'end' }]);
    writeRun('claude-code', 'old-failed', [{ ts: T(), kind: 'user', text: 'Broke' }, { ts: T(), kind: 'error' }]);
    const { store, notices, updates } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);
    expect(updates[0].upserts.find((r) => r.title === 'Build it')!.status).toBe('running');
    expect(notices).toHaveLength(0);

    // Nothing changes: re-judging the same state is not a transition.
    clock.advance(2000);
    await settle(store, 1000);
    expect(notices).toHaveLength(0);

    appendFileSync(live, line({ ts: T(), kind: 'result' }) + line({ ts: T(), kind: 'end' }));
    await store.pollNow();
    await settle(store, 1000);
    expect(notices).toHaveLength(1);
    expect(notices[0].outcome).toBe('done');
    expect(notices[0].run.title).toBe('Build it');
    expect(notices[0].run.status).toBe('idle');

    // idle -> done later is not another notice (it was not running).
    clock.advance(4 * 60_000);
    await settle(store, 1000);
    expect(store.listRuns().find((r) => r.title === 'Build it')!.status).toBe('done');
    expect(notices).toHaveLength(1);
  });

  it('notices a run going stuck through the status clock alone', async () => {
    writeRun('claude-code', 'slow', [{ ts: T(), kind: 'user', text: 'Long job' }, { ts: T(), kind: 'tool', text: 'sleep' }]);
    const { store, notices } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);
    expect(notices).toHaveLength(0);
    clock.advance(13 * 60_000); // past the 12-minute shell threshold; the status clock ticks every 2 s
    await settle(store, 1000);
    expect(notices.map((n) => n.outcome)).toEqual(['stuck']);
  });

  it('leaves out disabled sources, and adds or drops them when settings change', async () => {
    writeRun('claude-code', 'c1', [{ ts: T(), kind: 'user', text: 'Claude run' }]);
    writeRun('codex', 'x1', [{ ts: T(), kind: 'user', text: 'Codex run' }]);
    const codex = fakeAdapter('codex');
    const { store, updates } = makeStore([fakeAdapter('claude-code'), codex]);
    const s = settings();
    s.sources.codex = { enabled: false, customRoots: [] };
    await store.start(s);
    await settle(store, 1);
    expect(updates[0].upserts.map((r) => r.title)).toEqual(['Claude run']);
    expect(codex.calls.discovers).toBe(0);
    expect(codex.calls.parses).toHaveLength(0);

    const on = settings();
    await store.updateSettings(on);
    await settle(store, 1000);
    expect(store.listRuns().map((r) => r.title).sort()).toEqual(['Claude run', 'Codex run']);
    const codexId = store.listRuns().find((r) => r.agent === 'codex')!.id;

    const off = settings();
    off.sources.codex = { enabled: false, customRoots: [] };
    await store.updateSettings(off);
    await settle(store, 1000);
    expect(store.listRuns().map((r) => r.title)).toEqual(['Claude run']);
    expect(updates.at(-1)!.removed).toEqual([codexId]);
  });

  it('reads custom roots added in settings', async () => {
    const custom = path.join(home, 'elsewhere');
    mkdirSync(custom, { recursive: true });
    writeFileSync(path.join(custom, 'extra.jsonl'), line({ ts: T(), kind: 'user', text: 'From a custom folder' }));
    const { store } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);
    expect(store.listRuns()).toHaveLength(0);
    const s = settings();
    s.sources['claude-code'] = { enabled: true, customRoots: [custom] };
    await store.updateSettings(s);
    await settle(store, 1000);
    expect(store.listRuns().map((r) => r.title)).toEqual(['From a custom folder']);
    const sources = await store.getSources(true);
    const cc = sources.find((x) => x.agent === 'claude-code')!;
    expect(cc.customRoots).toEqual([{ path: custom, exists: true }]);
    expect(cc.defaultRoots).toEqual([{ path: path.join(home, 'claude-code'), exists: false }]);
    expect(cc.runCount).toBe(1);
  });

  it('masks secrets by default and unmasks when the setting is turned off', async () => {
    const key = ['sk', 'ant', 'api03', 'Z'.repeat(32)].join('-');
    writeRun('claude-code', 'secret', [{ ts: T(), kind: 'user', text: `Use ${key} for the call` }]);
    const { store, updates } = makeStore([fakeAdapter('claude-code')]);
    await store.start(settings());
    await settle(store, 1);
    const id = updates[0].upserts[0].id;
    expect(updates[0].upserts[0].title).not.toContain(key);
    expect(updates[0].upserts[0].title).toContain('••••');
    const masked = await store.getDetail(id);
    expect(masked!.events[0].text).not.toContain(key);

    const details: string[] = [];
    store.on('runDetail', (d) => details.push(d.events[0].text));
    store.watchRuns([id]);
    await store.updateSettings(settings({ maskSecrets: false }));
    await settle(store, 1000);
    expect(updates.at(-1)!.upserts[0].title).toContain(key);
    expect(details.at(-1)).toContain(key);
    expect((await store.getDetail(id))!.events[0].text).toContain(key);
  });

  it('turns an adapter that throws into an unreadable run without stopping the others', async () => {
    writeRun('claude-code', 'fine', [{ ts: T(), kind: 'user', text: 'Fine run' }]);
    writeRun('claude-code', 'cursed', [{ ts: T(), kind: 'user', text: 'Cursed run' }]);
    writeRun('codex', 'boom', [{ ts: T(), kind: 'user', text: 'Explodes' }, { ts: T(), kind: 'boom' }]);
    writeRun('gemini-cli', 'g', [{ ts: T(), kind: 'user', text: 'Never listed' }]);
    const { store, updates } = makeStore([
      fakeAdapter('claude-code', { throwOn: /cursed/ }),
      fakeAdapter('codex'),
      fakeAdapter('gemini-cli', { discoverThrows: true }),
    ]);
    await store.start(settings());
    await settle(store, 1);
    const runs = updates[0].upserts;
    expect(runs).toHaveLength(3);
    const fine = runs.find((r) => r.title === 'Fine run')!;
    expect(fine.status).toBe('running');
    const cursed = runs.find((r) => r.sourcePath.includes('cursed'))!;
    expect(cursed.status).toBe('unreadable');
    expect(cursed.readError).toMatch(/cannot read that/);
    expect(cursed.projectName).toBe('cursed');
    const boom = runs.find((r) => r.agent === 'codex')!;
    expect(boom.status).toBe('unreadable');
    const sources = await store.getSources();
    expect(sources.find((s) => s.agent === 'gemini-cli')!.error).toMatch(/exploded/);
  });

  it('pushes detail for watched runs only, batched with the list', async () => {
    const p = writeRun('claude-code', 'w', [{ ts: T(), kind: 'user', text: 'Watched' }]);
    const q = writeRun('claude-code', 'u', [{ ts: T(), kind: 'user', text: 'Unwatched' }]);
    const { store } = makeStore([fakeAdapter('claude-code')]);
    const details: { title: string; events: number }[] = [];
    store.on('runDetail', (d) => details.push({ title: d.summary.title, events: d.events.length }));
    await store.start(settings());
    await settle(store, 1);
    const id = store.listRuns().find((r) => r.title === 'Watched')!.id;
    const d0 = await store.getDetail(id, 10);
    expect(d0!.events).toHaveLength(1);
    store.watchRuns([id]);

    appendFileSync(p, line({ ts: T(), kind: 'assistant', text: 'Reply' }));
    appendFileSync(q, line({ ts: T(), kind: 'assistant', text: 'Reply' }));
    await store.pollNow();
    await settle(store, 1000);
    expect(details).toEqual([{ title: 'Watched', events: 2 }]);
  });

  it('sends every run detail of one flush in one runDetails batch', async () => {
    const pa = writeRun('claude-code', 'a', [{ ts: T(), kind: 'user', text: 'Run A' }]);
    const pb = writeRun('claude-code', 'b', [{ ts: T(), kind: 'user', text: 'Run B' }]);
    const { store } = makeStore([fakeAdapter('claude-code')]);
    const batches: string[][] = [];
    const singles: string[] = [];
    store.on('runDetails', (ds) => batches.push(ds.map((d) => d.summary.title).sort()));
    store.on('runDetail', (d) => singles.push(d.summary.title));
    await store.start(settings());
    await settle(store, 1);
    store.watchRuns(store.listRuns().map((r) => r.id));

    appendFileSync(pa, line({ ts: T(), kind: 'assistant', text: 'Reply' }));
    appendFileSync(pb, line({ ts: T(), kind: 'assistant', text: 'Reply' }));
    await store.pollNow();
    await settle(store, 1000);
    expect(batches).toEqual([['Run A', 'Run B']]);
    expect(singles.sort()).toEqual(['Run A', 'Run B']);

    // Nothing changed: no empty batch.
    await settle(store, 5000);
    expect(batches).toHaveLength(1);
  });

  it('pushes unfocused watched runs at most every slowMs and never drops their change', async () => {
    const pa = writeRun('claude-code', 'a', [{ ts: T(), kind: 'user', text: 'Focused' }]);
    const pb = writeRun('claude-code', 'b', [{ ts: T(), kind: 'user', text: 'Slow' }]);
    const { store } = makeStore([fakeAdapter('claude-code')]);
    const got: { at: number; title: string; events: number }[] = [];
    store.on('runDetails', (ds) => {
      for (const d of ds) got.push({ at: clock.now(), title: d.summary.title, events: d.events.length });
    });
    await store.start(settings());
    await settle(store, 1);
    const ids = Object.fromEntries(store.listRuns().map((r) => [r.title, r.id]));
    store.watchRuns([ids.Focused, ids.Slow]);
    store.setWatchPriority([ids.Focused], 3000);
    const bump = async (n: number) => {
      appendFileSync(pa, line({ ts: T(), kind: 'assistant', text: `a${n}` }));
      appendFileSync(pb, line({ ts: T(), kind: 'assistant', text: `b${n}` }));
      await store.pollNow();
      await settle(store, 300);
    };

    // First change: both go out (the slow run has not been pushed yet).
    await bump(1);
    const t1 = got.find((g) => g.title === 'Slow')!.at;
    expect(got.map((g) => g.title).sort()).toEqual(['Focused', 'Slow']);
    got.length = 0;

    // Changes within slowMs: the focused run every flush, the slow run held back.
    await bump(2);
    await bump(3);
    expect(got.map((g) => g.title)).toEqual(['Focused', 'Focused']);
    expect(clock.now()).toBeLessThan(t1 + 3000);

    // Once slowMs has passed, the held change goes out on its own, with every event so far.
    await settle(store, t1 + 3000 - clock.now() + 1);
    const slow = got.filter((g) => g.title === 'Slow');
    expect(slow).toHaveLength(1);
    expect(slow[0].at).toBeGreaterThanOrEqual(t1 + 3000);
    expect(slow[0].events).toBe(4);
    got.length = 0;

    // Clearing the priority (slowMs 0) makes every watched run fast again.
    store.setWatchPriority([], 0);
    await bump(4);
    expect(got.map((g) => g.title).sort()).toEqual(['Focused', 'Slow']);
  });

  it('sends a held-back change at the next flush when its run becomes focused', async () => {
    writeRun('claude-code', 'a', [{ ts: T(), kind: 'user', text: 'A' }]);
    const pb = writeRun('claude-code', 'b', [{ ts: T(), kind: 'user', text: 'B' }]);
    const { store } = makeStore([fakeAdapter('claude-code')]);
    const got: string[] = [];
    store.on('runDetails', (ds) => got.push(...ds.map((d) => d.summary.title)));
    await store.start(settings());
    await settle(store, 1);
    const ids = Object.fromEntries(store.listRuns().map((r) => [r.title, r.id]));
    store.watchRuns([ids.A, ids.B]);
    store.setWatchPriority([ids.A], 10_000);
    appendFileSync(pb, line({ ts: T(), kind: 'assistant', text: 'one' }));
    await store.pollNow();
    await settle(store, 300);
    expect(got).toEqual(['B']); // first push of B is not held
    got.length = 0;

    appendFileSync(pb, line({ ts: T(), kind: 'assistant', text: 'two' }));
    await store.pollNow();
    await settle(store, 300);
    expect(got).toEqual([]); // held: B was pushed less than 10 s ago

    store.setWatchPriority([ids.B], 10_000);
    await settle(store, 300);
    expect(got).toEqual(['B']);
  });

  it('re-parses active runs on a live-signal change and ignores irrelevant paths', async () => {
    writeRun('claude-code', 'busy', [{ ts: T(), kind: 'user', text: 'Still working' }]);
    const old = writeRun('claude-code', 'finished', [{ ts: T() - 600_000, kind: 'user', text: 'Old' }, { ts: T() - 600_000, kind: 'end' }]);
    utimesSync(old, new Date(T() - 600_000), new Date(T() - 600_000));
    const a = Object.assign(fakeAdapter('claude-code'), {
      isLiveSignal: (p: string) => p.endsWith('registry.json'),
      isRelevantChange: (p: string) => !p.includes('cache'),
    });
    const { store } = makeStore([a]);
    await store.start(settings());
    await settle(store, 1);
    const parsesBefore = a.calls.parses.length;
    const discoversBefore = a.calls.discovers;

    store.notifyChanged('claude-code', [path.join(home, 'claude-code', 'cache', 'blob.bin')]);
    await settle(store, 5000);
    expect(a.calls.parses.length).toBe(parsesBefore);
    expect(a.calls.discovers).toBe(discoversBefore);

    store.notifyChanged('claude-code', [path.join(home, 'sessions', 'registry.json')]);
    await settle(store, 5000);
    const reparsed = a.calls.parses.slice(parsesBefore).map((c) => path.basename(c.path));
    expect(reparsed).toEqual(['busy.jsonl']);
  });

  it('notices appended lines through the real file watcher', async () => {
    const p = writeRun('claude-code', 'watched', [{ ts: Date.now(), kind: 'user', text: 'Watch me' }]);
    const store = new RunStore({
      adapters: [fakeAdapter('claude-code')],
      env: { platform: process.platform, home, vars: {} },
      tempDir: path.join(home, '.tmp'),
    });
    stores.push(store);
    const updates: RunsUpdate[] = [];
    store.on('runsUpdate', (u) => updates.push(u));
    await store.start(settings());
    const wait = async (ok: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    };
    const seen = (events: number) => updates.some((u) => u.upserts.some((r) => r.counts.events === events));
    await wait(() => seen(1));
    expect(updates[0].full).toBe(true);
    expect(seen(1)).toBe(true);
    // Give the watcher a moment to be ready before writing.
    await new Promise((r) => setTimeout(r, 300));
    appendFileSync(p, line({ ts: Date.now(), kind: 'assistant', text: 'Seen' }));
    await wait(() => seen(2));
    expect(seen(2)).toBe(true);
    expect(updates.every((u, i) => u.full === (i === 0))).toBe(true);
  }, 15_000);
});
