// Run folders in the real app: changes go over IPC to main, which saves them in the app's own
// settings.json (userData) and returns the saved settings. A malformed change is refused by the IPC
// validation, and the fake agent home is never written.

import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { baseSettings, launchApp, removeDir, tempDir, type Launched } from './helpers';

let home = '';
let launched: Launched | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

test('folders are saved in the app settings over IPC and survive a restart', async () => {
  home = tempDir('home');
  launched = await launchApp({ home, settings: baseSettings() });
  const { page, userData } = launched;
  await expect(page.locator('#main')).toBeAttached({ timeout: 45_000 });

  const result = await page.evaluate(async () => {
    const b = window.armBackend!;
    const created = await b.editFolders({ kind: 'create', name: 'Client work' });
    const moved = await b.editFolders({ kind: 'move', runIds: ['claude-code:abc'], folderId: created.folderId! });
    const dup = await b.editFolders({ kind: 'create', name: 'client WORK' });
    let refused = '';
    try {
      await b.editFolders({ kind: 'explode' } as never);
    } catch (e) {
      refused = String(e);
    }
    // A plain settings patch keeps the folders (both writes go through main one at a time).
    const [patched] = await Promise.all([b.setSettings({ theme: 'moss' }), b.editFolders({ kind: 'create', name: 'Side' })]);
    const after = await b.getSettings();
    return { created, moved, dup, refused, patchedTheme: patched.theme, after };
  });

  expect(result.created.error).toBeUndefined();
  expect(result.moved.settings.runFolders).toEqual({ 'claude-code:abc': result.created.folderId });
  expect(result.dup.error).toBe('There is already a folder called "Client work".');
  expect(result.refused).toMatch(/bad folder change/);
  expect(result.patchedTheme).toBe('moss');
  expect(result.after.folders.map((f) => f.name)).toEqual(['Client work', 'Side']);
  expect(result.after.theme).toBe('moss');

  const onDisk = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  expect(onDisk.folders.map((f: { name: string }) => f.name)).toEqual(['Client work', 'Side']);
  expect(onDisk.runFolders).toEqual({ 'claude-code:abc': result.created.folderId });
  // Read-only toward agent files: the fake home is still empty.
  expect(readdirSync(home)).toEqual([]);

  // Restart with the same settings file: the folders load back.
  const saved = readFileSync(path.join(userData, 'settings.json'), 'utf8');
  await launched.close();
  launched = await launchApp({ home, settings: JSON.parse(saved) });
  const again = await launched.page.evaluate(() => window.armBackend!.getSettings());
  expect(again.folders.map((f) => f.name)).toEqual(['Client work', 'Side']);
  expect(again.runFolders).toEqual({ 'claude-code:abc': result.created.folderId });
});
