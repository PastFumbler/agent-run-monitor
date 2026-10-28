// The custom theme: the user picks background, surface, text, accent and the seven status colours;
// every other token is worked out here. Derived text colours (muted text, status text, control
// borders, focus) are nudged toward full contrast until they meet the same minimums the presets
// must meet, so the checks only fail when a picked colour itself is the problem (or can't be
// rescued). Pure functions; the editor (features/settings/CustomThemeSection.tsx) and applyTheme use them.

import { RUN_STATUSES, type RunStatus } from '@shared/schema';
import type { CustomTheme } from '@shared/settings';
import { checksFor, closeStatusPairs, schemeOf, TEXT_MIN, UI_MIN, type Check, type StatusPair } from './checks';
import { contrast, parseHex } from './contrast';
import type { ThemeTokens } from './themes';

const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** a mixed toward b: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

/** `fg`, moved toward `toward` in small steps until it meets `min` against every background (or reaches `toward`). */
function ensure(fg: string, toward: string, bgs: string[], min: number): string {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = mix(fg, toward, Math.min(1, t));
    if (bgs.every((bg) => contrast(c, bg) >= min)) return c;
  }
  return toward;
}

/** The picked colours of a full token set (the editor starts from the theme in use). */
export function pickedColours(t: ThemeTokens): CustomTheme {
  return { bg: t.bg, surface: t.surface, text: t.text, accent: t.accent, status: { ...t.status } };
}

/** Every theme token, worked out from the picked colours. */
export function customTokens(c: CustomTheme): ThemeTokens {
  const dark = schemeOf(c.bg) === 'dark';
  // Text sits at this end of the scale: derived text colours move toward it when they need more contrast.
  const far = dark ? '#ffffff' : '#000000';
  const raised = mix(c.surface, '#ffffff', dark ? 0.05 : 0.6);
  const hover = mix(c.surface, c.text, 0.06);
  const selected = mix(c.surface, c.accent, dark ? 0.22 : 0.1);
  const surfaces = [c.bg, c.surface, raised];
  const textSurfaces = [...surfaces, selected, hover];
  const statusText = {} as Record<RunStatus, string>;
  for (const s of RUN_STATUSES) statusText[s] = ensure(c.status[s], far, textSurfaces, TEXT_MIN);
  const accentText = ['#ffffff', c.text, c.bg].reduce((best, x) => (contrast(x, c.accent) > contrast(best, c.accent) ? x : best));
  return {
    bg: c.bg,
    surface: c.surface,
    raised,
    selected,
    hover,
    text: c.text,
    textMuted: ensure(mix(c.text, c.surface, 0.32), c.text, textSurfaces, TEXT_MIN),
    textFaint: mix(c.text, c.bg, 0.55),
    border: mix(c.surface, c.text, 0.12),
    borderStrong: ensure(mix(c.surface, c.text, 0.5), c.text, surfaces, UI_MIN),
    focus: ensure(c.accent, far, [...surfaces, selected], UI_MIN),
    accent: c.accent,
    accentText,
    status: { ...c.status },
    statusText,
  };
}

export interface ThemeReport {
  scheme: 'light' | 'dark';
  /** Pairs below their WCAG AA minimum. */
  failing: Check[];
  /** Status colours too alike to tell apart. */
  closeStatus: StatusPair[];
}

/** The live check of a custom theme: the same pairs and thresholds contrast.test.ts holds every preset to. */
export function checkCustomTheme(c: CustomTheme): ThemeReport {
  const tokens = customTokens(c);
  return {
    scheme: schemeOf(c.bg),
    failing: checksFor(tokens).filter((x) => x.ratio < x.min),
    closeStatus: closeStatusPairs(tokens),
  };
}

export const problemCount = (r: ThemeReport): number => r.failing.length + r.closeStatus.length;
