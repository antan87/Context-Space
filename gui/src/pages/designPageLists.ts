/** The kinds of Board card, in the order the Board has them (the overview's first, then the Area's): the design page draws a section for each. */
export const CARD_KINDS = [
  'area', 'areaRow', 'areaMini', 'areaFold', 'checkpoint',
  'lane', 'document', 'commit', 'placeholder', 'uncommitted', 'note', 'file', 'answer', 'step', 'fold', 'more', 'pager',
] as const;
