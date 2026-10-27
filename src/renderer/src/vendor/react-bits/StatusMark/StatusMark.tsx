/*
 * StatusMark, vendored from React Bits.
 * Source: https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-default/Micro/StatusMark/StatusMark.tsx
 * (commit e12c22192ac7b4b452c5e2feb9b586d74765d696)
 * Copyright (c) 2026 David Haz
 * Licensed under MIT + Commons Clause (see THIRD_PARTY_NOTICES.md and ../LICENSE.md). This file is not
 * covered by the project's MIT licence and may not be sold, sublicensed or redistributed on its own.
 *
 * Modified for Agent Run Monitor:
 * - Statuses are the app's RunStatus values, each with its own SHAPE so status never depends on colour:
 *   running = spinning ring segment (static 3/4 arc when the motion policy forbids loops),
 *   waiting = pause bars, idle = hollow circle, done = check, failed = cross in an octagon,
 *   stuck = clock with a slash, unreadable = question mark in a dashed circle.
 * - The per-frame motion-value spin is replaced by a CSS rotation of the glyph, enabled only when the
 *   motion policy allows infinite animation; the reduced-motion "breathe" loop is removed.
 * - Colours come from theme CSS variables (--status-*), not hex props.
 * - Accessible name from the app's status words; optional `decorative` when the word is shown next to it.
 */

import React, { useRef, type CSSProperties } from 'react';
import type { RunStatus } from '@shared/schema';
import { STATUS_LABELS } from '@shared/schema';
import { useMotionPolicy } from '@renderer/motion/context';

import './StatusMark.css';

export type StatusMarkStatus = RunStatus;

export interface StatusMarkProps {
  status: StatusMarkStatus;
  /** Spoken label; defaults to the plain status word. */
  label?: string;
  /** Hide from assistive tech when the status word is already shown as text. */
  decorative?: boolean;
  size?: number;
  strokeWidth?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/** The shape name per status (also rendered as data-shape, for tests and CSS). */
export const STATUS_SHAPES: Record<StatusMarkStatus, string> = {
  running: 'arc',
  waiting: 'pause',
  idle: 'ring',
  done: 'check',
  failed: 'octagon-cross',
  stuck: 'clock-slash',
  unreadable: 'dashed-question',
};

const CHECK = 'M7.5 12.25 10.5 15.25 16.75 8.75';
const CROSS = 'M9 9 15 15M15 9 9 15';
const PAUSE = 'M10 8.5v7M14 8.5v7';
const OCTAGON = 'M8.7 3.5h6.6l4.7 4.7v6.6l-4.7 4.7H8.7L4 14.8V8.2Z';
const CLOCK_HANDS = 'M12 7.75V12l2.75 1.75';
const SLASH = 'M5.25 18.75 18.75 5.25';
const QUESTION = 'M9.75 9.6a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.8';
const DOT = 'M12 16.4v.01';

const StatusMark: React.FC<StatusMarkProps> = ({
  status,
  label,
  decorative = false,
  size = 16,
  strokeWidth = 2,
  title,
  className = '',
  style,
}) => {
  const policy = useMotionPolicy();
  const r = 10 - strokeWidth / 2;
  const C = 2 * Math.PI * r;
  const spin = status === 'running' && policy.allowInfinite;
  const spoken = label ?? STATUS_LABELS[status];
  const shape = STATUS_SHAPES[status];
  // Draw the check/cross in only when the status changes while mounted (not on every list mount).
  const firstStatus = useRef(status);
  const draw = status !== firstStatus.current && policy.animate ? ' status-mark__draw' : '';

  let body: React.ReactNode;
  switch (status) {
    case 'running':
      body = (
        <>
          <circle className="status-mark__track" cx="12" cy="12" r={r} />
          <circle
            className="status-mark__ring"
            cx="12"
            cy="12"
            r={r}
            transform="rotate(-90 12 12)"
            strokeDasharray={`${(0.68 * C).toFixed(2)} ${(0.32 * C).toFixed(2)}`}
          />
        </>
      );
      break;
    case 'waiting':
      body = (
        <>
          <circle className="status-mark__ring" cx="12" cy="12" r={r} />
          <path className="status-mark__glyph-path" d={PAUSE} />
        </>
      );
      break;
    case 'idle':
      body = <circle className="status-mark__ring status-mark__ring--hollow" cx="12" cy="12" r={r} />;
      break;
    case 'done':
      body = (
        <>
          <circle className="status-mark__fill" cx="12" cy="12" r={r} />
          <circle className="status-mark__ring" cx="12" cy="12" r={r} />
          <path className={`status-mark__glyph-path${draw}`} d={CHECK} pathLength={1} />
        </>
      );
      break;
    case 'failed':
      body = (
        <>
          <path className="status-mark__fill" d={OCTAGON} />
          <path className="status-mark__ring" d={OCTAGON} />
          <path className={`status-mark__glyph-path${draw}`} d={CROSS} pathLength={1} />
        </>
      );
      break;
    case 'stuck':
      body = (
        <>
          <circle className="status-mark__ring" cx="12" cy="12" r={r} />
          <path className="status-mark__glyph-path" d={CLOCK_HANDS} />
          <path className="status-mark__glyph-path status-mark__slash" d={SLASH} />
        </>
      );
      break;
    case 'unreadable':
    default:
      body = (
        <>
          <circle className="status-mark__ring status-mark__ring--dashed" cx="12" cy="12" r={r} />
          <path className="status-mark__glyph-path" d={QUESTION} />
          <path className="status-mark__glyph-path" d={DOT} />
        </>
      );
  }

  return (
    <span
      className={`status-mark${className ? ` ${className}` : ''}`}
      data-status={status}
      data-shape={shape}
      data-spin={spin ? '' : undefined}
      title={title}
      style={
        {
          '--sm-size': `${size}px`,
          '--sm-stroke': strokeWidth,
          '--sm-draw': `${Math.max(0, policy.duration)}ms`,
          ...style,
        } as CSSProperties
      }
    >
      <svg
        className="status-mark__glyph"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : spoken}
        aria-hidden={decorative || undefined}
        focusable="false"
      >
        {body}
      </svg>
    </span>
  );
};

export default StatusMark;
