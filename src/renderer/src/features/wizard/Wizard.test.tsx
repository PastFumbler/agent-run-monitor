// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('adding a folder that holds no sessions', () => {
  const row = (rescan: () => Promise<SourceStatus[] | null>) =>
    render(
      <ul>
        <AgentRow s={source({ agent: 'claude-code', displayName: 'Claude Code', runCount: 3, confidence: 'verified' })} rescan={rescan} />
      </ul>,
    );

  it('says which folder to pick when the rescan finds no new runs', async () => {
    let calls = 0;
    row(async () => {
      calls++;
      return [source({ agent: 'claude-code', displayName: 'Claude Code', runCount: 3 })];
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder for Claude Code' }));
    const check = await screen.findByText(
      'No Claude Code sessions found in this folder. Pick the folder that contains the .claude folder or its projects folder.',
    );
    expect(check.getAttribute('role')).toBe('status');
    expect(calls).toBe(1);
  });

  it('stays quiet when the new folder brought runs', async () => {
    row(async () => [source({ agent: 'claude-code', displayName: 'Claude Code', runCount: 9 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder for Claude Code' }));
    await waitFor(() => expect(screen.getByTestId('folder-check').textContent).toBe(''));
    expect(useStore.getState().settings.sources['claude-code'].customRoots.length).toBeGreaterThan(0);
  });
});

describe('done step', () => {
  it('while runs are still being read, shows what detection found, with "(still reading…)"', async () => {
    useStore.setState({ runsLoaded: true, order: ['a', 'b'], loadProgress: { parsed: 2, total: 554 } });
    render(<Wizard />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    await waitFor(() => expect(screen.getByTestId('wizard-done-count').textContent).toMatch(/^Watching [\d,]+ runs \(still reading…\)\.$/));
    const n = Number(screen.getByTestId('wizard-done-count').textContent!.replace(/\D/g, ''));
    expect(n).toBeGreaterThanOrEqual(554);
  });
});
