import type { Locator } from '@playwright/test';

/**
 * The readable check: the text on screen under 12 px, once the transforms of its ancestors are applied (the Area draws its
 * cards at a zoom of 0.9, so a 13.5 px label is 12.1 px on screen). Shared by the specs that hold the Board to "no text
 * under 12 px" (board-overview-split) and the design page (design-page).
 */

/** The least size, in screen px, a text may be drawn at. A hair under 12 so a 12 px label that the browser rounds is not a finding. */
export const READABLE_PX = 11.95;

export interface SmallTextOptions {
  /** Leave out text drawn above or below the region's own box (what the overview shows at rest). Off: the whole region, scrolled or not. */
  clipToRegion?: boolean;
}

/**
 * The texts under 12 px on screen anywhere in `region`, as `9.5px "note"` (font size x transforms, then the first 24
 * characters): visible text only (not hidden, not zero-sized, not `.sr-only`).
 */
export async function smallTexts(region: Locator, options: SmallTextOptions = {}): Promise<string[]> {
  return region.evaluate((root, { clipToRegion, readable }) => {
    const box = root.getBoundingClientRect();
    const small: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const el = text.parentElement;
      if (!el || !text.textContent?.trim()) continue;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !r.width || !r.height || el.closest('.sr-only')) continue;
      if (clipToRegion && (r.bottom > box.bottom || r.top < box.top)) continue;
      // offsetWidth rounds fractional font metrics; transforms give the actual drawn scale.
      let scale = 1;
      for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform !== 'none') scale *= new DOMMatrixReadOnly(transform).a;
      }
      const px = parseFloat(style.fontSize) * scale;
      if (px < readable) small.push(`${px.toFixed(1)}px "${text.textContent.trim().slice(0, 24)}"`);
    }
    return small;
  }, { clipToRegion: options.clipToRegion === true, readable: READABLE_PX });
}
