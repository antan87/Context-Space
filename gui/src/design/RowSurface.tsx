import { cn } from '../lib/utils.js';

/**
 * The surfaces of an Area's rows, as class helpers: the Now (or Next up) step with a rule at its left, a quiet step row, and a folded row.
 * The caller adds its own layout classes before them.
 */
const NOW_SURFACE = 'rounded-xl border border-l-4 border-primary/40 border-l-state-now bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3';
const QUIET_SURFACE = 'rounded-lg px-1';

export interface RowSurfaceOptions {
  /** The Now or Next up step (the tinted surface with the left rule), or a quiet one (plain text on the board). */
  now: boolean;
  /** Classes after the surface, e.g. the hover tint. */
  hover?: string;
}

/** The surface of a step row: tinted with a left rule when it is the Now or Next up step, else quiet. */
export function rowSurface({ now, hover }: RowSurfaceOptions): string {
  return cn(now ? NOW_SURFACE : QUIET_SURFACE, hover);
}

/**
 * A folded row (one line holding what the row has): a bordered quiet card, or the Now surface when it holds the current step. It carries its
 * own text alignment and hover tint, and writes its classes in the order the fold has always had.
 */
export function foldSurface(current: boolean): string {
  return cn('rounded-xl border px-3 text-left hover:bg-accent/30',
    current ? 'border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent border-l-4 border-l-state-now' : 'border-border/60 bg-card/50');
}
