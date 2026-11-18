import type { ReactNode } from 'react';
import { cn } from '../lib/utils.js';

export type PillTone = 'neutral' | 'accent' | 'ai' | 'needs' | 'done' | 'reopened' | 'warning';

/** Today's kind tag on a card ("commit", "note", "picture"): kept byte for byte until the restyle (R1). */
export const PILL_LEGACY = 'rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground';

/** The tones of the restyled pill: a quiet fill of the tone's own colour, and its word at 12 px. */
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
  /** Which colour it carries. Only the `hairline` look uses it. */
  tone?: PillTone;
  /**
   * `legacy` (the default until the restyle) is today's kind tag exactly, whatever the tone. `hairline` is the target look:
   * the tone's colours at 12 px.
   */
  look?: 'legacy' | 'hairline';
  /** Put first in the class list, so that a class here reads before the pill's own (`shrink-0` on today's tags). */
  className?: string;
  children: ReactNode;
}

/** A small label: the kind of a card ("note", "commit", "picture"), or a state in a word. It is not pressable. */
export function Pill({ tone = 'neutral', look = 'legacy', className, children }: PillProps) {
  return <span className={cn(className, look === 'legacy' ? PILL_LEGACY : [PILL_BASE, PILL_TONES[tone]])}>{children}</span>;
}
