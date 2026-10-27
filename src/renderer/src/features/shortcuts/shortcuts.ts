// Every keyboard shortcut, in one table: the cheat sheet renders it and tooltips quote it.

export interface ShortcutDef {
  id: string;
  keys: string[][];
  label: string;
  group: 'Runs' | 'Views' | 'Multiviewer' | 'App';
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'prev', keys: [['←'], ['[']], label: 'Previous run', group: 'Runs' },
  { id: 'next', keys: [['→'], [']']], label: 'Next run', group: 'Runs' },
  { id: 'down', keys: [['j']], label: 'Move list selection down', group: 'Runs' },
  { id: 'up', keys: [['k']], label: 'Move list selection up', group: 'Runs' },
  { id: 'open', keys: [['Enter']], label: 'Open selected run', group: 'Runs' },
  { id: 'pin', keys: [['p']], label: 'Pin or unpin run', group: 'Runs' },
  { id: 'search', keys: [['/']], label: 'Search runs', group: 'Runs' },
  { id: 'openRuns', keys: [['g', 'a']], label: 'All runs (organise into folders)', group: 'Runs' },
  { id: 'view1', keys: [['1']], label: 'Activity view', group: 'Views' },
  { id: 'view2', keys: [['2']], label: 'Overview', group: 'Views' },
  { id: 'view3', keys: [['3']], label: 'Files view', group: 'Views' },
  { id: 'view4', keys: [['4']], label: 'Tools view', group: 'Views' },
  { id: 'view5', keys: [['5']], label: 'Timeline view', group: 'Views' },
  { id: 'multi', keys: [['m']], label: 'Add or remove run from the multiviewer', group: 'Multiviewer' },
  { id: 'openMulti', keys: [['g', 'm']], label: 'Open the multiviewer', group: 'Multiviewer' },
  { id: 'maximize', keys: [['f']], label: 'Maximise focused tile', group: 'Multiviewer' },
  { id: 'tileMove', keys: [['←'], ['→']], label: 'Focus the previous or next tile', group: 'Multiviewer' },
  { id: 'tileView', keys: [['1'], ['5']], label: 'Switch the view of the focused tile (1 to 5)', group: 'Multiviewer' },
  { id: 'tilePage', keys: [['PageUp'], ['PageDown']], label: 'Previous or next page of tiles', group: 'Multiviewer' },
  { id: 'palette', keys: [[MOD, 'K']], label: 'Command palette', group: 'App' },
  { id: 'settings', keys: [[MOD, ',']], label: 'Settings', group: 'App' },
  { id: 'cheats', keys: [['?']], label: 'Keyboard shortcuts', group: 'App' },
  { id: 'escape', keys: [['Esc']], label: 'Close overlays, restore tiles', group: 'App' },
];

/** "←" or "Ctrl+K" style text for tooltips. */
export function shortcutText(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) return '';
  return s.keys.map((combo) => combo.join(combo.length > 1 && combo[0] !== 'g' ? '+' : ' then ')).join(' or ');
}
