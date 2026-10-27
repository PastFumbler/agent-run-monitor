// Bottom bar: run counts by status, power / low-GPU state, and the shortcuts link.

import { BatteryLowIcon, KeyboardIcon, Leaf01Icon } from '@hugeicons/core-free-icons';
import { RUN_STATUSES, type RunStatus, type RunSummary } from '@shared/schema';
import { Icon } from '../../components/Icon';
import { SHORT_LABELS } from '../../components/StatusBadge';
import { useMotionPolicy } from '../../motion/context';
import { useStore } from '../../store/store';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';

export function StatusBar({ all }: { all: RunSummary[] }) {
  const policy = useMotionPolicy();
  const power = useStore((s) => s.power);
  const lowGpuSetting = useStore((s) => s.settings.lowGpu);
  const setOverlay = useStore((s) => s.setOverlay);
  const progress = useStore((s) => s.loadProgress);
  const counts = {} as Record<RunStatus, number>;
  for (const r of all) counts[r.status] = (counts[r.status] ?? 0) + 1;

  let powerText = '';
  if (policy.lowGpu) {
    const why = lowGpuSetting === 'on' ? 'on' : power?.onBattery ? 'on battery' : power?.powerSaver ? 'energy saver' : 'on';
    powerText = `Low-GPU mode (${why})`;
  } else if (power?.onBattery) powerText = 'On battery';

  return (
    <footer className="statusbar" aria-label="Status bar">
      <div className="statusbar__counts" aria-label="Runs by status">
        <span className="statusbar__count">
          <b>{all.length}</b> runs
        </span>
        {RUN_STATUSES.filter((s) => counts[s]).map((s) => (
          <span key={s} className="statusbar__count" data-testid={`count-${s}`}>
            <StatusMark status={s} size={12} decorative still />
            <b>{counts[s]}</b> {SHORT_LABELS[s].toLowerCase()}
          </span>
        ))}
      </div>
      {progress ? (
        <span role="status" data-testid="load-progress">
          Reading runs… {progress.parsed.toLocaleString()} of {progress.total.toLocaleString()}
        </span>
      ) : null}
      <span className="statusbar__spacer" />
      {powerText ? (
        <span className="statusbar__power" data-testid="power-indicator">
          <Icon icon={policy.lowGpu ? Leaf01Icon : BatteryLowIcon} size={13} />
          {powerText}
        </span>
      ) : null}
      {policy.reduce ? <span>Reduced motion</span> : null}
      <button type="button" className="btn btn--ghost" onClick={() => setOverlay('cheatsheet')}>
        <Icon icon={KeyboardIcon} size={13} />
        Shortcuts (?)
      </button>
    </footer>
  );
}
