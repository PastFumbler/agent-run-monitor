/*
 * LatticeLoader, vendored from React Bits.
 * Source: https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-default/Micro/LatticeLoader/LatticeLoader.tsx
 * (commit e12c22192ac7b4b452c5e2feb9b586d74765d696)
 * Copyright (c) 2026 David Haz
 * Licensed under MIT + Commons Clause (see THIRD_PARTY_NOTICES.md and ../LICENSE.md). This file is not
 * covered by the project's MIT licence and may not be sold, sublicensed or redistributed on its own.
 *
 * Modified for Agent Run Monitor:
 * - Obeys the motion policy: the cell loop runs only when infinite animation is allowed; otherwise the
 *   grid shows a static lit pattern. No glow (box-shadow) unless layered effects are allowed.
 * - Label swaps fade (no blur filter).
 * - The timer ticks once a second from an `elapsed`/`since` value, stops while the window is hidden,
 *   and is off by default; no 100 ms interval.
 * - role="status" and the spoken announcement are opt-in (`live`), so long lists don't flood
 *   screen readers.
 * - Colours default to theme CSS variables.
 * - `still`: the static lit pattern even when the policy allows loops (run-list rows other than the open run).
 */

import React, { useEffect, useState, type CSSProperties } from 'react';
import { useMotionPolicy } from '@renderer/motion/context';
import { nowMs } from '@renderer/backend/clock';

import './LatticeLoader.css';

export type LatticeStatus = 'working' | 'done' | 'error';
export type LatticePatternName = 'arrow' | 'dots' | 'orbit' | 'ripple' | 'snake' | 'spiral' | 'sweep' | 'spin' | 'rain' | 'pulse';
export type LatticeGrid = 3 | 4;

export interface LatticePattern {
  cells: (number | null)[];
  loop?: number;
  scale?: number;
  lit?: 0.25 | 0.35 | 0.45 | 0.62;
}

export interface LatticeLoaderProps {
  label?: string;
  doneLabel?: string;
  errorLabel?: string;
  status?: LatticeStatus;
  pattern?: LatticePatternName | LatticePattern;
  grid?: LatticeGrid;
  shape?: 'square' | 'round';
  color?: string;
  doneColor?: string;
  errorColor?: string;
  cellSize?: number;
  gap?: number;
  fontSize?: number;
  step?: number;
  idleOpacity?: number;
  glow?: boolean;
  glowColor?: string;
  showLabel?: boolean;
  showTimer?: boolean;
  /** Epoch ms the work started; the timer counts from here. */
  since?: number;
  /** Fixed elapsed seconds (wins over `since`). */
  elapsed?: number;
  /** Announce status changes to screen readers (role="status"). Off in lists. */
  live?: boolean;
  /** Show the static lit pattern even when the motion policy allows the loop. */
  still?: boolean;
  className?: string;
  style?: CSSProperties;
}

type ResolvedPattern = { cells: (number | null)[]; loop: number; scale: number; lit?: number };

const PATTERNS: Record<LatticePatternName, Partial<Record<LatticeGrid, ResolvedPattern>>> = {
  arrow: { 3: { cells: [1, 2, 3, 0, 1, 2, 1, 2, 3], loop: 7.2, scale: 1 } },
  dots: { 3: { cells: [0, 1, 2, 0, 1, 2, 0, 1, 2], loop: 3, scale: 2.4 } },
  ripple: { 3: { cells: [2, 1, 2, 1, 0, 1, 2, 1, 2], loop: 4.8, scale: 1.5 } },
  spiral: { 3: { cells: [0, 1, 2, 7, 8, 3, 6, 5, 4], loop: 9, scale: 1.2, lit: 0.35 } },
  orbit: {
    3: { cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1.2 },
    4: { cells: [0, 1, 2, 3, 11, null, null, 4, 10, null, null, 5, 9, 8, 7, 6], loop: 6, scale: 1.2, lit: 0.45 },
  },
  snake: {
    3: { cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: 0.35 },
    4: { cells: [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12], loop: 16, scale: 1, lit: 0.25 },
  },
  sweep: { 4: { cells: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6], loop: 5, scale: 1, lit: 0.45 } },
  spin: { 4: { cells: [0, 0, 1, 1, 0, 0, 1, 1, 3, 3, 2, 2, 3, 3, 2, 2], loop: 4, scale: 1.6, lit: 0.35 } },
  rain: { 4: { cells: [0, 2, 1, 3, 1, 3, 2, 4, 2, 4, 3, 5, 3, 5, 4, 6], loop: 4, scale: 1.2, lit: 0.35 } },
  pulse: { 4: { cells: [2, 1, 1, 2, 1, 0, 0, 1, 1, 0, 0, 1, 2, 1, 1, 2], loop: 2.4, scale: 2.5, lit: 0.45 } },
};
const DEFAULT_PATTERN: Record<LatticeGrid, LatticePatternName> = { 3: 'orbit', 4: 'sweep' };
const MARKS: Record<LatticeGrid, Record<'done' | 'error', number[]>> = {
  3: { done: [2, 3, 5, 7], error: [0, 2, 4, 6, 8] },
  4: { done: [7, 8, 10, 13], error: [0, 3, 5, 6, 9, 10, 12, 15] },
};

