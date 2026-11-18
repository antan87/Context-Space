import type { MouseEvent } from 'react';
import { cn } from '../lib/utils.js';

export interface StepCheckProps {
  checked: boolean;
  /** The accessible name: `Mark "…" done` or `Mark "…" not done`. */
  label: string;
  /** The tooltip. The caller decides it (an error text can come before the label). */
  title: string;
  disabled: boolean;
  /** A press is in flight: the box is dimmed, drawn as not allowed, and a second press does nothing. */
  busy: boolean;
  /** Whether the box is drawn with a pointer (never while busy). The callers differ on purpose (one checks read-only, one does not). */
  pressable: boolean;
  testId: string;
  /** Extra classes, drawn first (the Board passes `nodrag nopan` here). */
  className?: string;
  /** The press. The caller keeps its own guards (read-only and the like); the piece only stops the click from reaching the row. */
  onToggle: () => void;
}

/** The step checkbox: a square button with a check inside it, as the Area's rows and the Checkpoint card draw it. */
export function StepCheck({ checked, label, title, disabled, busy, pressable, testId, className, onToggle }: StepCheckProps) {
  return <button
    type="button"
    role="checkbox"
    data-testid={testId}
    aria-checked={checked}
    aria-label={label}
    title={title}
    disabled={disabled}
    onClick={(e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!busy) onToggle();
    }}
    className={cn(
      className,
      'flex size-6 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
      checked
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-muted-foreground/40 bg-background hover:border-primary',
      busy && 'opacity-50 cursor-not-allowed',
      !busy && pressable && 'cursor-pointer'
    )}
  >
    {checked ? (
      <svg className="size-3.5" fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="24">
        <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
      </svg>
    ) : null}
  </button>;
}
