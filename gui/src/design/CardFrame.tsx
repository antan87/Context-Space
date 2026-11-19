import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../lib/utils.js';

/** The class of a card that does something when pressed: a pointer, and a tint on hover (see `.board-brick` in features/board/board.css). */
export const CARD_BRICK = 'board-brick cursor-pointer';
/** The keyboard on a compact card shows as a ring around the whole card, not around its title. */
export const CARD_FOCUS = 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring';

/** The Hairline card's three surfaces. At rest: a 1 px border and no shadow. The border goes to `--border-hover` on hover (pointer devices only), except where it already says something. */
export const CARD_PLAIN = 'border-border bg-card text-card-foreground hover:border-border-hover';
/** Pinned keeps a primary border, on hover too. */
export const CARD_PINNED = 'border-primary/50 bg-card text-card-foreground';
/** Archived: the muted surface and the border at 70 %, the dashed border kept. The text, the focus ring and the reading mark stay at full strength (no opacity on the card). */
export const CARD_ARCHIVED = 'border-dashed border-border/70 bg-muted/70 text-muted-foreground hover:border-border-hover';
/** The open card: a 1 px primary border plus a 1 px inner ring (an outline drawn inside the border, so the keyboard's ring is not touched). */
export const CARD_READING = 'border-primary hover:border-primary outline-1 -outline-offset-2 outline-primary';

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
  /** The one open in the reader has a primary border and an inner ring. */
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
 * reading and pressable. It is the card's `<article>` and nothing else wraps it: `features/board/board.css` styles `.react-flow__node > article`.
 */
export function CardFrame({ labelledBy, describedBy, archived, pinned, fresh, freshKey, reading = false, compact = false, onPress, onDoubleClick, anchors, children }: CardFrameProps) {
  return <article
    aria-labelledby={labelledBy} aria-describedby={describedBy} aria-current={reading ? 'true' : undefined} onClick={onPress} onDoubleClick={onDoubleClick}
    className={cn('group relative flex h-full w-full flex-col overflow-hidden rounded-card border px-3.5 transition-[border-color,box-shadow,translate,background-color] duration-120 ease-out motion-safe:hover:-translate-y-px motion-safe:hover:shadow-card-hover', compact ? 'py-2' : 'py-2.5', compact && CARD_FOCUS, onPress && CARD_BRICK,
      archived ? CARD_ARCHIVED : pinned ? CARD_PINNED : CARD_PLAIN, reading && CARD_READING)}
  >
    {anchors}
    {fresh && <span key={freshKey} aria-hidden="true" className="board-fresh" />}
    {children}
  </article>;
}
