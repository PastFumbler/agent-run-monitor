// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RUN_STATUSES, STATUS_LABELS } from '@shared/schema';
import { MotionPolicyContext } from '@renderer/motion/context';
import { computeMotionPolicy } from '@renderer/motion/policy';
import StatusMark, { STATUS_SHAPES } from './StatusMark';

afterEach(cleanup);

describe('StatusMark', () => {
  it('renders a different shape for every status', () => {
    const shapes = new Set<string>();
    const markup = new Set<string>();
    for (const s of RUN_STATUSES) {
      const { container, unmount } = render(<StatusMark status={s} />);
      const root = container.querySelector('.status-mark')!;
      expect(root.getAttribute('data-shape')).toBe(STATUS_SHAPES[s]);
      shapes.add(root.getAttribute('data-shape')!);
      // The drawn geometry differs too, not just a class name.
      const svg = container.querySelector('svg')!;
      const geometry = [...svg.querySelectorAll('circle, path')]
        .map((el) => `${el.tagName}:${el.getAttribute('d') ?? ''}:${el.getAttribute('class')}:${el.getAttribute('stroke-dasharray') ?? ''}`)
        .join('|');
      markup.add(geometry);
      unmount();
    }
    expect(shapes.size).toBe(RUN_STATUSES.length);
    expect(markup.size).toBe(RUN_STATUSES.length);
  });

  it('has an accessible label with the plain status word', () => {
    for (const s of RUN_STATUSES) {
      render(<StatusMark status={s} />);
      expect(screen.getByRole('img', { name: STATUS_LABELS[s] })).toBeTruthy();
      cleanup();
    }
  });

  it('can carry a more specific label, or be decorative next to visible text', () => {
    render(<StatusMark status="stuck" label="Stuck: no activity for 23 min" />);
    expect(screen.getByRole('img', { name: 'Stuck: no activity for 23 min' })).toBeTruthy();
    cleanup();
    const { container } = render(<StatusMark status="failed" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('spins only when the motion policy allows infinite animation', () => {
    const full = computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'off', osReducedMotion: false, power: null, hidden: false });
    const reduce = computeMotionPolicy({ reduceMotion: 'on', lowGpu: 'off', osReducedMotion: false, power: null, hidden: false });
    const low = computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'on', osReducedMotion: false, power: null, hidden: false });
    const hidden = computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'off', osReducedMotion: false, power: null, hidden: true });
    const spins = (p: typeof full) => {
      const { container, unmount } = render(
        <MotionPolicyContext.Provider value={p}>
          <StatusMark status="running" />
        </MotionPolicyContext.Provider>,
      );
      const v = container.querySelector('.status-mark')!.hasAttribute('data-spin');
      unmount();
      return v;
    };
    expect(spins(full)).toBe(true);
    expect(spins(reduce)).toBe(false);
    expect(spins(low)).toBe(false);
    expect(spins(hidden)).toBe(false);
  });

  it('still: never spins, but keeps the running arc shape', () => {
    const full = computeMotionPolicy({ reduceMotion: 'off', lowGpu: 'off', osReducedMotion: false, power: null, hidden: false });
    const { container } = render(
      <MotionPolicyContext.Provider value={full}>
        <StatusMark status="running" still />
      </MotionPolicyContext.Provider>,
    );
    const root = container.querySelector('.status-mark')!;
    expect(root.hasAttribute('data-spin')).toBe(false);
    expect(root.getAttribute('data-shape')).toBe('arc');
    expect(container.querySelector('.status-mark__ring')!.getAttribute('stroke-dasharray')).toBeTruthy();
  });
});
