import { describe, expect, it } from 'vitest';
import { AGENT_IDS, type SourceStatus } from '@shared/schema';
import { defaultSettings } from '@shared/settings';
import {
  addFolder,
  CONFIDENCE,
  detectionSummary,
  historyLabel,
  isFound,
  lowGpuStateText,
  patchSource,
  reduceMotionStateText,
  refreshLabel,
  removeFolder,
  updateResultText,
} from './describe';
import { isRunShortcut } from './keys';

const src = (o: Partial<SourceStatus>): SourceStatus => ({
  agent: 'codex',
  displayName: 'Codex',
  enabled: true,
  defaultRoots: [{ path: '/home/u/.codex', exists: false }],
  customRoots: [],
  runCount: 0,
  note: '',
  confidence: 'source',
  ...o,
});

describe('settings wording', () => {
  it('explains each confidence level in plain words', () => {
    expect(CONFIDENCE.verified.explain).toBe('Verified on a real install');
    expect(CONFIDENCE.source.explain).toBe("Checked against the tool's source code");
    expect(CONFIDENCE['best-effort'].explain).toBe('Best effort — experimental');
  });

  it('labels refresh and history choices', () => {
    expect(refreshLabel(1000)).toBe('1 s');
    expect(refreshLabel(30000)).toBe('30 s');
    expect(historyLabel(0)).toBe('All');
    expect(historyLabel(1)).toBe('1 day');
    expect(historyLabel(7)).toBe('1 week');
    expect(historyLabel(14)).toBe('2 weeks');
    expect(historyLabel(90)).toBe('90 days');
  });

  it('says why low-GPU mode is on or off', () => {
    const battery = { onBattery: true, powerSaver: false, known: true };
    const ac = { onBattery: false, powerSaver: false, known: true };
    expect(lowGpuStateText('auto', battery, true)).toBe("Low GPU mode is currently ON because you're on battery.");
    expect(lowGpuStateText('auto', ac, false)).toBe("Low GPU mode is currently OFF because you're plugged in.");
    expect(lowGpuStateText('auto', { ...ac, powerSaver: true }, true)).toMatch(/energy saver/);
    expect(lowGpuStateText('auto', null, false)).toMatch(/doesn't say whether it's on battery/);
    expect(lowGpuStateText('auto', { ...battery, known: false }, false)).toMatch(/Auto stays off/);
    expect(lowGpuStateText('on', ac, true)).toBe('Low GPU mode is currently ON because you turned it on.');
    expect(lowGpuStateText('off', battery, false)).toBe('Low GPU mode is currently OFF because you turned it off.');
  });

  it('says why motion is reduced or not', () => {
    expect(reduceMotionStateText('auto', true)).toMatch(/reduced because your system/);
    expect(reduceMotionStateText('auto', false)).toMatch(/currently on/);
    expect(reduceMotionStateText('on', true)).toMatch(/reduced because you turned this on/);
    expect(reduceMotionStateText('off', false)).toMatch(/currently on because you turned this off/);
  });

  it('words update check results', () => {
    expect(updateResultText({ current: '0.1.0', error: 'offline' })).toBe('offline');
    expect(updateResultText({ current: '0.1.0', latest: '0.2.0' })).toBe('Version 0.2.0 is available (you have 0.1.0).');
    expect(updateResultText({ current: '0.2.0', latest: '0.2.0' })).toBe("You're up to date (version 0.2.0).");
  });
});

describe('source and folder edits', () => {
  it('patchSource returns a full record and changes only one agent', () => {
    const s = defaultSettings().sources;
    s.codex.customRoots = ['/a'];
    const next = patchSource(s, 'codex', { enabled: false });
    expect(Object.keys(next).sort()).toEqual([...AGENT_IDS].sort());
    expect(next.codex).toEqual({ enabled: false, customRoots: ['/a'] });
    expect(next['claude-code']).toEqual(s['claude-code']);
    expect(next).not.toBe(s);
    expect(next.codex.customRoots).not.toBe(s.codex.customRoots);
    expect(s.codex.enabled).toBe(true);
  });

  it('addFolder ignores empty, duplicate and trailing-slash duplicates; removeFolder removes', () => {
    const list = ['/home/u/code'];
    expect(addFolder(list, null)).toBe(list);
    expect(addFolder(list, '  ')).toBe(list);
    expect(addFolder(list, '/home/u/code/')).toBe(list);
    expect(addFolder(list, '/home/u/other')).toEqual(['/home/u/code', '/home/u/other']);
    expect(removeFolder(['/a', '/b'], '/a')).toEqual(['/b']);
  });

  it('detection summary counts runs and the agents that have them', () => {
    const list = [
      src({ agent: 'codex', runCount: 3, defaultRoots: [{ path: '/c', exists: true }] }),
      src({ agent: 'claude-code', runCount: 1 }),
      src({ agent: 'aider', runCount: 0, defaultRoots: [{ path: '/x', exists: true }] }),
      src({ agent: 'cursor' }),
    ];
    expect(detectionSummary(list)).toMatchObject({ runs: 4, agents: 2, text: 'We found 4 runs from 2 agents.' });
    expect(detectionSummary([src({ runCount: 1 })]).text).toBe('We found 1 run from 1 agent.');
    expect(detectionSummary([src({})]).text).toMatch(/appears here within seconds/);
    expect(isFound(list[2])).toBe(true);
    expect(isFound(list[3])).toBe(false);
    expect(isFound(src({ customRoots: [{ path: '/y', exists: true }] }))).toBe(true);
  });
});

describe('form screens keep run shortcuts to themselves', () => {
  it('stops run-navigation keys but lets Esc and modified keys through', () => {
    const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
      isRunShortcut({ key, ctrlKey: false, metaKey: false, altKey: false, ...mod });
    for (const key of ['ArrowLeft', 'ArrowRight', '[', ']', 'j', 'k', 'p', 'm', 'g', 'f', '1', '5', 'Enter']) expect(k(key)).toBe(true);
    for (const key of ['Escape', '?', '/', 'Tab', ' ']) expect(k(key)).toBe(false);
    expect(k('k', { ctrlKey: true })).toBe(false);
    expect(k(',', { metaKey: true })).toBe(false);
  });
});
