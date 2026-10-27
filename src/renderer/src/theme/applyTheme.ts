// Puts the theme tokens on <html>. The stylesheet (one :root[data-theme] block per preset) is built
// from themes.ts and installed once as a constructable stylesheet: that is CSSOM, so it works under
// a strict Content-Security-Policy with no inline <style>. Where constructable sheets are missing
// (old test DOMs), the active theme's variables are written straight onto <html> instead.

import type { Density, Settings, TextSize, ThemeId } from '@shared/settings';
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

export function applyTheme(id: ThemeId): void {
  install();
  const root = document.documentElement;
  const theme = THEMES[id] ?? THEMES.paper;
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

export function applyLook(s: Pick<Settings, 'theme' | 'textSize' | 'density'>): void {
  applyTheme(s.theme);
  applyTextSize(s.textSize);
  applyDensity(s.density);
}
