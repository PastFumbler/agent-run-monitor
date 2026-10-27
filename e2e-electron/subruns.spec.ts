// Sub-agent and workflow runs in the real app, from the Claude Code fixture (a session with one
// sub-agent and one workflow run that has its own agent). The Overview of each run links its
// relatives: the session lists its sub-runs, the workflow shows both its session ("Part of") and
// its agent ("Sub-runs"), and a leaf shows its parent.

import { expect, test } from '@playwright/test';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { baseSettings, launchApp, openRunById, relatedRunCounts, REPO, removeDir, tempDir, waitForRuns, type Launched } from './helpers';

let home = '';
let launched: Launched | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

test('session, workflow and agent runs link to each other in Overview', async () => {
  home = tempDir('home');
  cpSync(path.join(REPO, 'test/fixtures/claude-code/claude-config'), path.join(home, '.claude'), { recursive: true });
  launched = await launchApp({ home, settings: baseSettings({ historyDays: 0 }) });
  const { app, page } = launched;
  await waitForRuns(page, 1);

  type R = { id: string; parentId?: string };
  let runs: R[] = [];
  await expect
    .poll(async () => {
      runs = await page.evaluate(async () => {
        const b = (window as unknown as { armBackend: { listRuns(): Promise<{ id: string; parentId?: string }[]> } }).armBackend;
        return (await b.listRuns()).map((r) => ({ id: r.id, parentId: r.parentId }));
      });
      return runs.filter((r) => r.parentId).length;
    })
    .toBeGreaterThanOrEqual(3);
  const ids = new Set(runs.map((r) => r.id));
  const kids = runs.filter((r) => r.parentId && ids.has(r.parentId));
  const parents = new Set(kids.map((k) => k.parentId!));
  const isChild = (id: string) => kids.some((k) => k.id === id);
  const top = [...parents].filter((p) => !isChild(p));
  const middle = [...parents].filter((p) => isChild(p));
  const leaves = kids.filter((k) => !parents.has(k.id));
  expect(top.length).toBe(1);
  expect(middle.length).toBe(1);
  expect(leaves.length).toBeGreaterThanOrEqual(2);
  const childrenOf = (p: string) => kids.filter((k) => k.parentId === p).length;

  await openRunById(app, page, top[0]);
  expect(await relatedRunCounts(page)).toEqual({ partOf: 0, subRuns: childrenOf(top[0]) });

  // The workflow run: before the fix it showed only "Part of" and hid its own agents.
  await openRunById(app, page, middle[0]);
  expect(await relatedRunCounts(page)).toEqual({ partOf: 1, subRuns: childrenOf(middle[0]) });

  for (const leaf of leaves) {
    await openRunById(app, page, leaf.id);
    expect(await relatedRunCounts(page)).toEqual({ partOf: 1, subRuns: 0 });
  }

  // Clicking a sub-run opens it.
  await openRunById(app, page, middle[0]);
  await page.getByRole('radio', { name: 'Overview', exact: true }).first().click();
  const sub = page.getByTestId('view-overview').locator('section').filter({ has: page.getByRole('heading', { name: 'Sub-runs', exact: true }) });
  await sub.getByRole('button').first().click();
  await expect.poll(async () => page.locator('.runview').getAttribute('data-run-id')).not.toBe(middle[0]);
  expect(launched.errors).toEqual([]);
});
