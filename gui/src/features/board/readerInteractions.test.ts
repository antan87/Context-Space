import { describe, expect, it, vi } from 'vitest';
import * as interaction from './readerInteractions.js';

// Only the DOM methods the ownership/copy boundary needs. Browser cases verify real selection text.
function element(tagName = 'DIV', inside = true, ui: object | null = null, code = false) {
  return { nodeType: 1, tagName, isContentEditable: false, closest: (selector: string) => selector === '[data-line-note-ui]' ? ui : code && selector.includes('data-code-window') ? {} : null, inside };
}
const body = element('BODY', false);
const root = { contains: (el: { inside?: boolean }) => el.inside === true } as unknown as HTMLElement;
const owned = (target: unknown, focused = target) => interaction.readerOwnsKey(root, target as EventTarget, focused as Element, body as unknown as HTMLElement);
describe('reader key ownership', () => {
  it.each(['TEXTAREA', 'INPUT', 'SELECT'])('leaves Escape to a focused %s, even inside the reader', tag => {
    expect(owned(element(tag))).toBe(false);
  });
  it('leaves terminal and Code-window events alone, even with body focus', () => {
    expect(owned(element('TEXTAREA', false), body)).toBe(false);
    expect(owned(element('DIV', true, null, true))).toBe(false);
  });
  it('owns reader buttons and the body fallback, but not outside buttons', () => {
    expect(owned(element('BUTTON'))).toBe(true);
    expect(owned(body)).toBe(true);
    expect(owned(element('BUTTON', false))).toBe(false);
  });
});
describe('reader copy boundary', () => {
  const ui = {};
  function copy(markdown: boolean, startUI: object | null, endUI: object | null) {
    const removed = vi.fn();
    const fragment = { querySelectorAll: () => [{ remove: removed }], textContent: 'source only' } as unknown as DocumentFragment;
    const start = element('SPAN', true, startUI); const end = element('SPAN', true, endUI);
    const range = { startContainer: start, endContainer: end, cloneContents: () => fragment };
    const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range } as unknown as Selection;
    const rendered = vi.fn(() => 'First paragraph.\n\nNext paragraph.');
    const result = interaction.readerCopyText(root, selection, markdown, rendered);
    return { removed, rendered, result };
  }
  it('excludes an intervening note from rendered Markdown and retains rendered paragraph breaks', () => {
    const { removed, rendered, result } = copy(true, null, null);
    expect(removed).toHaveBeenCalledOnce(); expect(rendered).toHaveBeenCalledOnce();
    expect(result).toBe('First paragraph.\n\nNext paragraph.');
  });
  it('leaves a deliberate selection inside one note native', () => {
    const { removed, result } = copy(true, ui, ui);
    expect(removed).not.toHaveBeenCalled(); expect(result).toBeNull();
  });
  it('filters a selection starting in a note and ending in the document', () => {
    expect(copy(true, ui, null).result).toBe('First paragraph.\n\nNext paragraph.');
  });
  it('preserves exact source whitespace for plain text', () => {
    const { result, rendered } = copy(false, null, null);
    expect(result).toBe('source only'); expect(rendered).not.toHaveBeenCalled();
  });
});

describe('native text of a filtered Markdown fragment', () => {
  function browserCopy(fail = false) {
    const anchor = { name: 'original end' }; const focus = { name: 'original start' };
    const copy = {
      append: vi.fn(), querySelectorAll: () => [], style: {} as CSSStyleDeclaration, setAttribute: vi.fn(), remove: vi.fn(),
      innerText: 'First paragraph.\n\nHeading\n\nNext paragraph.',
    };
    const fragment = { cloneNode: () => ({}) } as unknown as DocumentFragment;
    const range = { cloneRange: () => range, setStart: vi.fn(), setEnd: vi.fn() };
    const selected = {
      anchorNode: anchor, anchorOffset: 7, focusNode: focus, focusOffset: 2, rangeCount: 1,
      getRangeAt: () => range, removeAllRanges: vi.fn(), addRange: vi.fn(), setBaseAndExtent: vi.fn(),
      toString: vi.fn(() => { if (fail) throw new Error('native copy failed'); return 'First paragraph.\n\nHeading\nNext paragraph.'; }),
    };
    const nodes = [{ length: 5 }, { length: 15 }]; let i = 0;
    const focused = { isConnected: true, focus: vi.fn() };
    vi.stubGlobal('window', { getSelection: () => selected });
    vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
    vi.stubGlobal('document', { createElement: () => copy, createRange: () => range, createTreeWalker: () => ({ nextNode: () => nodes[i++] ?? null }), activeElement: focused, body: { append: vi.fn() } });
    return { copy, selected, fragment, anchor, focus };
  }
  it('uses native selection breaks after a heading, keeping the original backwards selection', () => {
    const { copy, selected, fragment, anchor, focus } = browserCopy();
    try {
      expect(interaction.renderedFragmentText(fragment)).toBe('First paragraph.\n\nHeading\nNext paragraph.');
      expect(selected.toString).toHaveBeenCalledOnce();
      expect(selected.setBaseAndExtent).toHaveBeenCalledWith(anchor, 7, focus, 2);
      expect(copy.remove).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  it('restores selection and removes the clone even when native text extraction fails', () => {
    const { copy, selected, fragment, anchor, focus } = browserCopy(true);
    try {
      expect(() => interaction.renderedFragmentText(fragment)).toThrow('native copy failed');
      expect(selected.setBaseAndExtent).toHaveBeenCalledWith(anchor, 7, focus, 2);
      expect(copy.remove).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
