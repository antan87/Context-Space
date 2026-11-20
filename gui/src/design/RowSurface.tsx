import { cn } from '../lib/utils.js';

/**
 * The surfaces of an Area's rows, as class helpers: the Now (or Next up) step with a rule at its left, a quiet step row, and a folded row, in the Hairline look.
 * The caller adds its own layout classes before them.
 */
// Hairline (R1c): a 1 px --border outline, the card surface and a 3 px rule in --state-now as the only colour. The left padding is 13 px (3.25) so the
// text starts at 16 px, where it did behind the old 4 px rule and 12 px padding.
const NOW_SURFACE = 'rounded-card border border-border border-l-3 border-l-state-now bg-card pl-3.25 pr-3';
const QUIET_SURFACE = 'rounded-lg px-1';

export interface RowSurfaceOptions {
  /** The Now or Next up step (the card surface with the 3 px left rule), or a quiet one (plain text on the board). */
  now: boolean;
  /** Classes after the surface, e.g. the hover tint. */
  hover?: string;
}

/** The surface of a step row: the card surface with a 3 px left rule when it is the Now or Next up step, else quiet. */
export function rowSurface({ now, hover }: RowSurfaceOptions): string {
  return cn(now ? NOW_SURFACE : QUIET_SURFACE, hover);
}

/**
 * A folded row (one line holding what the row has): a hairline card (1 px border, `--border-hover` on hover), or the Now surface when it holds the current step.
 * It carries its own text alignment and hover, an opaque mix over the card. `hover: false` draws it with no hover at all (border or fill), for a heading
 * that is not itself pressable.
 */
export function foldSurface(current: boolean, { hover = true }: { hover?: boolean } = {}): string {
  return cn('text-left', current ? NOW_SURFACE : 'rounded-card border border-border bg-card px-3',
    hover && 'hover:bg-row-hover', hover && !current && 'hover:border-border-hover');
}
