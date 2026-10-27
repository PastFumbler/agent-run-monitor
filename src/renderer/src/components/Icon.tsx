import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

/** Decorative icon (aria-hidden). Pair it with visible text or an aria-label on the control. */
export function Icon({ icon, size = 16, strokeWidth = 1.8, className }: { icon: IconSvgElement; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <span className={className} aria-hidden="true" style={{ display: 'inline-flex' }}>
      <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} />
    </span>
  );
}
