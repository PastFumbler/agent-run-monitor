// The totally fake progress bar (settings.fakeProgress). Shown ONLY while a run is running: callers
// mount it with `status === 'running'` and it also refuses to render for any other status, so a
// status change unmounts it at once. It lurches forward, sometimes slides back, and quotes an
// absurdly precise ETA. Striped, dashed and captioned so it can't be mistaken for real progress.
// The bar is presentation only (aria-hidden); the caption is plain visible text.

import { useEffect, useRef, useState } from 'react';
import type { RunStatus } from '@shared/schema';
import { useMotionPolicy } from '../../motion/context';

const ETAS = [
  () => `ETA ${rint(1, 9)} min ${rint(0, 59)}.${digits(4)} s`,
  () => `ETA 3 min 14.1592 s`,
  () => `ETA 0.0001 s (trust me)`,
  () => `ETA 11 min 2.718 s`,
  () => `ETA ${rint(2, 40)}.${digits(6)} s`,
  () => `ETA 42 min 0.0000 s, give or take a decade`,
  () => `ETA 1.618 golden seconds`,
  () => `ETA ${rint(1, 3)} h ${rint(0, 59)} min ${rint(0, 59)}.${digits(2)} s`,
  () => `ETA -0.5 s (already done, probably)`,
  () => `ETA 6.0221 × 10²³ ns`,
];

function rint(a: number, b: number) {
  return a + Math.floor(Math.random() * (b - a + 1));
}
function digits(n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export const FAKE_PROGRESS_CAPTION = 'totally fake progress bar';

/** True only for running runs. Exported for tests. */
export function fakeProgressAllowed(status: RunStatus, enabled: boolean): boolean {
  return enabled && status === 'running';
}

export function FakeProgress({ status, enabled }: { status: RunStatus; enabled: boolean }) {
  if (!fakeProgressAllowed(status, enabled)) return null;
  return <FakeProgressBar />;
}

function FakeProgressBar() {
  const policy = useMotionPolicy();
  const [progress, setProgress] = useState(() => 0.08 + Math.random() * 0.2);
  const [eta, setEta] = useState(() => ETAS[0]());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (policy.hidden) return undefined;
    let alive = true;
    const lurch = () => {
      if (!alive) return;
      setProgress((p) => {
        if (p > 0.96) return 0.55 + Math.random() * 0.2; // "recalculating"
        if (Math.random() < 0.18) return Math.max(0.03, p - (0.05 + Math.random() * 0.15)); // slides back
        return Math.min(0.99, p + 0.02 + Math.random() * 0.13);
      });
      timers.current.push(setTimeout(lurch, (policy.reduce ? 3000 : 1100) + Math.random() * 1800));
    };
    const newEta = () => {
      if (!alive) return;
      setEta(ETAS[Math.floor(Math.random() * ETAS.length)]());
      timers.current.push(setTimeout(newEta, 2800 + Math.random() * 2400));
    };
    timers.current.push(setTimeout(lurch, 900), setTimeout(newEta, 2500));
    return () => {
      alive = false;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [policy.hidden, policy.reduce]);

  return (
    <div className="fake-progress" data-testid="fake-progress">
      <div className="fake-progress__track" role="presentation" aria-hidden="true">
        <div className="fake-progress__bar" style={{ transform: `scaleX(${progress.toFixed(3)})` }} />
      </div>
      <span className="fake-progress__eta" aria-hidden="true">
        {eta}
      </span>
      <span className="fake-progress__caption">{FAKE_PROGRESS_CAPTION}</span>
    </div>
  );
}
