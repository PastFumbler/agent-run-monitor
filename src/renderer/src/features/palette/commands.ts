// Commands the palette can run. Later features add theirs here (settings sections, layouts...).

import { THEME_IDS, type TriState } from '@shared/settings';
import { THEMES } from '../../theme/themes';
import { showAllRuns, showDashboard, showUsage, updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';
import { shortcutText } from '../shortcuts/shortcuts';

export interface Command {
  id: string;
  label: string;
  keywords: string;
  shortcut?: string;
  run(): void;
}

const nextTri = (t: TriState): TriState => (t === 'auto' ? 'on' : t === 'on' ? 'off' : 'auto');

export function getCommands(): Command[] {
  const st = useStore.getState();
  const s = st.settings;
  const cmds: Command[] = [
    { id: 'open-settings', label: 'Open settings', keywords: 'preferences options configure', shortcut: shortcutText('settings'), run: () => st.setRoute('settings') },
    {
      id: 'open-dashboard',
      label: 'Show the dashboard',
      keywords: 'home start overview running done failed waiting stuck summary',
      shortcut: shortcutText('openHome'),
      run: () => showDashboard(),
    },
    {
      id: 'open-usage',
      label: 'Show token usage',
      keywords: 'tokens usage input output cache per agent today week month',
      shortcut: shortcutText('openUsage'),
      run: () => showUsage(),
    },
    {
      id: 'open-all-runs',
      label: 'Show all runs',
      keywords: 'list organise organize folders move select viewer history',
      shortcut: shortcutText('openRuns'),
      run: () => showAllRuns(),
    },
    { id: 'open-multiview', label: 'Open the multiviewer', keywords: 'grid tiles multi view compare', shortcut: shortcutText('openMulti'), run: () => st.setRoute('multiview') },
    { id: 'show-shortcuts', label: 'Show keyboard shortcuts', keywords: 'keys cheat sheet help hotkeys', shortcut: '?', run: () => st.setOverlay('cheatsheet') },
    {
      id: 'toggle-low-gpu',
      label: `Low-GPU mode: ${s.lowGpu} → ${nextTri(s.lowGpu)}`,
      keywords: 'low gpu performance battery power saver toggle',
      run: () => void updateSettings({ lowGpu: nextTri(s.lowGpu) }),
    },
    {
      id: 'toggle-reduce-motion',
      label: `Reduce motion: ${s.reduceMotion} → ${nextTri(s.reduceMotion)}`,
      keywords: 'reduce motion animation accessibility toggle',
      run: () => void updateSettings({ reduceMotion: nextTri(s.reduceMotion) }),
    },
    {
      id: 'toggle-synonyms',
      label: s.synonyms ? 'Turn off running synonyms' : 'Turn on running synonyms',
      keywords: 'synonyms words fun cogitating toggle',
      run: () => void updateSettings({ synonyms: !s.synonyms }),
    },
    {
      id: 'toggle-fake-progress',
      label: s.fakeProgress ? 'Turn off the totally fake progress bar' : 'Turn on the totally fake progress bar',
      keywords: 'fake progress bar fun eta toggle',
      run: () => void updateSettings({ fakeProgress: !s.fakeProgress }),
    },
    { id: 'clear-filters', label: 'Clear run filters', keywords: 'reset filters search chips', run: () => st.clearFilters() },
    {
      id: 'focus-search',
      label: 'Search runs in the sidebar',
      keywords: 'find filter search',
      shortcut: '/',
      run: () => {
        if (st.route === 'runs') st.setRoute('run'); // All runs hides the sidebar
        st.focusSearch();
      },
    },
  ];
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    cmds.push({
      id: `theme-${id}`,
      label: `Switch theme: ${t.name}${s.theme === id ? ' (current)' : ''}`,
      keywords: `theme colour color appearance ${t.scheme} ${t.name.toLowerCase()} ${t.blurb.toLowerCase()}`,
      run: () => void updateSettings({ theme: id }),
    });
  }
  return cmds;
}

export function filterCommands(cmds: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return cmds;
  return cmds.filter((c) => {
    const h = `${c.label} ${c.keywords}`.toLowerCase();
    return words.every((w) => h.includes(w));
  });
}
