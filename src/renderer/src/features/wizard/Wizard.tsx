// TODO(wizard): the first-run wizard (docs/PLAN.md section 7). Routed already: App shows route
// 'wizard' when settings.firstRunComplete is false (try ?scenario=firstrun in the browser demo).
//
// What the real one needs, and where it plugs in:
// 1. Welcome + the three-line privacy promise.
// 2. Detection: getBackend().getSources(true); per agent: path, run count, on/off; pickFolder() for
//    custom roots; save with updateSettings({ sources }).
// 3. Look: THEME_LIST previews, synonyms and fake-progress toggles.
// 4. Done: updateSettings({ firstRunComplete: true }), then setRoute('run') and open the newest run.

import { updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';

export function Wizard() {
  const setRoute = useStore((s) => s.setRoute);
  return (
    <div className="placeholder" data-testid="wizard-placeholder">
      <h1>Welcome to Agent Run Monitor</h1>
      <p>It reads the session files your coding agents write, read-only and on this computer only. Nothing is sent anywhere.</p>
      <p>The full setup wizard arrives in the next build.</p>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          void updateSettings({ firstRunComplete: true });
          setRoute('run');
        }}
      >
        Start watching
      </button>
    </div>
  );
}
