import { describe, expect, it } from 'vitest';
import { editorThemeName, isAppDark } from './editorTheme.js';

const root = (...classes: string[]) => ({ classList: { contains: (name: string) => classes.includes(name) } }) as unknown as HTMLElement;

describe('editor theme', () => {
  it('is light unless the page has the dark class, whatever data-theme says (the app only ever sets the class)', () => {
    expect(isAppDark(root())).toBe(false);
    expect(isAppDark(root('dark'))).toBe(true);
    expect(editorThemeName(true)).toBe('vs-dark');
    expect(editorThemeName(false)).toBe('vs');
  });
});