const resolvePattern = (pattern: LatticePatternName | LatticePattern, grid: LatticeGrid): ResolvedPattern => {
  if (typeof pattern === 'string') {
    const named = PATTERNS[pattern];
    return (named && named[grid]) || (PATTERNS[DEFAULT_PATTERN[grid]][grid] as ResolvedPattern);
  }
  const cells = Array.from({ length: grid * grid }, (_, i) => pattern.cells[i] ?? null);
  const max = Math.max(0, ...cells.filter((v) => v != null));
  return { cells, loop: pattern.loop ?? max + 4.2, scale: pattern.scale ?? 1, lit: pattern.lit ?? 0.62 };
};
const fmt = (s: number) => (s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`);

const LatticeLoader: React.FC<LatticeLoaderProps> = ({
  label = 'Working',
  doneLabel = 'Done',
  errorLabel = 'Failed',
  status = 'working',
  pattern = 'orbit',
  grid = 3,
  shape = 'round',
  color = 'var(--status-running)',
  doneColor = 'var(--status-done)',
  errorColor = 'var(--status-failed)',
  cellSize = 4,
  gap = 2,
  fontSize = 13,
  step = 90,
  idleOpacity = 0.2,
  glow = false,
  glowColor = '',
  showLabel = true,
  showTimer = false,
  since,
  elapsed,
  live = false,
  still = false,
  className = '',
  style,
}) => {
  const policy = useMotionPolicy();
  const n: LatticeGrid = grid === 4 ? 4 : 3;
  const pat = resolvePattern(pattern, n);
  const marks = MARKS[n];
  const d = step * pat.scale;
  const cycle = Math.round(pat.loop * d);
  const mark = status === 'error' ? 'error' : 'done';
  const animated = status === 'working' && policy.allowInfinite && !still;
  // Static frame: light the cells near the start of the pattern so it still reads as "in motion".
  const staticLit = (unit: number | null) => unit != null && unit <= 1;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!showTimer || elapsed != null || since == null || status !== 'working' || policy.hidden) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [showTimer, elapsed, since, status, policy.hidden]);
  const seconds = elapsed ?? (since != null ? Math.max(0, (nowMs() - since) / 1000) : 0);

  const text = status === 'working' ? label : status === 'done' ? doneLabel : errorLabel;

  return (
    <span
      role={live ? 'status' : undefined}
      className={`lattice-loader${className ? ` ${className}` : ''}`}
      data-status={status}
      data-shape={shape}
      data-animated={animated ? '' : undefined}
      data-glow={glow && policy.allowLayered ? '' : undefined}
      style={
        {
          '--ll-n': n,
          '--ll-cell': `${cellSize}px`,
          '--ll-gap': `${gap}px`,
          '--ll-font': `${fontSize}px`,
          '--ll-color': color,
          '--ll-mark': status === 'error' ? errorColor : doneColor,
          '--ll-idle': idleOpacity,
          '--ll-glow': glowColor || color,
          '--ll-cycle': `${cycle}ms`,
          '--ll-fade': `${policy.duration}ms`,
          ...style,
        } as CSSProperties
      }
    >
      <span className="lattice-loader__grid" aria-hidden="true">
        <span className="lattice-loader__layer lattice-loader__run">
          {pat.cells.map((unit, i) => (
            <span
              key={i}
              className="lattice-loader__cell"
              data-hole={unit == null ? '' : undefined}
              data-on={!animated && staticLit(unit) ? '' : undefined}
              data-lit={pat.lit && pat.lit !== 0.62 ? Math.round(pat.lit * 100) : undefined}
              style={unit == null || !animated ? undefined : { animationDelay: `${Math.round(unit * d)}ms` }}
            />
          ))}
        </span>
        <span className="lattice-loader__layer lattice-loader__mark">
          {pat.cells.map((_, i) => (
            <span key={i} className="lattice-loader__cell" data-on={marks[mark].includes(i) ? '' : undefined} />
          ))}
        </span>
      </span>
      {showLabel ? (
        <span className="lattice-loader__label" aria-hidden={live ? 'true' : undefined}>
          {text}
        </span>
      ) : null}
      {showTimer ? (
        <span className="lattice-loader__timer" aria-hidden="true">
          {fmt(seconds)}
        </span>
      ) : null}
      {live ? <span className="lattice-loader__sr">{`${text}${status === 'working' ? ', in progress' : ''}`}</span> : null}
    </span>
  );
};

export default LatticeLoader;
