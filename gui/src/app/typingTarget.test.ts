import { describe, expect, it } from 'vitest';

import { isTypingTarget } from './typingTarget.js';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });

describe('isTypingTarget', () => {
  it('is true for text fields, selects, the terminal input and editable text', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'select']) expect(isTypingTarget(el(tag))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('is true inside the custom comboboxes and lists that stand in for a select', () => {
    const inside = (role: string) => el('DIV', { closest: (selector: string) => (selector.includes(`[role="${role}"]`) ? {} : null) });
    for (const role of ['combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton']) expect(isTypingTarget(inside(role))).toBe(true);
  });

  it('is false for buttons, links, the page itself, and anything that is not an element', () => {
    expect(isTypingTarget(el('BUTTON', { closest: () => null }))).toBe(false);
    expect(isTypingTarget(el('A'))).toBe(false);
    expect(isTypingTarget(el('BODY', { closest: () => null }))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget('select')).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});
