// TODO(settings): the settings screen (docs/PLAN.md section 6). Routed already (route 'settings',
// Ctrl/Cmd+, or the palette; Esc returns to the run).
//
// What the real one needs, and where it plugs in:
// - Read: useStore(s => s.settings). Write: updateSettings(patch) from store/actions.ts (optimistic,
//   then the backend's normalised result).
// - Sources: getBackend().getSources(rescan) and pickFolder() for custom roots.
// - Look: THEME_LIST from theme/themes.ts (name, blurb, scheme, tokens for previews); text size and
//   density apply live through App's applyLook().
// - Motion: reduceMotion / lowGpu tri-states feed the motion policy automatically.
// - About: getBackend().appInfo(), checkForUpdate() (off by default; the only network call).

import { useStore } from '../../store/store';

export function SettingsScreen() {
  const setRoute = useStore((s) => s.setRoute);
  return (
    <div className="placeholder" data-testid="settings-placeholder">
      <h1>Settings</h1>
      <p>The settings screen arrives in the next build. Meanwhile the command palette (Ctrl+K) can switch themes and toggle low-GPU mode, reduced motion, synonyms and the fake progress bar.</p>
      <button type="button" className="btn" onClick={() => setRoute('run')}>
        Back to the run
      </button>
    </div>
  );
}
