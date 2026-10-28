// The theme checks: which colour pairs must meet WCAG AA, and how far apart the status colours must
// be. contrast.test.ts runs them on every preset (a failing preset cannot ship); the custom theme
// editor runs the same checks live and names the pairs that fail.

import { RUN_STATUSES, type RunStatus } from '@shared/schema';
import { contrast, deltaE2000 } from './contrast';
import type { ThemeTokens } from './themes';

/** WCAG AA for normal text. */
export const TEXT_MIN = 4.5;
/** WCAG AA for non-text UI (marks, borders, focus ring). */
export const UI_MIN = 3.0;
/** Every pair of status colours must differ by at least this CIEDE2000 distance. */
export const STATUS_DELTA_E_MIN = 15;

/** A theme token: a plain key, or `status.<s>` / `statusText.<s>`. */
export type TokenKey = Exclude<keyof ThemeTokens, 'status' | 'statusText'> | `status.${RunStatus}` | `statusText.${RunStatus}`;

export interface Check {
  /** e.g. "text-muted on hover" (the test's failure message). */
  what: string;
  fgToken: TokenKey;
  bgToken: TokenKey;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
}

/** Every pair that must meet its minimum contrast. */
export function checksFor(t: ThemeTokens): Check[] {
  const surfaces: TokenKey[] = ['bg', 'surface', 'raised'];
  // Text and status marks also sit on selected rows.
  const textSurfaces: TokenKey[] = [...surfaces, 'selected', 'hover'];
  const out: Check[] = [];
  const add = (what: string, fgToken: TokenKey, list: TokenKey[], min: number) => {
    const fg = tokenValue(t, fgToken);
    for (const bgToken of list) {
      const bg = tokenValue(t, bgToken);
      out.push({ what: `${what} on ${bgToken}`, fgToken, bgToken, fg, bg, ratio: contrast(fg, bg), min });
    }
  };
  add('text', 'text', textSurfaces, TEXT_MIN);
  add('text-muted', 'textMuted', textSurfaces, TEXT_MIN);
  add('accent-text', 'accentText', ['accent'], TEXT_MIN);
  for (const s of RUN_STATUSES) {
    add(`status-${s}-text`, `statusText.${s}`, textSurfaces, TEXT_MIN);
    add(`status-${s}`, `status.${s}`, [...surfaces, 'selected'], UI_MIN);
  }
  add('border-strong', 'borderStrong', surfaces, UI_MIN);
  add('focus', 'focus', [...surfaces, 'selected'], UI_MIN);
  add('accent', 'accent', surfaces, UI_MIN);
  return out;
}

export interface StatusPair {
  a: RunStatus;
  b: RunStatus;
  deltaE: number;
}

/** Status colour pairs closer than STATUS_DELTA_E_MIN (hard to tell apart). */
export function closeStatusPairs(t: ThemeTokens): StatusPair[] {
  const out: StatusPair[] = [];
  for (let i = 0; i < RUN_STATUSES.length; i++) {
    for (let j = i + 1; j < RUN_STATUSES.length; j++) {
      const a = RUN_STATUSES[i];
      const b = RUN_STATUSES[j];
      const deltaE = deltaE2000(t.status[a], t.status[b]);
      if (deltaE < STATUS_DELTA_E_MIN) out.push({ a, b, deltaE });
    }
  }
  return out;
}

/** Light or dark: dark when the background has more contrast with white than with black. */
export function schemeOf(bg: string): 'light' | 'dark' {
  return contrast(bg, '#000000') < contrast(bg, '#ffffff') ? 'dark' : 'light';
}

export function tokenValue(t: ThemeTokens, key: TokenKey): string {
  if (key.startsWith('status.')) return t.status[key.slice(7) as RunStatus];
  if (key.startsWith('statusText.')) return t.statusText[key.slice(11) as RunStatus];
  return t[key as Exclude<keyof ThemeTokens, 'status' | 'statusText'>];
}
