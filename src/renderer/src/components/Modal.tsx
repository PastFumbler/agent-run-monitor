// A small accessible modal: role="dialog", aria-modal, labelled by its title, focus moves in on open
// and back to where it was on close, Tab stays inside, Esc and a click on the backdrop close it.

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  /** Hide the visible heading (the label is still announced). */
  hideTitle?: boolean;
  onClose(): void;
  children: ReactNode;
  className?: string;
  /** Element to focus first (else the first focusable). */
  initialFocus?: () => HTMLElement | null;
  headerExtra?: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({ title, hideTitle, onClose, children, className = '', initialFocus, headerExtra }: ModalProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = initialFocus?.() ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current;
    el?.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab' && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={`dialog ${className}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={hideTitle ? 'sr-only' : 'dialog__head'}>
          <h2 id={`${id}-title`}>{title}</h2>
          {headerExtra}
        </div>
        {children}
      </div>
    </div>
  );
}
