// Puts the theme tokens on <html>. The stylesheet (one :root[data-theme] block per preset) is built
// from themes.ts and installed once as a constructable stylesheet: that is CSSOM, so it works under
// a strict Content-Security-Policy with no inline <style>. Where constructable sheets are missing
// (old test DOMs), the active theme's variables are written straight onto <html> instead.
// A custom theme is never in the stylesheet: its variables go straight onto <html> (CSSOM again),
// with data-theme="custom", and are removed when a preset is picked again.

import type { CustomTheme, Density, Settings, TextSize, ThemeId } from '@shared/settings';
import { schemeOf } from './checks';
import { customTokens } from './custom';
import { THEMES, themeStylesheet, themeToCssVars } from './themes';

let installed: 'sheet' | 'inline' | null = null;

function install(): void {
  if (installed) return;
  try {
    const Sheet = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
    if (Sheet && 'adoptedStyleSheets' in document && 'replaceSync' in Sheet.prototype) {
      const sheet = new Sheet();
      sheet.replaceSync(themeStylesheet());
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      installed = 'sheet';
      return;
    }
  } catch {
    /* fall through to inline variables */
  }
  installed = 'inline';
}

let inlineCustom = false;

export function applyTheme(id: ThemeId, custom?: CustomTheme | null): void {
  install();
  const root = document.documentElement;
  if (custom) {
    for (const [k, v] of Object.entries(themeToCssVars(customTokens(custom)))) root.style.setProperty(k, v);
    const scheme = schemeOf(custom.bg);
    root.style.colorScheme = scheme;
    root.dataset.theme = 'custom';
    root.dataset.scheme = scheme;
    inlineCustom = true;
    return;
  }
  const theme = THEMES[id] ?? THEMES.paper;
  if (inlineCustom) {
    // Back to a preset: drop the custom variables so the preset's stylesheet block applies.
    for (const k of Object.keys(themeToCssVars(theme.tokens))) root.style.removeProperty(k);
    root.style.removeProperty('color-scheme');
    inlineCustom = false;
  }
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;
  if (installed === 'inline') {
    for (const [k, v] of Object.entries(themeToCssVars(theme.tokens))) root.style.setProperty(k, v);
    root.style.colorScheme = theme.scheme;
  }
}

export function applyTextSize(size: TextSize): void {
  document.documentElement.dataset.textSize = size;
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
}

export function applyLook(s: Pick<Settings, 'theme' | 'textSize' | 'density'> & Partial<Pick<Settings, 'customTheme' | 'useCustomTheme'>>): void {
  applyTheme(s.theme, s.useCustomTheme ? s.customTheme : null);
  applyTextSize(s.textSize);
  applyDensity(s.density);
}
