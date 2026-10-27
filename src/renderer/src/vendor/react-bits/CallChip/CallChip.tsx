/*
 * CallChip, vendored from React Bits.
 * Source: https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/ts-default/Micro/CallChip/CallChip.tsx
 * (commit e12c22192ac7b4b452c5e2feb9b586d74765d696)
 * Copyright (c) 2026 David Haz
 * Licensed under MIT + Commons Clause (see THIRD_PARTY_NOTICES.md and ../LICENSE.md). This file is not
 * covered by the project's MIT licence and may not be sold, sublicensed or redistributed on its own.
 *
 * Modified for Agent Run Monitor:
 * - Icons for every tool kind (run, edit, read, search, web, agent, other); the error glyph is a cross
 *   (the app is a viewer, so the retry button is removed).
 * - The never-ending requestAnimationFrame timer is replaced by a 1 s interval counted from the tool's
 *   real start (`since`), paused while the window is hidden; finished calls show `durationMs`.
 * - Obeys the motion policy: no shake under reduce or low GPU, no blur on glyph swaps, no clip-path
 *   wipe (opacity fade instead), the progress fill only animates when the policy animates.
 * - role="status" is opt-in (`live`) so long event lists don't flood screen readers; the accessible
 *   sentence is still available as visually hidden text.
 * - Colours from theme CSS variables; a `compact` size for list rows.
 */

import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiNetworkIcon,
  Cancel01Icon,
  CommandLineIcon,
  File02Icon,
  Globe02Icon,
  PencilEdit01Icon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import type { ToolKind } from '@shared/schema';
import { useMotionPolicy } from '@renderer/motion/context';
import { nowMs } from '@renderer/backend/clock';

import './CallChip.css';

export type CallChipStatus = 'idle' | 'running' | 'done' | 'error';

export interface CallChipProps {
  kind?: ToolKind;
  name: string;
  argument?: string;
  status?: CallChipStatus;
  /** Epoch ms the call started (for the running timer). */
  since?: number;
  /** Final duration, for finished calls. */
  durationMs?: number;
  expectedMs?: number;
  compact?: boolean;
  showTimer?: boolean;
  /** Announce status changes (role="status"). Off in lists. */
  live?: boolean;
  className?: string;
  style?: CSSProperties;
}

type Glyph = 'tool' | 'check' | 'cross';

const HOLD_AT = 0.9;
const SHAKE = [0, -1, 1, -0.66, 0.66, -0.33, 0];
const ICONS: Record<ToolKind, typeof CommandLineIcon> = {
  run: CommandLineIcon,
  edit: PencilEdit01Icon,
  read: File02Icon,
  search: Search01Icon,
  web: Globe02Icon,
  agent: AiNetworkIcon,
  other: Wrench01Icon,
};
const WORDS: Record<CallChipStatus, string> = { running: 'running', done: 'done', error: 'failed', idle: 'no result' };

export const formatMs = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
  return `${Math.floor(ms / 86_400_000)} d ${Math.floor((ms % 86_400_000) / 3_600_000)} h`;
};
const glyphOf = (s: CallChipStatus): Glyph => (s === 'done' ? 'check' : s === 'error' ? 'cross' : 'tool');

