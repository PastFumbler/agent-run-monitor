// The six theme presets as plain token tables. These tables are the single source of truth:
// applyTheme() turns them into CSS variables and contrast.test.ts checks every pair that matters.
// Colours are plain #rrggbb only (the test parses them). Keep palettes soft and low-saturation;
// status colours carry a shape as well (StatusMark), so colour is never the only signal.

import type { ThemeId } from '@shared/settings';
import type { RunStatus } from '@shared/schema';

export interface ThemeTokens {
  /** App background (behind panels). */
  bg: string;
  /** Panels: sidebar, run view. */
  surface: string;
  /** Cards, menus, dialogs, chips. */
  raised: string;
  /** Selected row / pressed chip background. Text and status marks sit on it. */
  selected: string;
  /** Hover background (decoration only; text on it is the same as on surface). */
  hover: string;
  text: string;
  textMuted: string;
  /** Non-essential decoration only (dividers in text, placeholder dots). Never for text people must read. */
  textFaint: string;
  /** Hairlines between areas (decoration). */
  border: string;
  /** Input and control borders: 3:1 against surfaces. */
  borderStrong: string;
  focus: string;
  accent: string;
  /** Text on an accent background. */
  accentText: string;
  /** Status colours for marks and icons (3:1). */
  status: Record<RunStatus, string>;
  /** Status colours safe for text (4.5:1). */
  statusText: Record<RunStatus, string>;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  scheme: 'light' | 'dark';
  /** One line for the picker. */
  blurb: string;
  tokens: ThemeTokens;
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  paper: {
    id: 'paper',
    name: 'Paper',
    scheme: 'light',
    blurb: 'Warm off-white, ink-blue accent',
    tokens: {
      bg: '#f4f2ec',
      surface: '#faf9f5',
      raised: '#ffffff',
      selected: '#e6ebf2',
      hover: '#efede6',
      text: '#26241f',
      textMuted: '#5b574e',
      textFaint: '#a29d91',
      border: '#e2ded4',
      borderStrong: '#847e70',
      focus: '#2f6db0',
      accent: '#3b6896',
      accentText: '#ffffff',
      status: {
        running: '#3788c7',
        waiting: '#ad792c',
        idle: '#535b62',
        done: '#599055',
        failed: '#cf6258',
        stuck: '#9c73b4',
        unreadable: '#289190',
      },
      statusText: {
        running: '#026ca8',
        waiting: '#8d5d0d',
        idle: '#535b62',
        done: '#3d733b',
        failed: '#ae453e',
        stuck: '#7e5796',
        unreadable: '#017372',
      },
    },
  },
  sage: {
    id: 'sage',
    name: 'Sage',
    scheme: 'light',
    blurb: 'Pale green-grey, leaf accent',
    tokens: {
      bg: '#edf1ea',
      surface: '#f5f7f2',
      raised: '#fbfcf9',
      selected: '#dfe9de',
      hover: '#e7ece3',
      text: '#222821',
      textMuted: '#525b51',
      textFaint: '#97a194',
      border: '#d9e0d5',
      borderStrong: '#79837a',
      focus: '#2c6c54',
      accent: '#3d6b55',
      accentText: '#ffffff',
      status: {
        running: '#3385c4',
        waiting: '#aa7629',
        idle: '#50585f',
        done: '#568d53',
        failed: '#cc5f55',
        stuck: '#9970b1',
        unreadable: '#248e8d',
      },
      statusText: {
        running: '#0569a3',
        waiting: '#8a5b09',
        idle: '#50585f',
        done: '#3a7038',
        failed: '#ab423b',
        stuck: '#7c5594',
        unreadable: '#09706f',
      },
    },
  },
  dawn: {
    id: 'dawn',
    name: 'Dawn',
    scheme: 'light',
    blurb: 'Soft peach, dusty-rose accent',
    tokens: {
      bg: '#f7efea',
      surface: '#fbf6f2',
      raised: '#fffcfa',
      selected: '#f1e0df',
      hover: '#f3e9e3',
      text: '#2b2224',
      textMuted: '#63545a',
      textFaint: '#ad9a9c',
      border: '#ead9d3',
      borderStrong: '#8d787b',
      focus: '#8a3f5a',
      accent: '#8b4a5f',
      accentText: '#ffffff',
      status: {
        running: '#3284c3',
        waiting: '#a77427',
        idle: '#4f575e',
        done: '#548b51',
        failed: '#ca5d53',
        stuck: '#976faf',
        unreadable: '#218c8b',
      },
      statusText: {
        running: '#0168a2',
        waiting: '#885906',
        idle: '#4f575e',
        done: '#396f37',
        failed: '#a84039',
        stuck: '#7a5392',
        unreadable: '#036e6d',
      },
    },
  },
  dusk: {
    id: 'dusk',
    name: 'Dusk',
    scheme: 'dark',
    blurb: 'Blue-violet evening, periwinkle accent',
    tokens: {
      bg: '#1c1d24',
      surface: '#23252e',
      raised: '#2b2d38',
      selected: '#323a52',
      hover: '#292b35',
      text: '#e6e7ee',
      textMuted: '#a9acbc',
      textFaint: '#5c5f72',
      border: '#363946',
      borderStrong: '#7a7f98',
      focus: '#a3b5f5',
      accent: '#8fa3e6',
      accentText: '#161826',
      status: {
        running: '#5c98d0',
        waiting: '#b68c43',
        idle: '#bac4cb',
        done: '#6ba067',
        failed: '#dc756d',
        stuck: '#aa85bf',
        unreadable: '#46a19f',
      },
      statusText: {
        running: '#72ace6',
        waiting: '#cda156',
        idle: '#bac4cb',
        done: '#7fb57a',
        failed: '#f38a81',
        stuck: '#bf9ad5',
        unreadable: '#5db6b4',
      },
    },
  },
  moss: {
    id: 'moss',
    name: 'Moss',
    scheme: 'dark',
    blurb: 'Deep forest green, fern accent',
    tokens: {
      bg: '#1a1f1b',
      surface: '#202722',
      raised: '#28302a',
      selected: '#2e3d33',
      hover: '#252d27',
      text: '#e3e9e2',
      textMuted: '#a6b3a7',
      textFaint: '#56645a',
      border: '#323d35',
      borderStrong: '#76867a',
      focus: '#a5d6b1',
      accent: '#8cc49a',
      accentText: '#13201a',
      status: {
        running: '#5a96ce',
        waiting: '#b48b41',
        idle: '#b9c2ca',
        done: '#6a9e65',
        failed: '#da746c',
        stuck: '#a884bd',
        unreadable: '#449f9d',
      },
      statusText: {
        running: '#71abe4',
        waiting: '#cb9f55',
        idle: '#b9c2ca',
        done: '#7eb379',
        failed: '#f28980',
        stuck: '#be98d3',
        unreadable: '#5bb4b2',
      },
    },
  },
  harbor: {
    id: 'harbor',
    name: 'Harbor',
    scheme: 'dark',
    blurb: 'Night-water blue, sea-glass accent',
    tokens: {
      bg: '#162027',
      surface: '#1c2830',
      raised: '#24313a',
      selected: '#2a3e4b',
      hover: '#212e37',
      text: '#e1ebf0',
      textMuted: '#a1b3bd',
      textFaint: '#52646f',
      border: '#2e3e49',
      borderStrong: '#71879a',
      focus: '#94d4e3',
      accent: '#7cbfcf',
      accentText: '#0f1d23',
      status: {
        running: '#5d99d1',
        waiting: '#b78d43',
        idle: '#bcc5cc',
        done: '#6ca168',
        failed: '#dd776e',
        stuck: '#ab86c0',
        unreadable: '#47a2a0',
      },
      statusText: {
        running: '#74aee8',
        waiting: '#cea257',
        idle: '#bcc5cc',
        done: '#80b67b',
        failed: '#f58b82',
        stuck: '#c09bd5',
        unreadable: '#5eb7b5',
      },
    },
  },
};

export const THEME_LIST: ThemeDef[] = Object.values(THEMES);

/** CSS custom property name for each token. Status tokens become --status-<s> and --status-<s>-text. */
export function themeToCssVars(t: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {
    '--bg': t.bg,
    '--surface': t.surface,
    '--raised': t.raised,
    '--selected': t.selected,
    '--hover': t.hover,
    '--text': t.text,
    '--text-muted': t.textMuted,
    '--text-faint': t.textFaint,
    '--border': t.border,
    '--border-strong': t.borderStrong,
    '--focus': t.focus,
    '--accent': t.accent,
    '--accent-text': t.accentText,
  };
  for (const [s, c] of Object.entries(t.status)) vars[`--status-${s}`] = c;
  for (const [s, c] of Object.entries(t.statusText)) vars[`--status-${s}-text`] = c;
  return vars;
}

/** The whole theme stylesheet: one `:root[data-theme=...]` block per preset. */
export function themeStylesheet(): string {
  return THEME_LIST.map((th) => {
    const body = Object.entries(themeToCssVars(th.tokens))
      .map(([k, v]) => `${k}:${v};`)
      .join('');
    return `:root[data-theme="${th.id}"]{color-scheme:${th.scheme};${body}}`;
  }).join('\n');
}
