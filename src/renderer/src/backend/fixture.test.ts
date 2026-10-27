// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONFIDENCE } from '@shared/agents';
import { AGENT_IDS, RUN_STATUSES } from '@shared/schema';
import { buildDemo, detailOf } from './demoData';
import { FixtureBackend } from './fixture';

const NOW = Date.parse('2026-10-27T15:30:00Z');

describe('demo data', () => {
  it('covers every agent and every status, with ~40 runs', () => {
    const runs = buildDemo('demo', NOW);
    expect(runs.length).toBe(40);
    for (const a of AGENT_IDS) expect(runs.some((r) => r.summary.agent === a), a).toBe(true);
    for (const s of RUN_STATUSES) expect(runs.some((r) => r.summary.status === s), s).toBe(true);
    expect(runs.filter((r) => r.live).length).toBeGreaterThanOrEqual(3);
    expect(runs.some((r) => r.summary.parentId)).toBe(true);
  });

  it('is deterministic for the same seed and clock', () => {
    const a = buildDemo('demo', NOW).map((r) => [r.summary, r.events]);
    const b = buildDemo('demo', NOW).map((r) => [r.summary, r.events]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('has every event kind, tool results with errors, and counts that match the events', () => {
    const runs = buildDemo('demo', NOW);
    const kinds = new Set(runs.flatMap((r) => r.events.map((e) => e.kind)));
    for (const k of ['user', 'assistant', 'reasoning', 'tool_call', 'tool_result', 'file_change', 'error', 'system']) expect(kinds.has(k as never), k).toBe(true);
    expect(runs.some((r) => r.events.some((e) => e.kind === 'tool_result' && e.isError))).toBe(true);
    for (const r of runs) {
      const d = detailOf(r);
      expect(r.summary.counts.events).toBe(r.events.length);
      expect(r.summary.counts.toolCalls).toBe(d.tools.length);
      expect(r.summary.counts.filesChanged).toBe(d.files.length);
    }
    const unreadable = runs.find((r) => r.summary.status === 'unreadable')!;
    expect(unreadable.summary.readError).toBeTruthy();
  });

  it('has token usage per message, with per-day buckets, and "not reported" runs', () => {
    const runs = buildDemo('demo', NOW).filter((r) => r.events.length);
    for (const r of runs) {
      const u = r.summary.usage;
      if (r.summary.agent === 'cursor') {
        expect(u, r.summary.id).toBeUndefined(); // the source records none: never 0
        continue;
      }
      expect(u?.output, r.summary.id).toBeGreaterThan(0);
      const days = Object.values(u!.byDay!).reduce((n, d) => n + (d.output ?? 0), 0);
      expect(days).toBe(u!.output);
      expect(r.events.reduce((n, e) => n + (e.usage?.output ?? 0), 0)).toBe(u!.output);
    }
    expect(runs.some((r) => r.summary.usage?.cacheRead !== undefined)).toBe(true);
    expect(runs.some((r) => r.summary.usage && r.summary.usage.cacheRead === undefined)).toBe(true);
  });

  it('has code changes with diffs and line counts, and some with unknown counts', () => {
    const runs = buildDemo('demo', NOW);
    const changes = runs.flatMap((r) => detailOf(r).changes.map((c) => ({ c, agent: r.summary.agent })));
    expect(changes.length).toBeGreaterThan(10);
    for (const { c, agent } of changes) {
      if (agent === 'copilot-vscode') {
        expect([c.diff, c.linesAdded, c.linesRemoved]).toEqual([undefined, undefined, undefined]);
        continue;
      }
      const plus = c.diff!.split('\n').filter((l) => l.startsWith('+')).length;
      const minus = c.diff!.split('\n').filter((l) => l.startsWith('-')).length;
      expect([plus, minus]).toEqual([c.linesAdded, c.linesRemoved]);
    }
    expect(changes.some(({ agent }) => agent === 'copilot-vscode')).toBe(true);
    for (const r of runs) expect(detailOf(r).totalChanges).toBe(r.changes.length);
  });

  it('marks hidden reasoning as placeholders and flags runs with readable reasoning', () => {
    const runs = buildDemo('demo', NOW);
    const claude = runs.filter((r) => r.summary.agent === 'claude-code');
    expect(claude.some((r) => r.events.some((e) => e.kind === 'reasoning' && e.placeholder))).toBe(true);
    for (const r of runs) {
      expect(r.summary.hasReasoning).toBe(r.events.some((e) => e.kind === 'reasoning' && !e.placeholder));
    }
    expect(runs.some((r) => r.summary.hasReasoning)).toBe(true);
  });

  it('is synthetic: only the made-up /home/demo tree', () => {
    for (const r of buildDemo('many', NOW)) {
      expect(r.summary.sourcePath.startsWith('/home/demo/')).toBe(true);
      expect(r.summary.projectPath?.startsWith('/home/demo/code/') ?? true).toBe(true);
    }
    expect(buildDemo('many', NOW).length).toBe(300);
    expect(buildDemo('empty', NOW).length).toBe(0);
  });
});

describe('FixtureBackend', () => {
  let fx: FixtureBackend | null = null;
  afterEach(() => {
    fx?.controls().pause();
    fx = null;
  });

  it('implements the Backend calls and batches live updates', async () => {
    fx = new FixtureBackend({ scenario: 'demo', now: NOW, live: false, fresh: true });
    const runs = await fx.listRuns();
    expect(runs.length).toBe(40);
    const detail = await fx.getRun(runs[0].id);
    expect(detail?.summary.id).toBe(runs[0].id);
    expect((await fx.getSettings()).firstRunComplete).toBe(true);
    expect((await fx.setSettings({ theme: 'moss' })).theme).toBe('moss');
    expect((await fx.getSources()).length).toBe(AGENT_IDS.length);
    // Sources carry the adapters' real confidence and default folders, not made-up ones.
    const sources = await fx.getSources();
    for (const src of sources) expect(src.confidence, src.agent).toBe(AGENT_CONFIDENCE[src.agent]);
    expect(sources.find((x) => x.agent === 'qwen-code')!.defaultRoots[0].path).toBe('/home/demo/.qwen/projects');
    expect(sources.find((x) => x.agent === 'opencode')!.defaultRoots[0].path).toBe('/home/demo/.local/share/opencode');
    expect(await fx.pickFolder()).toMatch(/^\/home\/demo\//);
    expect((await fx.getPower()).known).toBe(true);
    expect((await fx.checkForUpdate()).error).toMatch(/no network/);

    const updates: string[][] = [];
    fx.onRunsUpdate((u) => updates.push(u.upserts.map((r) => r.id)));
    const finished: string[] = [];
    fx.onRunFinished((n) => finished.push(n.outcome));
    const live = runs.find((r) => r.status === 'running')!;
    const c = fx.controls();
    c.failRun(live.id);
    expect(updates.flat()).toContain(live.id);
    expect(finished).toEqual(['failed']);
    expect((await fx.getRun(live.id))?.summary.status).toBe('failed');

    fx.setUpdateInterval(1000);
    expect(c.updateInterval()).toBe(1000);
  });

  it('pushes details only for watched runs', async () => {
    fx = new FixtureBackend({ scenario: 'demo', now: NOW, live: false, fresh: true });
    const runs = await fx.listRuns();
    const live = runs.filter((r) => r.status === 'running');
    const got: string[] = [];
    fx.onRunDetail((d) => got.push(d.summary.id));
    fx.watchRuns([live[0].id]);
    const c = fx.controls();
    c.setStatus(live[0].id, 'stuck');
    c.setStatus(live[1].id, 'stuck');
    expect(got).toEqual([live[0].id]);
  });

  it('demo has made-up folders, and editFolders saves changes the way the real backend does', async () => {
    fx = new FixtureBackend({ scenario: 'demo', now: NOW, live: false, fresh: true });
    const s = await fx.getSettings();
    expect(s.folders.map((f) => f.name)).toEqual(['Client work', 'Side projects', 'Someday']);
    const filed = Object.keys(s.runFolders);
    expect(filed.length).toBeGreaterThan(0);
    const runIds = new Set((await fx.listRuns()).map((r) => r.id));
    for (const id of filed) expect(runIds.has(id)).toBe(true);

    const created = await fx.editFolders({ kind: 'create', name: 'Research' });
    expect(created.error).toBeUndefined();
    const id = created.folderId!;
    expect((await fx.editFolders({ kind: 'move', runIds: [filed[0]], folderId: id })).settings.runFolders[filed[0]]).toBe(id);
    expect((await fx.editFolders({ kind: 'create', name: 'research' })).error).toMatch(/already a folder/);
    const deleted = await fx.editFolders({ kind: 'delete', id });
    expect(deleted.settings.folders.some((f) => f.id === id)).toBe(false);
    expect(deleted.settings.runFolders[filed[0]]).toBeUndefined();
    // Deleting never removes runs.
    expect((await fx.listRuns()).length).toBe(runIds.size);
    // Saved like other settings: a new backend for the same scenario reads them back.
    const saved = JSON.parse(localStorage.getItem('arm.fixture.settings.demo') ?? '{}');
    expect(saved.folders.map((f: { name: string }) => f.name)).toEqual(['Client work', 'Side projects', 'Someday']);
    // Other scenarios start without folders.
    const empty = new FixtureBackend({ scenario: 'many', now: NOW, live: false, fresh: true });
    expect((await empty.getSettings()).folders).toEqual([]);
    empty.controls().pause();
  });

  it('firstrun scenario starts with the wizard', async () => {
    fx = new FixtureBackend({ scenario: 'firstrun', now: NOW, live: false, fresh: true });
    expect((await fx.getSettings()).firstRunComplete).toBe(false);
  });
});
