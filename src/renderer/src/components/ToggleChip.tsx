import type { ReactNode } from 'react';

/** A filter chip: a toggle button with aria-pressed, a text label and an optional count. */
export function ToggleChip({
  pressed,
  onToggle,
  label,
  count,
  icon,
  title,
}: {
  pressed: boolean;
  onToggle(): void;
  label: string;
  count?: number;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="chip"
      aria-pressed={pressed}
      onClick={onToggle}
      title={title}
      aria-label={count !== undefined ? `${label}, ${count} run${count === 1 ? '' : 's'}` : label}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined ? <span className="chip__count">{count}</span> : null}
    </button>
  );
}
