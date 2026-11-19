import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardFrame } from '../../../design/index.js';
import { brickPress, CardText, hasDragSelection } from './cardParts.js';

/**
 * The shared pieces of a card, which moved out of BoardNodes.tsx (DS2b): what a press on a compact card does, and the
 * classes of the card's frame in each state. The golden markup snapshots (cardMarkup.test.tsx) pin the whole cards.
 * There is no DOM in this test setup, so the press is tried with small stand-ins for the elements it asks about.
 */

class FakeElement {
  constructor(
    private readonly parent: FakeElement | null = null,
    private readonly tag = 'div',
  ) {}
  contains(other: unknown): boolean {
    for (let node = other as FakeElement | null; node; node = node.parent) if (node === this) return true;
    return false;
  }
  closest(selector: string): FakeElement | null {
    const tags = selector.split(',').map((part) => part.trim());
    if (tags.includes(this.tag)) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}

/** A card with the main action's button inside it, a press at `target`, and (optionally) some selected text inside the card. */
function press(options: { target: (card: FakeElement) => FakeElement; selected?: boolean; selectionOutside?: boolean }) {
  const card = new FakeElement();
  const main = { click: vi.fn() };
  const find = vi.fn(() => main as unknown as HTMLElement);
  const inside = new FakeElement(card);
  const outside = new FakeElement();
  const node = options.selectionOutside ? outside : inside;
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('window', {
    getSelection: () => ({ isCollapsed: !options.selected, toString: () => (options.selected ? 'some words' : ''), anchorNode: node, focusNode: node }),
  });
  const event = { target: options.target(card), currentTarget: card } as unknown as Parameters<typeof brickPress>[0];
  brickPress(event, find);
  return { main, find };
}

describe('brickPress: a press anywhere on a compact card', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does the main action of the card when the press is on its plain text', () => {
    const { main } = press({ target: (card) => new FakeElement(card, 'span') });
    expect(main.click).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the press ends the selection of some text of the card', () => {
    const { main, find } = press({ target: (card) => new FakeElement(card, 'span'), selected: true });
    expect(find).not.toHaveBeenCalled();
    expect(main.click).not.toHaveBeenCalled();
  });

  it('still acts when the selected text is elsewhere on the page, not on this card', () => {
    const { main } = press({ target: (card) => new FakeElement(card, 'span'), selected: true, selectionOutside: true });
    expect(main.click).toHaveBeenCalledTimes(1);
  });

  it.each(['button', 'a', 'input', 'textarea', 'select'])('leaves a press on a nested %s to that element: the card does not open', (tag) => {
    const { main, find } = press({ target: (card) => new FakeElement(new FakeElement(card, tag), 'span') });
    expect(find).not.toHaveBeenCalled();
    expect(main.click).not.toHaveBeenCalled();
  });

  it('ignores a press that bubbled up from outside the card (a dialog the card opened)', () => {
    const { main, find } = press({ target: () => new FakeElement(null, 'span') });
    expect(find).not.toHaveBeenCalled();
    expect(main.click).not.toHaveBeenCalled();
  });

  it('does not block keyboard/synthetic activations (detail === 0) even when text inside is selected', () => {
    const card = new FakeElement();
    const inside = new FakeElement(card);
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('window', {
      getSelection: () => ({ isCollapsed: false, toString: () => 'selected words', anchorNode: inside, focusNode: inside }),
    });
    expect(hasDragSelection(card, { detail: 0 })).toBe(false);
    expect(hasDragSelection(card, { detail: 1 })).toBe(true);
  });

  it('still detects a selection that starts inside the card and ends outside it', () => {
    const card = new FakeElement();
    const inside = new FakeElement(card);
    const outside = new FakeElement();
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('window', {
      getSelection: () => ({ isCollapsed: false, toString: () => 'partial words', anchorNode: inside, focusNode: outside }),
    });
    expect(hasDragSelection(card, { detail: 1 })).toBe(true);
  });
});

describe('CardFrame: the classes of each state', () => {
  const BASE = 'group relative flex h-full w-full flex-col overflow-hidden rounded-xl border px-3.5 shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-border/80';
  const FOCUS = 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring';
  const BRICK = 'board-brick cursor-pointer';
  const PLAIN = 'border-border bg-card text-card-foreground';
  const PINNED = 'border-primary/50 bg-card text-card-foreground';
  const ARCHIVED = 'border-dashed border-border bg-muted text-muted-foreground';

  const render = (props: Partial<Parameters<typeof CardFrame>[0]> = {}) =>
    renderToStaticMarkup(createElement(CardFrame, { labelledBy: 't', ...props }, createElement('span', null, 'inside')));
  const classOf = (html: string) => /<article[^>]*? class="([^"]*)"/.exec(html)?.[1];

  it('is the article itself, with nothing wrapped around it', () => {
    const html = render();
    expect(html.startsWith('<article ')).toBe(true);
    expect(html.endsWith('</article>')).toBe(true);
    expect(html).toContain('aria-labelledby="t"');
  });

  it('draws a plain, full card', () => {
    expect(classOf(render())).toBe(`${BASE} py-2.5 ${PLAIN}`);
  });

  it('draws a compact card with a ring around the whole card for the keyboard', () => {
    expect(classOf(render({ compact: true }))).toBe(`${BASE} py-2 ${FOCUS} ${PLAIN}`);
  });

  it('draws a pressable card as a brick', () => {
    expect(classOf(render({ onPress: () => {} }))).toBe(`${BASE} py-2.5 ${BRICK} ${PLAIN}`);
  });

  it('draws pinned, archived (which wins over pinned) and reading', () => {
    expect(classOf(render({ pinned: true }))).toBe(`${BASE} py-2.5 ${PINNED}`);
    expect(classOf(render({ archived: true }))).toBe(`${BASE} py-2.5 ${ARCHIVED}`);
    expect(classOf(render({ archived: true, pinned: true }))).toBe(`${BASE} py-2.5 ${ARCHIVED}`);
    expect(classOf(render({ reading: true }))).toBe(`${BASE} py-2.5 ${PLAIN} ring-2 ring-primary`);
  });

  it('marks the card open in the reader, and describes it by what it is told to', () => {
    const html = render({ reading: true, describedBy: 'd' });
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-describedby="d"');
    expect(render()).not.toContain('aria-current');
  });

  it('puts the anchors first, then the glow of a fresh card, then the content', () => {
    const html = render({ fresh: true, freshKey: 'x', anchors: createElement('i', { 'data-anchors': '' }) });
    expect(html).toMatch(/<i data-anchors=""><\/i><span aria-hidden="true" class="board-fresh"><\/span><span>inside<\/span>/);
    expect(render()).not.toContain('board-fresh');
  });

  it('marks CardText with nodrag and select-text so card bodies select without dragging', () => {
    const html = renderToStaticMarkup(createElement(CardText, { text: 'Hello **card** body.', cut: false }));
    expect(html).toMatch(/class="[^"]*\bnodrag\b[^"]*\bselect-text\b[^"]*"/);
  });
});
