import { createContext, useContext } from 'react';
import { DEFAULT_POLICY, type MotionPolicy } from './policy';

export const MotionPolicyContext = createContext<MotionPolicy>(DEFAULT_POLICY);

/** The current motion policy. Every animated component (vendored React Bits included) reads this. */
export function useMotionPolicy(): MotionPolicy {
  return useContext(MotionPolicyContext);
}
