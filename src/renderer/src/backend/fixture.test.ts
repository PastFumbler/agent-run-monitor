// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
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

  it('firstrun scenario starts with the wizard', async () => {
    fx = new FixtureBackend({ scenario: 'firstrun', now: NOW, live: false, fresh: true });
    expect((await fx.getSettings()).firstRunComplete).toBe(false);
  });
});
