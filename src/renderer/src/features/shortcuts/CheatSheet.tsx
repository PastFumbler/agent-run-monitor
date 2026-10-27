import { Modal } from '../../components/Modal';
import { useStore } from '../../store/store';
import { SHORTCUTS, type ShortcutDef } from './shortcuts';

const GROUPS: ShortcutDef['group'][] = ['Runs', 'Views', 'Multiviewer', 'App'];

export function CheatSheet() {
  const setOverlay = useStore((s) => s.setOverlay);
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={() => setOverlay('none')}
      headerExtra={
        <button type="button" className="btn btn--ghost" style={{ marginLeft: 'auto' }} onClick={() => setOverlay('none')}>
          Close <span className="kbd">Esc</span>
        </button>
      }
    >
      <div className="dialog__body">
        <div className="cheats">
          {GROUPS.map((g) => (
            <section key={g} style={{ display: 'contents' }}>
              <h3>{g}</h3>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div className="cheat" key={s.id}>
                  <span>{s.label}</span>
                  <span className="cheat__keys">
                    {s.keys.map((combo, i) => (
                      <span key={i} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                        {i > 0 ? <span className="muted">or</span> : null}
                        {combo.map((k, j) => (
                          <span key={j} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                            {j > 0 ? <span className="muted">{combo[0] === 'g' ? 'then' : '+'}</span> : null}
                            <kbd className="kbd">{k}</kbd>
                          </span>
                        ))}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: '0.85rem' }}>
          Shortcuts are ignored while you type in a text box. Press <span className="kbd">?</span> any time to see this list.
        </p>
      </div>
    </Modal>
  );
}
