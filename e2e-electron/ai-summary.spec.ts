// AI summaries in the real app, without any network call: the API key goes over IPC to main, is
// stored encrypted in userData (never in settings.json, never readable back), malformed keys and
// providers are refused by the IPC validation, and a summary is refused while the setting is off or
// no key is saved. No test here lets main reach a provider.

import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { baseSettings, launchApp, removeDir, tempDir, type Launched } from './helpers';

let home = '';
let launched: Launched | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

// Assembled at runtime so no realistic-looking key is ever committed.
const KEY = ['sk', 'ant', 'e2e', 'q'.repeat(30)].join('-');

test('the API key stays in main, encrypted; summaries are refused while off or without a key', async () => {
  home = tempDir('home');
  launched = await launchApp({ home, settings: baseSettings() });
  const { page, userData } = launched;
  await expect(page.locator('#main')).toBeAttached({ timeout: 45_000 });

  const r = await page.evaluate(async (key) => {
    const b = window.armBackend!;
    const before = await b.aiStatus();
    const off = await b.summarizeRun('claude-code:none');
    await b.setSettings({ aiSummaries: true });
    const noKey = await b.summarizeRun('claude-code:none');
    const refused: string[] = [];
    for (const bad of [
      () => b.setAiKey('anthropic', 'short'),
      () => b.setAiKey('someone' as never, key),
      () => b.summarizeRun(42 as never),
    ]) {
      try {
        await bad();
      } catch (e) {
        refused.push(String(e));
      }
    }
    const saved = await b.setAiKey('anthropic', key);
    // Unknown run with a key: refused before any request.
    const gone = await b.summarizeRun('claude-code:none');
    const switched = await b.setSettings({ aiProvider: 'openai' });
    return { before, off, noKey, refused, saved, gone, switched, settings: await b.getSettings() };
  }, KEY);

  expect(r.before.keys).toEqual({ anthropic: false, openai: false });
  expect(r.off.error).toBe('AI summaries are off in Settings.');
  expect(r.noKey.error).toMatch(/^No Anthropic API key is saved/);
  expect(r.refused).toHaveLength(3);
  expect(r.refused[0]).toMatch(/bad api key/);
  expect(r.refused[0]).not.toContain(KEY);
  expect(r.refused[1]).toMatch(/bad provider/);
  expect(r.refused[2]).toMatch(/bad run id/);
  expect(r.saved.keys).toEqual({ anthropic: true, openai: false });
  expect(JSON.stringify(r.saved)).not.toContain(KEY);
  expect(r.gone.error).toBe('That run is no longer available.');
  // Changing the provider turns AI summaries off (main enforces it, not just the screen).
  expect(r.switched.aiSummaries).toBe(false);
  expect(JSON.stringify(r.settings)).not.toContain(KEY);

  // On disk: encrypted when the OS offers it, else not written at all; never in settings.json.
  const keysFile = path.join(userData, 'ai-keys.json');
  if (r.saved.secure) {
    expect(existsSync(keysFile)).toBe(true);
    const onDisk = readFileSync(keysFile, 'utf8');
    expect(onDisk).not.toContain(KEY);
    expect(JSON.parse(onDisk).anthropic).toEqual(expect.any(String));
  } else {
    expect(existsSync(keysFile)).toBe(false);
  }
  expect(readFileSync(path.join(userData, 'settings.json'), 'utf8')).not.toContain(KEY);
  expect(readdirSync(home)).toEqual([]);

  // Removing the key.
  const removed = await page.evaluate(() => window.armBackend!.setAiKey('anthropic', null));
  expect(removed.keys.anthropic).toBe(false);
});
