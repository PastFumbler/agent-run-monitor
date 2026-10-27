import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getBackend } from './backend';
import { useClock } from './store/clock';
import { applyLook } from './theme/applyTheme';
import { defaultSettings } from '@shared/settings';
import './styles/global.css';

// Pick the backend first: the fixture may set the clock (?now=) before anything reads it.
getBackend();
useClock.getState().tick();
applyLook(defaultSettings());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
