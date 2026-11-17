import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../lib/utils.js';

/** The class of a card that does something when pressed: a pointer, and a tint on hover (see `.board-brick` in index.css). */
export const CARD_BRICK = 'board-brick cursor-pointer';
/** The keyboard on a compact card shows as a ring around the whole card, not around its title. */
export const CARD_FOCUS = 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring';

export interface CardFrameProps {
  labelledBy: string;
  describedBy?: string;
  /** Put away: a dashed border on a muted surface. */
  archived?: boolean;
  /** Kept in view: a primary border (unless archived). */
  pinned?: boolean;
  /** New, or just changed by someone else: a glow for a moment. */
  fresh?: boolean;
  /** Changes when the card does, so that the glow starts again. */
  freshKey?: string | number;
  /** The one open in the reader has a ring. */
  reading?: boolean;
  /** Less padding, and a ring around the whole card for the keyboard. */
  compact?: boolean;
  /** A press anywhere on the card: it is then drawn as pressable. */
  onPress?: (event: MouseEvent<HTMLElement>) => void;
  onDoubleClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Drawn first, before the glow (the Board puts the points its lines end at here). */
  anchors?: ReactNode;
  children: ReactNode;
}

/**
 * The frame every card shares: its surface, padding, radius, border, hover and focus ring, and the states archived, pinned,
 * reading and pressable. It is the card's `<article>` and nothing else wraps it: `index.css` styles `.react-flow__node > article`.
 */
export function CardFrame({ labelledBy, describedBy, archived, pinned, fresh, freshKey, reading = false, compact = false, onPress, onDoubleClick, anchors, children }: CardFrameProps) {
  return <article
    aria-labelledby={labelledBy} aria-describedby={describedBy} aria-current={reading ? 'true' : undefined} onClick={onPress} onDoubleClick={onDoubleClick}
    className={cn('group relative flex h-full w-full flex-col overflow-hidden rounded-xl border px-3.5 shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-border/80', compact ? 'py-2' : 'py-2.5', compact && CARD_FOCUS, onPress && CARD_BRICK,
      archived ? 'border-dashed border-border bg-muted text-muted-foreground' : pinned ? 'border-primary/50 bg-card text-card-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
  >
    {anchors}
    {fresh && <span key={freshKey} aria-hidden="true" className="board-fresh" />}
    {children}
  </article>;
}
