/*
 * AnimatedList, vendored from React Bits (adapted for virtualised lists).
 * Source: https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-default/Components/AnimatedList/AnimatedList.tsx
 * (commit e12c22192ac7b4b452c5e2feb9b586d74765d696)
 * Copyright (c) 2026 David Haz
 * Licensed under MIT + Commons Clause (see THIRD_PARTY_NOTICES.md and ../LICENSE.md). This file is not
 * covered by the project's MIT licence and may not be sold, sublicensed or redistributed on its own.
 *
 * Modified for Agent Run Monitor:
 * - Upstream renders and measures every item and walks all of them on each scroll event, which can't
 *   work with a virtualised list of hundreds of runs. What is kept is its look and its entrance
 *   motion: the "pop" / "slide" / "fade" hidden poses and the spring easing curve, applied per row by
 *   <AnimatedListItem> only to rows that are inserted after the list first rendered (a new run), via
 *   one short Web Animation that ends by itself. Rows scrolled into view never animate.
 * - Obeys the motion policy: no entrance under reduce motion or a hidden window; opacity-only and
 *   shorter under low GPU.
 * - No frame with backdrop-filter, no tile box-shadows, no brightness() filters, no mask-image fades:
 *   tiles use theme surface colours with a hairline border; hover/selected change the background.
 * - No window-level keydown listener (the app's shortcut layer owns the keyboard), no demo items or
 *   icon dependency, colours from theme CSS variables.
 */

import React, { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMotionPolicy } from '@renderer/motion/context';

import './AnimatedList.css';

export type AnimatedListAnimation = 'pop' | 'slide' | 'fade';

const HIDDEN: Record<AnimatedListAnimation, string> = {
  pop: 'translate3d(0, -12px, 0) scale(0.8)',
  slide: 'translate3d(0, -28px, 0) scale(0.98)',
  fade: 'translate3d(0, -4px, 0)',
};

const SPRING =
  'linear(0, 0.0603, 0.2033, 0.3821, 0.5633, 0.7258, 0.8584, 0.9574, 1.0242, 1.0634, 1.0809, 1.0828, 1.0747, 1.0613, 1.046, 1.0313, 1.0186, 1.0085, 1.0012, 0.9965, 0.994, 0.9931, 0.9933, 0.9941, 0.9953, 0.9966, 0.9978, 0.9988, 1)';

export interface AnimatedListItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Play the entrance once on mount (a newly inserted item). */
  entering?: boolean;
  animation?: AnimatedListAnimation;
  selected?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

export const AnimatedListItem = React.forwardRef<HTMLDivElement, AnimatedListItemProps>(function AnimatedListItem(
  { entering = false, animation = 'pop', selected = false, className = '', children, ...rest },
  forwarded,
) {
  const policy = useMotionPolicy();
  const ref = useRef<HTMLDivElement | null>(null);
  const played = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !entering || played.current || !policy.animate || typeof el.animate !== 'function') return;
    played.current = true;
    const frames: Keyframe[] = policy.lowGpu
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: HIDDEN[animation] },
          { opacity: 1, transform: 'none' },
        ];
    // Animate an inner wrapper so the virtualiser's own positioning transform is untouched.
    const target = (el.firstElementChild as HTMLElement | null) ?? el;
    target.animate(frames, {
      duration: policy.lowGpu ? policy.duration : 620,
      easing: policy.lowGpu || !CSS.supports?.('transition-timing-function', 'linear(0, 1)') ? 'ease-out' : SPRING,
      fill: 'none',
    });
  }, [entering, animation, policy.animate, policy.lowGpu, policy.duration]);

  return (
    <div
      {...rest}
      ref={(node) => {
        ref.current = node;
        if (typeof forwarded === 'function') forwarded(node);
        else if (forwarded) forwarded.current = node;
      }}
      className={`animated-list__item${className ? ` ${className}` : ''}`}
      data-selected={selected ? '' : undefined}
    >
      <div className="animated-list__tile">{children}</div>
    </div>
  );
});

export default AnimatedListItem;
