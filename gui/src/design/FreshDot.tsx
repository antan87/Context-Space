/** The dot after a title that says "new since you looked", on its own line of a card (block) or inside a title's text (inline). */
export const FRESH_DOT_BLOCK = 'size-1.5 shrink-0 rounded-full bg-primary';
export const FRESH_DOT_INLINE = 'mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle';

export interface FreshDotProps {
  /** `block` sits in a flex row; `inline` sits in the text of a title, in line with it. */
  inline?: boolean;
}

/**
 * The "New since you looked" dot. It is a picture for the eye: its title shows on hover and it is hidden from a screen reader, so a
 * card that wants the words read puts them in an `sr-only` span next to it. (The card's glow, `board-fresh`, is the frame's.)
 */
export function FreshDot({ inline = false }: FreshDotProps) {
  return <span className={inline ? FRESH_DOT_INLINE : FRESH_DOT_BLOCK} title="New since you looked" aria-hidden="true" />;
}
