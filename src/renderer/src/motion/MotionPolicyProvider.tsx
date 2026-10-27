// Computes the motion policy from live inputs and shares it:
// - settings.reduceMotion (Auto follows prefers-reduced-motion, live),
// - settings.lowGpu (Auto follows the backend's power state: battery or energy saver),
// - window visibility (document.visibilitychange plus the backend's window signal).
// Side effects: data-reduce-motion / data-low-gpu / data-hidden on <html> (global CSS reacts),
// backend.setUpdateInterval() when the interval changes, and motion's MotionConfig.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { getBackend } from '../backend';
import { useStore } from '../store/store';
import { MotionPolicyContext } from './context';
import { computeMotionPolicy, type MotionPolicy } from './policy';

const QUERY = '(prefers-reduced-motion: reduce)';

function useOsReducedMotion(): boolean {
  const [v, setV] = useState(() => (typeof matchMedia === 'function' ? matchMedia(QUERY).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(QUERY);
    const on = () => setV(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return v;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

export function applyPolicyAttributes(p: MotionPolicy, el: HTMLElement = document.documentElement): void {
  const set = (name: string, on: boolean) => (on ? el.setAttribute(name, '') : el.removeAttribute(name));
  set('data-reduce-motion', p.reduce);
  set('data-low-gpu', p.lowGpu);
  set('data-hidden', p.hidden);
  el.style.setProperty('--motion-duration', `${p.duration}ms`);
}

export function MotionPolicyProvider({ children }: { children: ReactNode }) {
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const lowGpu = useStore((s) => s.settings.lowGpu);
  const power = useStore((s) => s.power);
  const windowVisible = useStore((s) => s.windowVisible);
  const osReducedMotion = useOsReducedMotion();
  const docHidden = useDocumentHidden();

  const policy = useMemo(
    () => computeMotionPolicy({ reduceMotion, lowGpu, osReducedMotion, power, hidden: docHidden || !windowVisible }),
    [reduceMotion, lowGpu, osReducedMotion, power, docHidden, windowVisible],
  );

  useEffect(() => applyPolicyAttributes(policy), [policy]);

  useEffect(() => {
    getBackend().setUpdateInterval(policy.updateIntervalMs);
  }, [policy.updateIntervalMs]);

  return (
    <MotionPolicyContext.Provider value={policy}>
      <MotionConfig
        reducedMotion={policy.animate ? 'never' : 'always'}
        transition={{ duration: policy.duration / 1000 }}
      >
        {children}
      </MotionConfig>
    </MotionPolicyContext.Provider>
  );
}
