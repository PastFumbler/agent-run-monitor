/*
 * ThoughtLine, vendored from React Bits.
 * Source: https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-default/Micro/ThoughtLine/ThoughtLine.tsx
 * (commit e12c22192ac7b4b452c5e2feb9b586d74765d696)
 * Copyright (c) 2026 David Haz
 * Licensed under MIT + Commons Clause (see THIRD_PARTY_NOTICES.md and ../LICENSE.md). This file is not
 * covered by the project's MIT licence and may not be sold, sublicensed or redistributed on its own.
 *
 * Modified for Agent Run Monitor:
 * - Obeys the motion policy: the breathing glyph, the shimmer and the step pulse only run while
 *   infinite animation is allowed (never under reduce motion, low GPU or a hidden window); otherwise
 *   the glyph is static. The label swap fades without blur. Collapse is instant unless animating.
 * - No 100 ms timer and no ResizeObserver: the caller passes `elapsed` (from the run's timestamps).
 * - The head button gets a visible :focus-visible outline; role="status" is opt-in (`live`).
 * - Steps wrap long text instead of overflowing; colours from theme variables.
 */

import React, { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { animate, type AnimationPlaybackControls } from 'motion/react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, SparklesIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useMotionPolicy } from '@renderer/motion/context';

import './ThoughtLine.css';

export interface ThoughtLineProps {
  label?: string;
  doneLabel?: string;
  steps?: string[];
  collapsible?: boolean;
  /** Start expanded (defaults to `working`). */
  defaultOpen?: boolean;
  fontSize?: number;
  working?: boolean;
  /** Seconds spent thinking, when known. */
  elapsed?: number;
  live?: boolean;
  /** Accessible name for the expand button, e.g. "Reasoning step 12". */
  toggleLabel?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];
const EMPTY_STEPS: string[] = [];

const fmt = (s: number) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`);

const ThoughtLine: React.FC<ThoughtLineProps> = ({
  label = 'Thinking…',
  doneLabel = 'Thought',
  steps = EMPTY_STEPS,
  collapsible = true,
  defaultOpen,
  fontSize = 14,
  working = false,
  elapsed,
  live = false,
  toggleLabel,
  className = '',
  style,
}) => {
  const policy = useMotionPolicy();
  const [open, setOpen] = useState(defaultOpen ?? working);
  const hasTrace = steps.length > 0;
  const breathing = working && policy.allowInfinite;
  const shimmer = breathing;
  const glyphRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (working) setOpen(true);
  }, [working]);

  useEffect(() => {
    const el = glyphRef.current;
    if (!el) return undefined;
    let ctl: AnimationPlaybackControls | null = null;
    if (breathing) {
      ctl = animate(el, { opacity: [0.55, 1, 0.55] }, { duration: 1.6, ease: EASE_IN_OUT, repeat: Infinity });
    } else {
      el.style.opacity = working ? '1' : '0.6';
    }
    return () => ctl?.stop();
  }, [breathing, working]);

  const toggle = hasTrace && collapsible;
  const text = working ? label : doneLabel;

  const head = (
    <>
      <span ref={glyphRef} className="thought-line__glyph" aria-hidden="true">
        <HugeiconsIcon icon={SparklesIcon} size="100%" strokeWidth={2} />
      </span>
      <span className="thought-line__label">
        <span className="thought-line__text" data-shimmer={shimmer ? '' : undefined}>
          {text}
        </span>
      </span>
      {elapsed != null ? (
        <span className="thought-line__timer" aria-hidden="true">
          {fmt(elapsed)}
        </span>
      ) : null}
      {toggle ? (
        <span className="thought-line__chevron" data-on="" aria-hidden="true">
          <HugeiconsIcon icon={ArrowDown01Icon} size="1em" strokeWidth={2.2} />
        </span>
      ) : null}
      {live ? (
        <span className="thought-line__sr" role="status">
          {text}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={`thought-line${className ? ` ${className}` : ''}`}
      data-working={working ? '' : undefined}
      data-open={open && hasTrace ? '' : undefined}
      style={
        {
          '--tl-font': `${fontSize}px`,
          '--tl-settle': `${policy.duration}ms`,
          ...style,
        } as CSSProperties
      }
    >
      {toggle ? (
        <button
          type="button"
          className="thought-line__head"
          data-toggle=""
          aria-expanded={open}
          aria-label={toggleLabel ? `${toggleLabel}: ${open ? 'collapse' : 'expand'}` : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          {head}
        </button>
      ) : (
        <div className="thought-line__head">{head}</div>
      )}
      {hasTrace ? (
        <div className="thought-line__trace" data-open={open ? '' : undefined} hidden={!open}>
          <div className="thought-line__steps">
            {steps.map((stepText, i) => {
              const done = !working || i < steps.length - 1;
              return (
                <div key={`${i}-${stepText.slice(0, 24)}`} className="thought-line__step" data-done={done ? '' : undefined}>
                  <span className="thought-line__mark" aria-hidden="true">
                    {done ? (
                      <HugeiconsIcon icon={Tick02Icon} size="1em" strokeWidth={2.5} />
                    ) : (
                      <i className="thought-line__pulse" data-animated={breathing ? '' : undefined} />
                    )}
                  </span>
                  <span className="thought-line__step-text">{stepText}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ThoughtLine;