const CallChip: React.FC<CallChipProps> = ({
  kind = 'other',
  name,
  argument = '',
  status = 'running',
  since,
  durationMs,
  expectedMs = 2500,
  compact = false,
  showTimer = true,
  live = false,
  className = '',
  style,
}) => {
  const policy = useMotionPolicy();
  const rootRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef(false);
  const shakeAnim = useRef<Animation | null>(null);
  const [mounted, setMounted] = useState(false);
  const roll = useRef<{ cur: Glyph; prev: Glyph | null }>({ cur: glyphOf(status), prev: null });
  if (glyphOf(status) !== roll.current.cur) roll.current = { cur: glyphOf(status), prev: roll.current.cur };
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const setFraction = (f: number, instant: boolean) => {
    const fill = fillRef.current;
    if (!fill) return;
    if (instant) fill.style.transition = 'none';
    fill.style.transform = `scaleX(${f})`;
    if (instant) {
      void fill.getBoundingClientRect();
      fill.style.transition = '';
    }
  };
  const apply = (s: CallChipStatus, animateIn: boolean) => {
    const p = policyRef.current;
    if (s === 'running') {
      shakeAnim.current?.cancel();
      setFraction(0, true);
      if (animateIn && p.animate) setFraction(HOLD_AT, false);
      else setFraction(HOLD_AT, true);
    } else if (s === 'done') {
      setFraction(1, !animateIn || !p.animate);
    } else if (s === 'error') {
      setFraction(1, true);
      const el = rootRef.current;
      if (animateIn && p.animate && !p.lowGpu && el && typeof el.animate === 'function') {
        shakeAnim.current = el.animate(
          SHAKE.map((k) => ({ transform: `translateX(${k * 4}px)`, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' })),
          { duration: 450, composite: 'add' },
        );
      }
    } else setFraction(0, true);
  };

  useEffect(() => {
    mountedRef.current = true;
    setMounted(true);
    apply(status, false);
    return () => {
      mountedRef.current = false;
      shakeAnim.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    if (mountedRef.current) apply(status, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // A calm 1 s clock for running calls; nothing at all while hidden.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== 'running' || since == null || !showTimer || policy.hidden) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status, since, showTimer, policy.hidden]);

  const ms = status === 'running' ? (since != null ? Math.max(0, nowMs() - since) : undefined) : durationMs;
  const timerText = ms == null ? '' : formatMs(ms);
  const announce = `${name} ${argument}, ${WORDS[status]}${status !== 'running' && durationMs != null ? ` in ${formatMs(durationMs)}` : ''}`;

  const glyphState = (g: Glyph) => (g === roll.current.cur ? 'in' : g === roll.current.prev ? 'out' : undefined);
  const font = compact ? 12 : 13;
  const iconSize = font + 2;

  return (
    <span
      ref={rootRef}
      role={live ? 'status' : undefined}
      aria-busy={live && status === 'running' ? true : undefined}
      data-status={status}
      data-compact={compact ? '' : undefined}
      data-mounted={mounted ? '' : undefined}
      className={`call-chip${className ? ` ${className}` : ''}`}
      style={
        {
          '--cc-size': compact ? '22px' : '28px',
          '--cc-font': `${font}px`,
          '--cc-pad': compact ? '7px' : '10px',
          '--cc-gap': compact ? '5px' : '7px',
          '--cc-expected': `${expectedMs}ms`,
          '--cc-fade': `${policy.duration}ms`,
          ...style,
        } as CSSProperties
      }
    >
      <span ref={fillRef} className="call-chip__fill" aria-hidden="true" />
      <span className="call-chip__slot" aria-hidden="true">
        <span className="call-chip__glyph" data-state={glyphState('tool')}>
          <HugeiconsIcon icon={ICONS[kind] ?? ICONS.other} size={iconSize} strokeWidth={1.8} />
        </span>
        <span className="call-chip__glyph" data-state={glyphState('check')}>
          <HugeiconsIcon icon={Tick02Icon} size={iconSize} strokeWidth={2.2} />
        </span>
        <span className="call-chip__glyph" data-state={glyphState('cross')}>
          <HugeiconsIcon icon={Cancel01Icon} size={iconSize} strokeWidth={2.2} />
        </span>
      </span>
      <span className="call-chip__name" aria-hidden="true">
        {name}
      </span>
      {argument ? (
        <span className="call-chip__arg" aria-hidden="true">
          {argument}
        </span>
      ) : null}
      {status === 'error' ? (
        <span className="call-chip__state" aria-hidden="true">
          failed
        </span>
      ) : null}
      {showTimer && timerText ? (
        <span className="call-chip__timer" aria-hidden="true">
          {timerText}
        </span>
      ) : null}
      <span className="call-chip__sr">{announce}</span>
    </span>
  );
};

export default CallChip;
