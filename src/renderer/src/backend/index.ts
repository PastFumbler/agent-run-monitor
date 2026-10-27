// Picks the backend once: the Electron bridge when the preload exposed one, else the fixture
// (browser demo, e2e, screenshots). VITE_BACKEND=fixture forces the fixture.

import type { Backend } from '@shared/ipc';
import { ElectronBackend } from './electron';
import { FixtureBackend, fixtureOptionsFromUrl } from './fixture';

let instance: Backend | null = null;

export function isFixtureMode(): boolean {
  return import.meta.env.VITE_BACKEND === 'fixture' || typeof window === 'undefined' || !window.armBackend;
}

export function getBackend(): Backend {
  if (instance) return instance;
  if (!isFixtureMode() && window.armBackend) {
    instance = new ElectronBackend(window.armBackend);
  } else {
    const fixture = new FixtureBackend(fixtureOptionsFromUrl(typeof location === 'undefined' ? '' : location.search));
    if (typeof window !== 'undefined') window.__armFixture = fixture.controls();
    instance = fixture;
  }
  return instance;
}

/** Tests only: swap in a backend. */
export function setBackendForTests(b: Backend | null): void {
  instance = b;
}
