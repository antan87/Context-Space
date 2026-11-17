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
