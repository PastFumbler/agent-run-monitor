// The global keyboard layer (see shortcuts.ts for the table). Ignored while typing in inputs,
// except Esc and Ctrl/Cmd+K. While an overlay is open only Esc (and the overlay's own keys) apply.

import { useEffect, useRef } from 'react';
import { RUN_VIEWS } from '@shared/settings';
import { openRunWithDefaultView, togglePin } from '../../store/actions';
import { useStore } from '../../store/store';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** `getNav` returns the current filtered list order (ids). */
export function useShortcuts(getNav: () => string[]): void {
  const pendingG = useRef<number>(0);
  const navRef = useRef(getNav);
  navRef.current = getNav;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;

      if (mod && (key === 'k' || key === 'K')) {
        e.preventDefault();
        st.setOverlay(st.overlay === 'palette' ? 'none' : 'palette');
        return;
      }
      // A focused control (view switcher, list) already handled this key.
      if (e.defaultPrevented) return;
      if (key === 'Escape') {
        if (st.overlay !== 'none') {
          e.preventDefault();
          st.setOverlay('none');
        } else if (st.maximizedTile) {
          st.toggleMaximizeFocused();
        } else if (st.route === 'settings') {
          st.setRoute(st.lastRoute === 'multiview' ? 'multiview' : 'run');
        }
        return;
      }
      if (st.overlay !== 'none' || isTyping(e.target) || e.altKey) return;
      if (mod && key === ',') {
        e.preventDefault();
        st.setRoute('settings');
        return;
      }
      if (mod) return;

      // "g then m" opens the multiviewer.
      if (pendingG.current && Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        if (key === 'm') {
          e.preventDefault();
          st.setRoute('multiview');
          return;
        }
      }
      if (key === 'g') {
        pendingG.current = Date.now();
        return;
      }

      const nav = navRef.current();
      const current = st.currentId;
      const step = (d: number, base: string | null) => {
        if (!nav.length) return null;
        const i = base ? nav.indexOf(base) : -1;
        if (i < 0) return nav[d > 0 ? 0 : nav.length - 1];
        const j = i + d;
        return j >= 0 && j < nav.length ? nav[j] : null;
      };

      switch (key) {
        case 'ArrowLeft':
        case '[': {
          if (st.route === 'wizard') return;
          const id = step(-1, current);
          if (id) openRunWithDefaultView(id);
          e.preventDefault();
          return;
        }
        case 'ArrowRight':
        case ']': {
          if (st.route === 'wizard') return;
          const id = step(1, current);
          if (id) openRunWithDefaultView(id);
          e.preventDefault();
          return;
        }
        case 'j':
        case 'k': {
          const id = step(key === 'j' ? 1 : -1, st.cursorId ?? current);
          if (id) st.setCursor(id);
          e.preventDefault();
          return;
        }
        case 'Enter': {
          // Only when focus isn't on a control that handles Enter itself.
          const t = e.target as HTMLElement | null;
          if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return;
          if (st.cursorId) {
            openRunWithDefaultView(st.cursorId);
            e.preventDefault();
          }
          return;
        }
        case 'p':
          if (current) void togglePin(current);
          return;
        case 'm': {
          const id = st.cursorId ?? current;
          if (id) st.toggleMulti(id);
          return;
        }
        case 'f':
          // Multiviewer: maximise / restore the focused tile (Esc also restores, above).
          if (st.route === 'multiview') {
            e.preventDefault();
            st.toggleMaximizeFocused();
          }
          return;
        case '?':
          e.preventDefault();
          st.setOverlay('cheatsheet');
          return;
        case '/':
          e.preventDefault();
          st.focusSearch();
          return;
        default:
          if (/^[1-5]$/.test(key) && st.route === 'run') {
            st.setView(RUN_VIEWS[Number(key) - 1]);
            e.preventDefault();
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
