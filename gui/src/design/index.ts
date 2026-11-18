/**
 * The one entry point of the design module (see ./README.md).
 *
 * Screens import UI controls only from here (`design/index.js`). Today this
 * re-exports the controls that live in `components/ui`; the files stay where
 * they are. New pieces (CardFrame, Pill, ...) are added here as they land.
 */
export * from '../components/ui/index.js';
export * from '../components/ui/icon-button.js';
export * from '../components/ui/context-ring.js';
// The Board card's frame. `components/ui/card.tsx` has an unrelated, unused `CardFrame` (a plain div); naming the
// export here makes this one win over that one in `export *`, so nobody who imports `CardFrame` from the design module gets it.
export { CardFrame, CARD_BRICK, CARD_FOCUS, type CardFrameProps } from './CardFrame.js';
// The small pieces the cards share: a kind tag, the you/AI mark, and the "new since you looked" dot.
export { Pill, PILL_LEGACY, type PillProps, type PillTone } from './Pill.js';
export { Mark, type MarkProps } from './Mark.js';
export { FreshDot, type FreshDotProps } from './FreshDot.js';
// The step checkbox of the Area's rows and the Checkpoint card, and the Now/Next step surface of the rows (DS5b).
export { StepCheck, type StepCheckProps } from './StepCheck.js';
export { rowSurface, foldSurface, type RowSurfaceOptions } from './RowSurface.js';
// The multi-line text field of the Board's writing surfaces (DS6); the note dialog's body is its first user.
export { Composer, type ComposerProps } from './Composer.js';
