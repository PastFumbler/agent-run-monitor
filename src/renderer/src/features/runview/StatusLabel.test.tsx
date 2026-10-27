// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RUN_STATUSES, STATUS_LABELS, type RunStatus } from '@shared/schema';
import { MotionPolicyContext } from '../../motion/context';
import { computeMotionPolicy } from '../../motion/policy';
import { FakeProgress, FAKE_PROGRESS_CAPTION, fakeProgressAllowed } from './FakeProgress';
import { plainStatus, PROBABLY_WAITING, showsSynonyms, StatusLabel } from './StatusLabel';
import { SYNONYMS } from './synonyms';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const isSynonym = (text: string) => SYNONYMS.some((w) => text.includes(w));

describe('synonyms', () => {
  it('has the required words plus at least 12 more', () => {
    for (const w of ['Cogitating', 'Percolating', 'Noodling', 'Wrangling', 'Ruminating', 'Conjuring', 'Tinkering', 'Marinating', 'Pondering', 'Finagling'])
      expect(SYNONYMS).toContain(w);
    expect(SYNONYMS.length).toBeGreaterThanOrEqual(22);
  });

  it('are only ever used for running', () => {
    for (const s of RUN_STATUSES) expect(showsSynonyms(s, true)).toBe(s === 'running');
    expect(showsSynonyms('running', false)).toBe(false);
  });

  it.each(['failed', 'stuck', 'waiting', 'unreadable', 'idle', 'done'] as RunStatus[])('%s shows plain words, never a synonym', (status) => {
    const { container } = render(<StatusLabel runId="x:1" status={status} detail="No activity for 23 min" synonyms />);
    expect(screen.queryByTestId('status-synonym')).toBeNull();
    const word = screen.getByTestId('status-word').textContent ?? '';
    expect(isSynonym(word)).toBe(false);
    expect(word.startsWith(STATUS_LABELS[status].split(' ')[0])).toBe(true);
    expect(isSynonym(container.textContent ?? '')).toBe(false);
  });

  it('running: the rotating words are aria-hidden and the live region says the real status', () => {
    render(<StatusLabel runId="x:2" status="running" synonyms />);
    const syn = screen.getByTestId('status-synonym');
    expect(syn.getAttribute('aria-hidden')).toBe('true');
    expect(isSynonym(syn.textContent ?? '')).toBe(true);
    const live = screen.getByTestId('run-status-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('Status: Running');
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy();
  });

  it('a running run that fails switches to plain words at once', () => {
    const { rerender } = render(<StatusLabel runId="x:3" status="running" synonyms />);
    expect(screen.getByTestId('status-synonym')).toBeTruthy();
    rerender(<StatusLabel runId="x:3" status="failed" detail="API error 529" synonyms />);
    expect(screen.queryByTestId('status-synonym')).toBeNull();
    expect(screen.getByTestId('status-word').textContent).toBe('Failed');
    expect(screen.getByTestId('run-status-live').textContent).toBe('Status: Failed');
  });

  it('under reduced motion the synonym does not rotate', () => {
    vi.useFakeTimers();
    const reduce = computeMotionPolicy({ reduceMotion: 'on', lowGpu: 'off', osReducedMotion: false, power: null, hidden: false });
    render(
      <MotionPolicyContext.Provider value={reduce}>
        <StatusLabel runId="x:4" status="running" synonyms />
      </MotionPolicyContext.Provider>,
    );
    const first = screen.getByTestId('status-synonym').textContent;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId('status-synonym').textContent).toBe(first);
  });
});

describe('totally fake progress bar', () => {
  it('is allowed only for running', () => {
    for (const s of RUN_STATUSES) expect(fakeProgressAllowed(s, true)).toBe(s === 'running');
    expect(fakeProgressAllowed('running', false)).toBe(false);
  });

  it.each(RUN_STATUSES.map((s) => [s]))('renders for %s only if running', (status) => {
    render(<FakeProgress status={status} enabled />);
    const bar = screen.queryByTestId('fake-progress');
    if (status === 'running') {
      expect(bar).not.toBeNull();
      expect(bar!.textContent).toContain(FAKE_PROGRESS_CAPTION);
      expect(bar!.querySelector('[role="presentation"]')!.getAttribute('aria-hidden')).toBe('true');
    } else {
      expect(bar).toBeNull();
    }
  });

  it('unmounts the moment the status changes', () => {
    const { rerender } = render(<FakeProgress status="running" enabled />);
    expect(screen.getByTestId('fake-progress')).toBeTruthy();
    for (const s of ['idle', 'done', 'failed', 'stuck', 'waiting', 'unreadable'] as RunStatus[]) {
      rerender(<FakeProgress status={s} enabled />);
      expect(screen.queryByTestId('fake-progress')).toBeNull();
      rerender(<FakeProgress status="running" enabled />);
    }
  });

  it('quotes an absurdly precise ETA', () => {
    render(<FakeProgress status="running" enabled />);
    expect(screen.getByTestId('fake-progress').textContent).toMatch(/ETA .*\d/);
  });
});

describe('inferred waits', () => {
  it('a wait the files cannot record reads "Probably waiting for you", visibly and in the live region', () => {
    render(<StatusLabel runId="x:5" status="waiting" detail="exec_command may need your approval, or it is still running" inferred synonyms />);
    expect(screen.getByTestId('status-word').textContent).toBe('Probably waiting for you');
    expect(screen.getByTestId('run-status-live').textContent).toBe('Status: Probably waiting for you');
    expect(screen.getByRole('img', { name: 'Probably waiting for you' })).toBeTruthy();
    expect(plainStatus('waiting', undefined, true)).toBe(PROBABLY_WAITING);
  });

  it('a recorded wait, or an inferred flag on another status, keeps the plain words', () => {
    render(<StatusLabel runId="x:6" status="waiting" synonyms />);
    expect(screen.getByTestId('status-word').textContent).toBe('Waiting for you');
    expect(screen.getByTestId('run-status-live').textContent).toBe('Status: Waiting for you');
    cleanup();
    render(<StatusLabel runId="x:7" status="running" inferred synonyms={false} />);
    expect(screen.getByTestId('status-word').textContent).toBe('Running');
    expect(screen.getByTestId('run-status-live').textContent).toBe('Status: Running');
  });
});
