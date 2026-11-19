import type { ReactNode } from 'react';
import { cn } from '../lib/utils.js';

export type PillTone = 'neutral' | 'accent' | 'ai' | 'needs' | 'done' | 'reopened' | 'warning';

/** The tones of the pill: a quiet fill of the tone's own colour, and its word at 12 px. */
const PILL_TONES: Record<PillTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  accent: 'bg-primary/10 text-primary',
  ai: 'bg-state-ai/12 text-state-ai',
  needs: 'bg-state-needs/12 text-state-needs',
  done: 'bg-state-done/12 text-state-done',
  reopened: 'bg-state-reopened/12 text-state-reopened',
  warning: 'bg-warning/12 text-warning-foreground',
};

export const PILL_BASE = 'inline-flex items-center rounded-sm px-1.5 text-xs font-medium leading-4';

export interface PillProps {
  /** Which colour it carries: the tone's own colours at 12 px. */
  tone?: PillTone;
  /** Put first in the class list, so that a class here reads before the pill's own (`shrink-0`). */
  className?: string;
  children: ReactNode;
}

/** A small label for a state in a word. (The kind of a card is a `KindLabel`.) It is not pressable. */
export function Pill({ tone = 'neutral', className, children }: PillProps) {
  return <span className={cn(className, PILL_BASE, PILL_TONES[tone])}>{children}</span>;
}
