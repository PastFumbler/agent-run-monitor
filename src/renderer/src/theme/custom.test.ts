import { describe, expect, it } from 'vitest';
import { THEME_IDS, normalizeCustomTheme, normalizeSettings } from '@shared/settings';
import { checksFor } from './checks';
import { contrast } from './contrast';
import { checkCustomTheme, customTokens, mix, pickedColours, problemCount } from './custom';
import { THEMES } from './themes';

describe('custom theme tokens', () => {
  it('mixes colours', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it.each(THEME_IDS.map((id) => [id]))('starting from %s passes every check', (id) => {
    const picked = pickedColours(THEMES[id].tokens);
    const report = checkCustomTheme(picked);
    expect(report.failing.map((c) => c.what)).toEqual([]);
    expect(report.closeStatus).toEqual([]);
    expect(report.scheme).toBe(THEMES[id].scheme);
    // The picked colours come through unchanged.
    const t = customTokens(picked);
    expect([t.bg, t.surface, t.text, t.accent]).toEqual([picked.bg, picked.surface, picked.text, picked.accent]);
    expect(t.status).toEqual(picked.status);
    for (const v of [...Object.values(t).filter((x) => typeof x === 'string'), ...Object.values(t.statusText)]) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('nudges derived text colours to meet AA when the picked colours allow it', () => {
    const picked = { ...pickedColours(THEMES.paper.tokens), status: { ...THEMES.paper.tokens.status, running: '#9ad0ff' } };
    const t = customTokens(picked);
    for (const bg of [t.bg, t.surface, t.raised, t.selected, t.hover]) expect(contrast(t.statusText.running, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('names failing pairs and status colours that are too alike', () => {
    const picked = pickedColours(THEMES.paper.tokens);
    const bad = { ...picked, text: '#b0aca0', status: { ...picked.status, stuck: picked.status.running } };
    const report = checkCustomTheme(bad);
    expect(report.failing.some((c) => c.fgToken === 'text' && c.bgToken === 'bg')).toBe(true);
    expect(report.closeStatus).toContainEqual(expect.objectContaining({ a: 'running', b: 'stuck' }));
    expect(problemCount(report)).toBe(report.failing.length + report.closeStatus.length);
  });

  it('uses the same pairs as the preset test', () => {
    const picked = pickedColours(THEMES.dusk.tokens);
    expect(checksFor(customTokens(picked)).map((c) => c.what)).toEqual(checksFor(THEMES.dusk.tokens).map((c) => c.what));
  });
});

describe('custom theme settings', () => {
  const picked = pickedColours(THEMES.moss.tokens);

  it('keeps a valid custom theme and lowercases it', () => {
    const upper = { ...picked, bg: picked.bg.toUpperCase() };
    expect(normalizeCustomTheme(upper)).toEqual(picked);
    const s = normalizeSettings({ customTheme: picked, useCustomTheme: true, displayTier: 'simple' });
    expect(s.customTheme).toEqual(picked);
    expect(s.useCustomTheme).toBe(true);
    expect(s.displayTier).toBe('simple');
  });

  it('drops a damaged custom theme and never uses a missing one', () => {
    expect(normalizeCustomTheme({ ...picked, accent: 'red' })).toBeNull();
    expect(normalizeCustomTheme({ ...picked, status: { ...picked.status, idle: undefined } })).toBeNull();
    expect(normalizeCustomTheme('nope')).toBeNull();
    const s = normalizeSettings({ customTheme: { bg: '#fff' }, useCustomTheme: true, displayTier: 'huge' });
    expect(s.customTheme).toBeNull();
    expect(s.useCustomTheme).toBe(false);
    expect(s.displayTier).toBe('default');
  });

  it('defaults to the full app and no custom theme', () => {
    const s = normalizeSettings({});
    expect([s.displayTier, s.customTheme, s.useCustomTheme]).toEqual(['default', null, false]);
  });
});
