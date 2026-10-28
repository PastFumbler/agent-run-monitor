// Every theme must pass these checks; a failing theme fails CI and cannot ship (docs/PLAN.md 5.5).
// The pairs and thresholds live in checks.ts, which the custom theme editor uses too.
import { describe, expect, it } from 'vitest';
import { THEME_IDS } from '@shared/settings';
import { checksFor, closeStatusPairs, schemeOf, STATUS_DELTA_E_MIN, TEXT_MIN, UI_MIN } from './checks';
import { contrast, deltaE2000Lab } from './contrast';
import { THEMES } from './themes';

describe('colour maths', () => {
  it('holds themes to WCAG AA and a clear status difference', () => {
    expect([TEXT_MIN, UI_MIN, STATUS_DELTA_E_MIN]).toEqual([4.5, 3, 15]);
  });
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
  it('matches Sharma et al. CIEDE2000 test data', () => {
    const cases: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
      [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, want] of cases) expect(deltaE2000Lab(a, b)).toBeCloseTo(want, 3);
  });
});

describe.each(THEME_IDS.map((id) => [id]))('theme %s', (id) => {
  const theme = THEMES[id];

  it('is defined with every token as plain hex', () => {
    expect(theme.id).toBe(id);
    const all = [
      ...Object.entries(theme.tokens).filter(([, v]) => typeof v === 'string'),
      ...Object.entries(theme.tokens.status),
      ...Object.entries(theme.tokens.statusText),
    ];
    for (const [k, v] of all) expect(v, k).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('meets WCAG contrast for text (4.5) and UI (3.0)', () => {
    const failures = checksFor(theme.tokens)
      .filter((c) => c.ratio < c.min)
      .map((c) => `${c.what}: ${c.fg} vs ${c.bg} = ${c.ratio.toFixed(2)} (needs ${c.min})`);
    expect(failures).toEqual([]);
  });

  it('keeps every pair of status colours distinguishable (CIEDE2000 >= 15)', () => {
    expect(closeStatusPairs(theme.tokens).map((p) => `${p.a}/${p.b}: ΔE ${p.deltaE.toFixed(1)}`)).toEqual([]);
  });

  it('has a light/dark scheme that matches its background', () => {
    expect(theme.scheme).toBe(schemeOf(theme.tokens.bg));
  });
});
