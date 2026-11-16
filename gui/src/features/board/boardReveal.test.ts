import { describe, expect, it } from 'vitest';
import { REVEAL_MARGIN, revealViewport } from './boardReveal.js';
import { OVERVIEW_INSET } from './boardAreas.js';

const stage = { width: 600, height: 400 };
const view = { x: 20, y: 44, zoom: 1 };

describe('revealViewport', () => {
  it('does not move for a card already whole in view', () => {
    expect(revealViewport(view, { x: 0, y: 0, width: 200, height: 100 }, stage)).toBeNull();
    expect(revealViewport(view, { x: 380, y: 250, width: 200, height: 100 }, stage)).toBeNull();
  });

  it('does not move for a card exactly touching the stage edges', () => {
    expect(revealViewport({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, width: 600, height: 400 }, stage)).toBeNull();
  });

  it('moves only y for a card below the stage that is horizontally in view', () => {
    const next = revealViewport(view, { x: 10, y: 500, width: 200, height: 100 }, stage)!;
    expect(next.x).toBe(20);
    expect(next.zoom).toBe(1);
    expect(500 + next.y + 100).toBe(stage.height - REVEAL_MARGIN);
  });

  it('moves only y for a card above the stage', () => {
    const next = revealViewport({ x: 20, y: -300, zoom: 1 }, { x: 10, y: 100, width: 200, height: 100 }, stage)!;
    expect(next.x).toBe(20);
    expect(100 + next.y).toBe(REVEAL_MARGIN);
  });

  it('moves x only when the card is horizontally outside', () => {
    const right = revealViewport(view, { x: 700, y: 10, width: 200, height: 100 }, stage)!;
    expect(right.y).toBe(44);
    expect(700 + right.x + 200).toBe(stage.width - REVEAL_MARGIN);
    const left = revealViewport({ x: -300, y: 44, zoom: 1 }, { x: 100, y: 10, width: 200, height: 100 }, stage)!;
    expect(left.y).toBe(44);
    expect(100 + left.x).toBe(REVEAL_MARGIN);
  });

  it('counts the zoom', () => {
    const next = revealViewport({ x: 0, y: 0, zoom: 0.5 }, { x: 0, y: 1000, width: 200, height: 100 }, stage)!;
    expect(next.zoom).toBe(0.5);
    expect(next.x).toBe(0);
    expect(1000 * 0.5 + next.y + 50).toBe(stage.height - REVEAL_MARGIN);
  });

  it('shows the start of a card larger than the stage', () => {
    const next = revealViewport(view, { x: 0, y: 450, width: 200, height: 900 }, stage)!;
    expect(450 + next.y).toBe(REVEAL_MARGIN);
  });

  it('does nothing with an unmeasured stage', () => {
    expect(revealViewport(view, { x: 0, y: 900, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });

  describe('with the inset at the top of the stage that the pane icons cover', () => {
    const top = OVERVIEW_INSET.top;
    const card = { x: 300, y: 0, width: 200, height: 100 };

    it('treats a card at y=4 as not in view and brings it to the inset, not to y=12', () => {
      const next = revealViewport({ x: 0, y: 4, zoom: 1 }, card, stage, REVEAL_MARGIN, top)!;
      expect(next).not.toBeNull();
      expect(next.y).toBe(top);
      expect(next.x).toBe(0);
    });

    it('moves a card from above the stage to the inset', () => {
      const next = revealViewport({ x: 0, y: -300, zoom: 1 }, { ...card, y: 100 }, stage, REVEAL_MARGIN, top)!;
      expect(100 + next.y).toBe(top);
    });

    it('does not move a card that rests at the inset or lower', () => {
      expect(revealViewport({ x: 0, y: top, zoom: 1 }, card, stage, REVEAL_MARGIN, top)).toBeNull();
      expect(revealViewport({ x: 0, y: top + 30, zoom: 1 }, { ...card, height: 200 }, stage, REVEAL_MARGIN, top)).toBeNull();
    });

    it('still keeps its margin from the bottom edge', () => {
      const next = revealViewport({ x: 0, y: top, zoom: 1 }, { ...card, y: 500 }, stage, REVEAL_MARGIN, top)!;
      expect(500 + next.y + 100).toBe(stage.height - REVEAL_MARGIN);
    });

    it('shows the start of a card when the stage is too short to hold it under the inset', () => {
      const short = { width: 600, height: 100 };
      const next = revealViewport({ x: 0, y: 200, zoom: 1 }, card, short, REVEAL_MARGIN, top)!;
      expect(next.y).toBe(top);
      // A stage that is nothing but inset: the card goes to the stage's edge, never above the inset
      expect(revealViewport({ x: 0, y: 0, zoom: 1 }, card, { width: 600, height: 30 }, REVEAL_MARGIN, top)!.y).toBe(30);
    });
  });
});
