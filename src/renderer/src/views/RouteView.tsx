// Route-level screens for the main area. Routes: 'run' | 'multiview' | 'settings' | 'wizard'.
// Later features replace the placeholder components; the routing stays as it is.

import { MultiView } from '../features/multiview/MultiView';
import { RunView } from '../features/runview/RunView';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { Wizard } from '../features/wizard/Wizard';
import { useStore } from '../store/store';

export function RunScreen({ nav }: { nav: string[] }) {
  const currentId = useStore((s) => s.currentId);
  const runsLoaded = useStore((s) => s.runsLoaded);
  const total = useStore((s) => s.order.length);
  if (!currentId) {
    return (
      <div className="runview">
        <div className="runview__empty">
          {!runsLoaded ? (
            <p>Loading runs…</p>
          ) : total === 0 ? (
            <>
              <h1 style={{ fontSize: '1.2rem', color: 'var(--text)' }}>No runs yet</h1>
              <p>
                Start a coding agent (Claude Code, Codex, Gemini CLI, Copilot, Aider, Cursor…) and its session appears here
                live. Agent Run Monitor only reads; it never changes agent files.
              </p>
            </>
          ) : (
            <p>Pick a run from the list, or press Ctrl+K to find one.</p>
          )}
        </div>
      </div>
    );
  }
  return <RunView key="runview" runId={currentId} nav={nav} />;
}

export function RouteView({ nav }: { nav: string[] }) {
  const route = useStore((s) => s.route);
  switch (route) {
    case 'multiview':
      return <MultiView />;
    case 'settings':
      return <SettingsScreen />;
    case 'wizard':
      return <Wizard />;
    case 'run':
    default:
      return <RunScreen nav={nav} />;
  }
}
