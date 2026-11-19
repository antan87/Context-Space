import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The document-level pointer tracker in cardParts.tsx (what counts as a drag-select, and when a stale selection is cleared).
 * There is no DOM here, so a stand-in `document` collects the listeners and the test plays the events through them.
 */

class Fake {
  constructor(private readonly parent: Fake | null = null, readonly board = false) {}
  contains(other: unknown): boolean {
    for (let node = other as Fake | null; node; node = node.parent) if (node === this) return true;
    return false;
  }
  closest(selector: string): Fake | null {
    if (selector === '.react-flow__node' && this.board) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}

async function setup(selectedText: string) {
  vi.resetModules();
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const removeAllRanges = vi.fn();
  const selection = { text: selectedText, anchorNode: null as unknown, focusNode: null as unknown };
  vi.stubGlobal('Element', Fake);
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
  });
  vi.stubGlobal('window', {
    getSelection: () => ({
      get isCollapsed() { return selection.text === ''; },
      toString: () => selection.text,
      anchorNode: selection.anchorNode,
      focusNode: selection.focusNode,
      removeAllRanges,
    }),
  });
  const mod = await import('./cardParts.js');
  const fire = (type: string, e: Record<string, unknown>) => handlers.get(type)?.forEach((fn) => fn(e));
  return { mod, fire, removeAllRanges, selection };
}

/** A still click (or a short move) on `target` while `text` stays selected from before. */
function tap(fire: ReturnType<typeof Object>, target: Fake, pointerType: string, moved: number) {
  const f = fire as unknown as (type: string, e: Record<string, unknown>) => void;
  f('pointerdown', { button: 0, clientX: 10, clientY: 10, target, pointerType });
  f('pointermove', { clientX: 10 + moved, clientY: 10, pointerType });
  f('pointerup', {});
  f('click', { detail: 1, target });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('card pointer tracker', () => {
  it('clears a stale selection on a still click on a Board card', async () => {
    const { fire, removeAllRanges, selection } = await setup('old words');
    const card = new Fake(null, true);
    selection.anchorNode = selection.focusNode = new Fake(card);
    tap(fire, card, 'mouse', 0);
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });

  it('keeps the selection when the click is somewhere else in the app (chat, reader, documents)', async () => {
    const { fire, removeAllRanges, selection } = await setup('old words');
    const elsewhere = new Fake(null, false);
    selection.anchorNode = selection.focusNode = new Fake(elsewhere);
    tap(fire, elsewhere, 'mouse', 0);
    expect(removeAllRanges).not.toHaveBeenCalled();
  });

  it('a touch tap that moves under 10 px is still a press, a mouse move of 8 px is a drag', async () => {
    for (const [pointerType, expected] of [['touch', false], ['mouse', true]] as const) {
      const { mod, fire, selection } = await setup('old words');
      const card = new Fake(null, true);
      selection.anchorNode = selection.focusNode = new Fake(card);
      tap(fire, card, pointerType, 8);
      expect(mod.hasDragSelection(card as unknown as Element, { detail: 1 })).toBe(expected);
    }
  });

  it('a touch that moves 14 px is a drag', async () => {
    const { mod, fire, selection } = await setup('old words');
    const card = new Fake(null, true);
    selection.anchorNode = selection.focusNode = new Fake(card);
    tap(fire, card, 'touch', 14);
    expect(mod.hasDragSelection(card as unknown as Element, { detail: 1 })).toBe(true);
  });
});
