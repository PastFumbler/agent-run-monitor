// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SourceStatus } from '@shared/schema';
import { resetStore, useStore } from '../../store/store';
import { AgentRow, Wizard } from './Wizard';

afterEach(() => {
  cleanup();
  resetStore();
});

const source = (o: Partial<SourceStatus>): SourceStatus => ({
  agent: 'cursor',
  displayName: 'Cursor',
  enabled: true,
  defaultRoots: [{ path: '/home/u/.config/Cursor/User/globalStorage', exists: false }],
  customRoots: [],
  runCount: 0,
  note: '',
  confidence: 'best-effort',
  ...o,
});

describe('wizard detection rows', () => {
  it('a missing agent says where it would be, stays on, and says nothing is there yet', () => {
    render(
      <ul>
        <AgentRow s={source({})} />
      </ul>,
    );
    const row = document.querySelector('.wiz-source')!;
    expect(row.getAttribute('data-found')).toBe('no');
    expect(row.textContent).toContain('It would be at /home/u/.config/Cursor/User/globalStorage');
    expect(row.textContent).toContain('Nothing there yet');
    expect(row.textContent).toContain('Not there');
    expect(screen.getByRole('switch', { name: 'Watch Cursor' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Add a folder for Cursor' })).toBeTruthy();
    expect(row.textContent).toContain('Experimental');
  });

  it('a found agent shows its path and run count', () => {
    render(
      <ul>
        <AgentRow s={source({ agent: 'codex', displayName: 'Codex', defaultRoots: [{ path: '/home/u/.codex', exists: true }], runCount: 7, confidence: 'source' })} />
      </ul>,
    );
    const row = document.querySelector('.wiz-source')!;
    expect(row.getAttribute('data-found')).toBe('yes');
    expect(row.textContent).toContain('/home/u/.codex');
    expect(row.textContent).toContain('7 runs');
    expect(row.textContent).toContain('Found');
  });
});

describe('wizard shell', () => {
  it('starts on the welcome step with a labelled progress indicator', () => {
    render(<Wizard />);
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome to Agent Run Monitor' })).toBeTruthy();
    const steps = screen.getByRole('list', { name: 'Setup steps' });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('Welcome');
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeTruthy();
  });

  it('with zero runs the last step explains what to do', () => {
    useStore.setState({ runsLoaded: true });
    render(<Wizard />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(screen.getByText(/Start a session in any supported agent and it appears here within seconds/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start watching' })).toBeTruthy();
  });
});
