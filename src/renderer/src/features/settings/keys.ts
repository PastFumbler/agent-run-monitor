// Full-screen routes (settings, wizard) are forms: run-navigation keys pressed there must not reach
// the global shortcut layer (← / → would open a run and leave the screen, p would pin, m would select).
// React's stopPropagation stops the native event at the root, so the window listener never sees it;
// default actions (scrolling, radio arrows, Space on a switch) still happen. Esc, Ctrl/Cmd+K, Ctrl/Cmd+,
// ? and / still pass through.

import type { KeyboardEvent } from 'react';

const RUN_KEYS = new Set(['ArrowLeft', 'ArrowRight', '[', ']', 'j', 'k', 'p', 'm', 'g', 'f', 'Enter', '1', '2', '3', '4', '5', '6']);

export function isRunShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && RUN_KEYS.has(e.key);
}

export function stopAppShortcuts(e: KeyboardEvent): void {
  if (isRunShortcut(e)) e.stopPropagation();
}
